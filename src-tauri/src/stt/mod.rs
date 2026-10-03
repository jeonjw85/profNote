use std::ffi::{CStr, c_void};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::AppError;
use crate::sidecar::ffmpeg::TARGET_SAMPLE_RATE;

pub const SUPPORTED_MODELS: &[&str] = &["medium", "large-v3", "large-v3-turbo"];

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const KO_INITIAL_PROMPT: &str = "한국어 대학 강의 전사록입니다. 교수님이 전공 개념과 이론을 설명하고, 과제와 시험 일정을 안내합니다.";
const DOWNLOAD_CHUNK_BYTES: usize = 256 * 1024;
const PROGRESS_EVENT_BYTES: u64 = 256 * 1024;
const MAX_REDIRECTS: u32 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub installed: bool,
    pub size_bytes: u64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DownloadEvent {
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Done {
        path: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SttEvent {
    Loading,
    Started,
    Progress { percent: u32 },
    Segments { segments: Vec<TranscriptSegment> },
    Finished,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub segments: Vec<TranscriptSegment>,
    pub text: String,
    pub language: String,
}

pub struct SttState {
    context: Option<WhisperContext>,
    loaded_model: Option<PathBuf>,
}

struct SttCallbackProgress {
    last_percent: i32,
    last_segment: i32,
}

struct SttCallbacks {
    channel: Channel<SttEvent>,
    progress: Mutex<SttCallbackProgress>,
}

unsafe extern "C" fn stt_progress_callback(
    _: *mut whisper_rs::whisper_rs_sys::whisper_context,
    _: *mut whisper_rs::whisper_rs_sys::whisper_state,
    percent: i32,
    user_data: *mut c_void,
) {
    // The owner keeps userdata alive until synchronous full() returns.
    let Some(callbacks) = (unsafe { user_data.cast::<SttCallbacks>().as_ref() }) else {
        return;
    };
    let Ok(mut progress) = callbacks.progress.lock() else {
        return;
    };
    let percent = percent.clamp(0, 100);
    if percent != progress.last_percent {
        progress.last_percent = percent;
        let _ = callbacks.channel.send(SttEvent::Progress {
            percent: percent as u32,
        });
    }
}

unsafe extern "C" fn stt_segment_callback(
    _: *mut whisper_rs::whisper_rs_sys::whisper_context,
    state: *mut whisper_rs::whisper_rs_sys::whisper_state,
    n_new: i32,
    user_data: *mut c_void,
) {
    if state.is_null() || n_new <= 0 {
        return;
    }
    // Whisper owns state and its segment strings for the callback; userdata stays owned by transcribe.
    let Some(callbacks) = (unsafe { user_data.cast::<SttCallbacks>().as_ref() }) else {
        return;
    };
    let Ok(mut progress) = callbacks.progress.lock() else {
        return;
    };
    // The callback reads completed segments without mutating Whisper state.
    let segments = unsafe {
        let count = whisper_rs::whisper_rs_sys::whisper_full_n_segments_from_state(state);
        let start = count.saturating_sub(n_new).max(0);
        let mut segments = Vec::new();
        for index in start..count {
            if index <= progress.last_segment {
                continue;
            }
            progress.last_segment = index;
            let raw =
                whisper_rs::whisper_rs_sys::whisper_full_get_segment_text_from_state(state, index);
            if raw.is_null() {
                continue;
            }
            let Ok(text) = CStr::from_ptr(raw).to_str() else {
                continue;
            };
            let start =
                whisper_rs::whisper_rs_sys::whisper_full_get_segment_t0_from_state(state, index);
            let end =
                whisper_rs::whisper_rs_sys::whisper_full_get_segment_t1_from_state(state, index);
            if let Some(segment) = transcript_segment(start, end, text) {
                segments.push(segment);
            }
        }
        segments
    };
    if !segments.is_empty() {
        let _ = callbacks.channel.send(SttEvent::Segments { segments });
    }
}

impl SttState {
    pub fn new() -> Self {
        SttState {
            context: None,
            loaded_model: None,
        }
    }
}

pub fn model_path(models_dir: &Path, name: &str) -> Result<PathBuf, AppError> {
    if !SUPPORTED_MODELS.contains(&name) {
        return Err(AppError::InvalidInput(format!("unsupported model: {name}")));
    }
    Ok(models_dir.join(format!("ggml-{name}.bin")))
}

pub fn model_status(models_dir: &Path, name: &str) -> Result<ModelStatus, AppError> {
    let path = model_path(models_dir, name)?;
    let (installed, size_bytes) = match std::fs::metadata(&path) {
        Ok(metadata) if metadata.len() > 0 => (true, metadata.len()),
        _ => (false, 0),
    };
    Ok(ModelStatus {
        installed,
        size_bytes,
        path: path.to_string_lossy().into_owned(),
    })
}

pub fn download_model(
    models_dir: &Path,
    name: &str,
    on_event: &Channel<DownloadEvent>,
) -> Result<PathBuf, AppError> {
    let destination = model_path(models_dir, name)?;
    std::fs::create_dir_all(models_dir)?;
    let partial = models_dir.join(format!("ggml-{name}.bin.part"));

    let response = fetch_following_redirects(&model_url(name)?)?;
    let total_bytes = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| known_model_size(name));

    let _ = on_event.send(DownloadEvent::Progress {
        downloaded_bytes: 0,
        total_bytes,
    });

    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(&partial)?;
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;
    let mut buffer = vec![0u8; DOWNLOAD_CHUNK_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| AppError::Download(e.to_string()))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
        downloaded += read as u64;
        let finished = total_bytes.is_some_and(|total| downloaded == total);
        if downloaded - last_reported >= PROGRESS_EVENT_BYTES || finished {
            last_reported = downloaded;
            let _ = on_event.send(DownloadEvent::Progress {
                downloaded_bytes: downloaded,
                total_bytes,
            });
        }
    }
    file.flush()?;
    drop(file);
    if let Some(total) = total_bytes
        && downloaded != total
    {
        std::fs::remove_file(&partial).ok();
        return Err(AppError::Download(format!(
            "incomplete download: {downloaded} of {total} bytes"
        )));
    }
    std::fs::rename(&partial, &destination)?;
    let _ = on_event.send(DownloadEvent::Done {
        path: destination.to_string_lossy().into_owned(),
    });
    Ok(destination)
}

