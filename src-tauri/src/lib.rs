mod audio;
mod db;
mod error;
mod llm;
mod sidecar;
mod stt;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use error::AppError;

pub struct AppState {
    recording: Mutex<Option<audio::ActiveRecording>>,
    stt: Arc<Mutex<stt::SttState>>,
    data_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStarted {
    started_at_ms: u64,
    sample_rate: u32,
    channels: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStopped {
    wav_path: String,
    duration_ms: u64,
}

fn lock_recording<'a>(
    state: &'a State<'_, AppState>,
) -> Result<MutexGuard<'a, Option<audio::ActiveRecording>>, AppError> {
    state
        .recording
        .lock()
        .map_err(|_| AppError::Recording("recorder state lock poisoned".into()))
}

#[tauri::command]
async fn start_recording(state: State<'_, AppState>) -> Result<RecordingStarted, AppError> {
    {
        let recording = lock_recording(&state)?;
        if recording.is_some() {
            return Err(AppError::Recording(
                "a recording is already in progress".into(),
            ));
        }
    }
    let recordings_dir = state.data_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir)?;
    let active = tauri::async_runtime::spawn_blocking(move || {
        audio::ActiveRecording::start(&recordings_dir)
    })
    .await
    .map_err(|error| AppError::Recording(error.to_string()))??;
    let started = RecordingStarted {
        started_at_ms: active.started_at_ms,
        sample_rate: active.sample_rate,
        channels: active.channels,
    };
    *lock_recording(&state)? = Some(active);
    Ok(started)
}

#[tauri::command]
async fn stop_recording(state: State<'_, AppState>) -> Result<RecordingStopped, AppError> {
    let active = lock_recording(&state)?
        .take()
        .ok_or_else(|| AppError::Recording("no active recording".into()))?;
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pcm = active.stop()?;
        let wav_path = pcm.path.with_extension("wav");
        if let Err(error) = sidecar::ffmpeg::pcm_to_wav16k_mono(&data_dir, &pcm, &wav_path) {
            std::fs::remove_file(&wav_path).ok();
            return Err(AppError::Recording(format!(
                "{error}; raw audio kept at {} for recovery",
                pcm.path.display()
            )));
        }
        std::fs::remove_file(&pcm.path)?;
        Ok(RecordingStopped {
            wav_path: wav_path.to_string_lossy().into_owned(),
            duration_ms: pcm.duration_ms,
        })
    })
    .await
    .map_err(|error| AppError::Recording(error.to_string()))?
}

#[tauri::command]
async fn import_audio(
    state: State<'_, AppState>,
    source_path: String,
) -> Result<RecordingStopped, AppError> {
    let source = PathBuf::from(&source_path);
    audio::validate_import_source(&source)?;
    let recordings_dir = state.data_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir)?;
    let wav_path = audio::next_recording_wav_path(&recordings_dir)?;
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = sidecar::ffmpeg::file_to_wav16k_mono(&data_dir, &source, &wav_path) {
            std::fs::remove_file(&wav_path).ok();
            return Err(error);
        }
        let duration_ms = audio::wav_duration_ms(&wav_path)?;
        Ok(RecordingStopped {
            wav_path: wav_path.to_string_lossy().into_owned(),
            duration_ms,
        })
    })
    .await
    .map_err(|error| AppError::Recording(error.to_string()))?
}

#[tauri::command]
async fn transcribe_audio(
    state: State<'_, AppState>,
    wav_path: String,
    model: String,
    language: String,
    on_event: Channel<stt::SttEvent>,
) -> Result<stt::Transcript, AppError> {
    let wav = PathBuf::from(&wav_path);
    if !wav.exists() {
        return Err(AppError::InvalidInput(format!(
            "wav file not found: {wav_path}"
        )));
    }
    let model_file = stt::model_path(&state.data_dir.join("models"), &model)?;
    if !model_file.exists() {
        return Err(AppError::Model(format!(
            "model '{model}' is not downloaded yet"
        )));
    }
    let stt = Arc::clone(&state.stt);
    tauri::async_runtime::spawn_blocking(move || {
        let mut stt_state = stt
            .lock()
            .map_err(|_| AppError::Transcription("stt state lock poisoned".into()))?;
        stt::transcribe(&mut stt_state, &model_file, &wav, &language, &on_event)
    })
    .await
    .map_err(|error| AppError::Transcription(error.to_string()))?
}

