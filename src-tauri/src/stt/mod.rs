use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Channel;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::AppError;
use crate::sidecar::ffmpeg::TARGET_SAMPLE_RATE;

pub const SUPPORTED_MODELS: &[&str] = &["medium", "large-v3"];

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const DOWNLOAD_CHUNK_BYTES: usize = 256 * 1024;
const PROGRESS_EVENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REDIRECTS: u32 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub installed: bool,
    pub size_bytes: u64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SttEvent {
    Started,
    Progress { percent: u32 },
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
        return Err(AppError::InvalidInput(format!(
            "unsupported model: {name}"
        )));
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
        .and_then(|value| value.parse::<u64>().ok());

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
    Err(AppError::Download("too many redirects while downloading model".into()))
}

fn detect_language_name(state: &whisper_rs::WhisperState) -> Option<String> {
    let (language_id, _) = state.lang_detect(0, 4).ok()?;
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
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|sample| f32::from(sample) / 32768.0)
        .collect();
    Ok(samples)
}

fn load_context(state: &mut SttState, model: &Path) -> Result<(), AppError> {
    if state.context.is_some() && state.loaded_model.as_deref() == Some(model) {
        return Ok(());
    }
    let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
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
        params.set_detect_language(true);
    } else {
        params.set_language(Some(language));
    }
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_translate(false);

    let event_channel = on_event.clone();
    let mut last_percent: i32 = -1;
    params.set_progress_callback_safe(move |percent| {
        if percent != last_percent {
            last_percent = percent;
            let _ = event_channel.send(SttEvent::Progress {
                percent: percent.max(0) as u32,
            });
        }
    });

    let _ = on_event.send(SttEvent::Started);
    whisper_state
        .full(params, &samples)
        .map_err(|e| AppError::Transcription(e.to_string()))?;

    let segment_count = whisper_state.full_n_segments();
    let mut segments = Vec::new();
    let mut text = String::new();
    for index in 0..segment_count {
        let segment = whisper_state
            .get_segment(index)
            .ok_or_else(|| AppError::Transcription(format!("segment {index} out of range")))?;
        let segment_text = segment
            .to_str()
            .map_err(|e| AppError::Transcription(e.to_string()))?
            .trim()
            .to_string();
        if segment_text.is_empty() {
            continue;
        }
        let start = segment.start_timestamp();
        let end = segment.end_timestamp();
        segments.push(TranscriptSegment {
            start_ms: (start.max(0) * 10) as u64,
            end_ms: (end.max(0) * 10) as u64,
            text: segment_text.clone(),
        });
        text.push_str(&segment_text);
        text.push('\n');
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

#[cfg(test)]
mod tests {
    use super::{DownloadEvent, SttEvent};

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
}