fn model_url(name: &str) -> Result<String, AppError> {
    model_path(Path::new(""), name)?;
    Ok(format!("{MODEL_BASE_URL}/ggml-{name}.bin"))
}

fn known_model_size(name: &str) -> Option<u64> {
    match name {
        "medium" => Some(1_532_833_792),
        "large-v3" => Some(2_955_219_968),
        "large-v3-turbo" => Some(1_622_809_600),
        _ => None,
    }
}

fn fetch_following_redirects(url: &str) -> Result<ureq::http::Response<ureq::Body>, AppError> {
    let mut current_url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let response = ureq::get(&current_url)
            .call()
            .map_err(|e| AppError::Download(e.to_string()))?;
        let status = response.status();
        if !status.is_redirection() {
            if !status.is_success() {
                return Err(AppError::Download(format!(
                    "model server returned HTTP {}",
                    status.as_u16()
                )));
            }
            return Ok(response);
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| AppError::Download("redirect without location header".into()))?;
        if !location.starts_with("http://") && !location.starts_with("https://") {
            return Err(AppError::Download(format!(
                "unsupported relative redirect: {location}"
            )));
        }
        current_url = location.to_string();
    }
    Err(AppError::Download(
        "too many redirects while downloading model".into(),
    ))
}

fn detect_language_name(state: &whisper_rs::WhisperState) -> Option<String> {
    let language_id = state.full_lang_id_from_state();
    let raw = unsafe { whisper_rs::whisper_rs_sys::whisper_lang_str(language_id) };
    if raw.is_null() {
        return None;
    }
    let name = unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy();
    if name.is_empty() {
        None
    } else {
        Some(name.into_owned())
    }
}