#[tauri::command]
async fn download_model(
    state: State<'_, AppState>,
    model: String,
    on_event: Channel<stt::DownloadEvent>,
) -> Result<(), AppError> {
    let models_dir = state.data_dir.join("models");
    tauri::async_runtime::spawn_blocking(move || {
        stt::download_model(&models_dir, &model, &on_event)
    })
    .await
    .map_err(|error| AppError::Download(error.to_string()))??;
    Ok(())
}

#[tauri::command]
fn get_model_status(
    state: State<'_, AppState>,
    model: String,
) -> Result<stt::ModelStatus, AppError> {
    stt::model_status(&state.data_dir.join("models"), &model)
}

#[tauri::command]
fn get_ffmpeg_status(state: State<'_, AppState>) -> sidecar::ffmpeg::FfmpegStatus {
    sidecar::ffmpeg::status(&state.data_dir)
}

#[tauri::command]
async fn download_ffmpeg(
    state: State<'_, AppState>,
    on_event: Channel<sidecar::ffmpeg::FfmpegDownloadEvent>,
) -> Result<(), AppError> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        sidecar::ffmpeg_setup::download_ffmpeg(&data_dir, &on_event)
    })
    .await
    .map_err(|error| AppError::Download(error.to_string()))??;
    Ok(())
}

#[tauri::command]
fn get_diarizer_status(state: State<'_, AppState>) -> sidecar::diarizer::DiarizerStatus {
    sidecar::diarizer::status(&state.data_dir)
}

#[tauri::command]
fn prepare_diarizer(
    state: State<'_, AppState>,
    force: bool,
    on_event: Channel<sidecar::diarizer::DiarizerPrepareEvent>,
) -> Result<(), AppError> {
    sidecar::diarizer::prepare(&state.data_dir, &on_event, force)
}

#[tauri::command]
async fn run_diarization(
    state: State<'_, AppState>,
    wav_path: String,
    hf_token: Option<String>,
) -> Result<Vec<sidecar::diarizer::SpeakerSegment>, AppError> {
    let wav = PathBuf::from(&wav_path);
    if !wav.exists() {
        return Err(AppError::InvalidInput(format!(
            "wav file not found: {wav_path}"
        )));
    }
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        sidecar::diarizer::run_diarization(&data_dir, &wav, hf_token.as_deref())
    })
    .await
    .map_err(|error| AppError::Diarization(error.to_string()))?
}

#[tauri::command]
fn stream_llm_chat(
    url: String,
    api_key: String,
    model: String,
    system_prompt: String,
    user_content: String,
    on_delta: Channel<String>,
) -> Result<(), AppError> {
    llm::stream_chat(
        &url,
        &api_key,
        &model,
        &system_prompt,
        &user_content,
        &on_delta,
    )
}

#[tauri::command]
fn write_markdown(
    state: State<'_, AppState>,
    filename: String,
    content: String,
) -> Result<String, AppError> {
    if filename.is_empty()
        || filename.len() > 80
        || filename
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(AppError::InvalidInput(
            "filename must be ASCII alphanumeric with '-' or '_' only".into(),
        ));
    }
    let notes_dir = state.data_dir.join("notes");
    std::fs::create_dir_all(&notes_dir)?;
    let path = notes_dir.join(format!("{filename}.md"));
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_audio(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let target = PathBuf::from(&path);
    let recordings_dir = state.data_dir.join("recordings");
    if target.parent() != Some(recordings_dir.as_path()) {
        return Err(AppError::InvalidInput(
            "audio path must be inside the recordings directory".into(),
        ));
    }
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = db::register(tauri::Builder::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| Box::new(std::io::Error::other(e.to_string())))?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState {
                recording: Mutex::new(None),
                stt: Arc::new(Mutex::new(stt::SttState::new())),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            import_audio,
            transcribe_audio,
            download_model,
            get_model_status,
            get_ffmpeg_status,
            download_ffmpeg,
            get_diarizer_status,
            prepare_diarizer,
            run_diarization,
            stream_llm_chat,
            write_markdown,
            delete_audio,
        ]);
    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("profnote terminated with error: {error}");
        std::process::exit(1);
    }
}