fn read_wav_16k_mono(path: &Path) -> Result<Vec<f32>, AppError> {
    let reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.sample_rate != TARGET_SAMPLE_RATE || spec.channels != 1 {
        return Err(AppError::Transcription(format!(
            "expected {TARGET_SAMPLE_RATE}Hz mono wav, found {}Hz {}ch",
            spec.sample_rate, spec.channels
        )));
    }
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(AppError::Transcription(format!(
            "expected 16-bit integer wav, found {:?} with {} bits per sample",
            spec.sample_format, spec.bits_per_sample
        )));
    }
    let samples = reader
        .into_samples::<i16>()
        .map(|sample| sample.map(|value| f32::from(value) / 32768.0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(samples)
}

fn load_context(state: &mut SttState, model: &Path) -> Result<(), AppError> {
    if state.context.is_some() && state.loaded_model.as_deref() == Some(model) {
        return Ok(());
    }
    let mut context_params = WhisperContextParameters::default();
    context_params.use_gpu(true);
    context_params.flash_attn(true);
    let context = WhisperContext::new_with_params(model, context_params)
        .map_err(|e| AppError::Model(e.to_string()))?;
    state.context = Some(context);
    state.loaded_model = Some(model.to_path_buf());
    Ok(())
}

pub fn transcribe(
    state: &mut SttState,
    model: &Path,
    wav: &Path,
    language: &str,
    on_event: &Channel<SttEvent>,
) -> Result<Transcript, AppError> {
    let _ = on_event.send(SttEvent::Loading);
    let samples = read_wav_16k_mono(wav)?;
    load_context(state, model)?;
    let context = state
        .context
        .as_ref()
        .ok_or_else(|| AppError::Transcription("model context not loaded".into()))?;
    let mut whisper_state = context
        .create_state()
        .map_err(|e| AppError::Transcription(e.to_string()))?;

    let detect_language = language == "auto";
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    if detect_language {
        params.set_language(None);
    } else {
        params.set_language(Some(language));
    }
    if language == "ko" {
        params.set_initial_prompt(KO_INITIAL_PROMPT);
    }
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_translate(false);

    let callbacks = Box::new(SttCallbacks {
        channel: on_event.clone(),
        progress: Mutex::new(SttCallbackProgress {
            last_percent: -1,
            last_segment: -1,
        }),
    });
    let callback_data = std::ptr::from_ref(callbacks.as_ref())
        .cast_mut()
        .cast::<c_void>();
    // Box owns a stable, synchronized callback address throughout synchronous full().
    unsafe {
        params.set_progress_callback(Some(stt_progress_callback));
        params.set_progress_callback_user_data(callback_data);
        params.set_new_segment_callback(Some(stt_segment_callback));
        params.set_new_segment_callback_user_data(callback_data);
    }

    let _ = on_event.send(SttEvent::Started);
    whisper_state
        .full(params, &samples)
        .map_err(|e| AppError::Transcription(e.to_string()))?;
    drop(callbacks);

    let segment_count = whisper_state.full_n_segments();
    let mut segments = Vec::new();
    let mut text = String::new();
    for index in 0..segment_count {
        let segment = whisper_state
            .get_segment(index)
            .ok_or_else(|| AppError::Transcription(format!("segment {index} out of range")))?;
        let segment_text = segment
            .to_str()
            .map_err(|e| AppError::Transcription(e.to_string()))?;
        let Some(segment) = transcript_segment(
            segment.start_timestamp(),
            segment.end_timestamp(),
            segment_text,
        ) else {
            continue;
        };
        text.push_str(&segment.text);
        text.push('\n');
        segments.push(segment);
    }

    let resolved_language = if detect_language {
        detect_language_name(&whisper_state).unwrap_or_else(|| language.to_string())
    } else {
        language.to_string()
    };

    let _ = on_event.send(SttEvent::Finished);
    Ok(Transcript {
        segments,
        text,
        language: resolved_language,
    })
}

fn transcript_segment(start: i64, end: i64, text: &str) -> Option<TranscriptSegment> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(TranscriptSegment {
        start_ms: (start.max(0) as u64).saturating_mul(10),
        end_ms: (end.max(0) as u64).saturating_mul(10),
        text: text.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        DownloadEvent, SUPPORTED_MODELS, SttCallbackProgress, SttCallbacks, SttEvent, model_path,
        model_url, stt_progress_callback, transcript_segment,
    };
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::{Arc, Mutex, mpsc};
    use tauri::ipc::Channel;

    #[test]
    fn turbo_model_is_supported_and_maps_to_expected_file() {
        assert!(SUPPORTED_MODELS.contains(&"large-v3-turbo"));
        let path = model_path(Path::new("/models"), "large-v3-turbo")
            .expect("turbo model should be accepted");
        assert_eq!(path, Path::new("/models/ggml-large-v3-turbo.bin"));
        assert_eq!(
            model_url("large-v3-turbo").expect("turbo url"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
        );
    }

    #[test]
    fn unsupported_model_is_rejected() {
        assert!(model_path(Path::new("/models"), "tiny").is_err());
        assert!(model_url("tiny").is_err());
    }

    #[test]
    fn download_progress_event_matches_frontend_schema() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&DownloadEvent::Progress {
            downloaded_bytes: 1024,
            total_bytes: Some(2048),
        })?;
        assert_eq!(
            json,
            r#"{"type":"progress","downloadedBytes":1024,"totalBytes":2048}"#
        );
        Ok(())
    }

    #[test]
    fn download_done_event_matches_frontend_schema() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&DownloadEvent::Done {
            path: "/tmp/model.bin".into(),
        })?;
        assert_eq!(json, r#"{"type":"done","path":"/tmp/model.bin"}"#);
        Ok(())
    }

    #[test]
    fn stt_progress_event_matches_frontend_schema() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&SttEvent::Progress { percent: 42 })?;
        assert_eq!(json, r#"{"type":"progress","percent":42}"#);
        Ok(())
    }

    #[test]
    fn streamed_segments_use_final_transcript_normalization() -> Result<(), serde_json::Error> {
        let segment = transcript_segment(-1, 125, "  강의 내용입니다. \n");
        assert!(segment.is_some());
        let json = serde_json::to_string(&SttEvent::Segments {
            segments: segment.into_iter().collect(),
        })?;
        assert_eq!(
            json,
            r#"{"type":"segments","segments":[{"startMs":0,"endMs":1250,"text":"강의 내용입니다."}]}"#
        );
        Ok(())
    }

    #[test]
    fn empty_segments_are_not_streamed_or_saved() {
        assert!(transcript_segment(0, 100, " \n\t ").is_none());
    }

    #[test]
    fn raw_progress_callback_deduplicates_and_releases_channel() -> Result<(), serde_json::Error> {
        let lease = Arc::new(());
        let weak_lease = Arc::downgrade(&lease);
        let (sender, receiver) = mpsc::channel();
        let channel = Channel::new(move |body| {
            let _ = &lease;
            let _ = sender.send(body);
            Ok(())
        });
        let callbacks = Box::new(SttCallbacks {
            channel,
            progress: Mutex::new(SttCallbackProgress {
                last_percent: -1,
                last_segment: -1,
            }),
        });
        let callback_data = std::ptr::from_ref(callbacks.as_ref())
            .cast_mut()
            .cast::<c_void>();
        for percent in [-4, 0, 40, 40, 101, 100] {
            // The test owns valid callback userdata; progress never reads Whisper pointers.
            unsafe {
                stt_progress_callback(
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    percent,
                    callback_data,
                );
            }
        }
        let events = receiver
            .try_iter()
            .map(|body| body.deserialize::<serde_json::Value>())
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(
            events,
            vec![
                serde_json::json!({ "type": "progress", "percent": 0 }),
                serde_json::json!({ "type": "progress", "percent": 40 }),
                serde_json::json!({ "type": "progress", "percent": 100 }),
            ]
        );
        assert!(weak_lease.upgrade().is_some());
        drop(callbacks);
        assert!(weak_lease.upgrade().is_none());
        Ok(())
    }
}
