mod audio;
mod db;
mod error;
mod llm;
mod sidecar;
mod stt;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use error::AppError;

pub struct AppState {
    recording: Mutex<Option<audio::ActiveRecording>>,
    stt: Mutex<stt::SttState>,
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

fn lock_stt<'a>(
    state: &'a State<'_, AppState>,
) -> Result<MutexGuard<'a, stt::SttState>, AppError> {
    state
        .stt
        .lock()
        .map_err(|_| AppError::Transcription("stt state lock poisoned".into()))
}

#[tauri::command]
fn start_recording(state: State<'_, AppState>) -> Result<RecordingStarted, AppError> {
    let mut recording = lock_recording(&state)?;
    if recording.is_some() {
        return Err(AppError::Recording(
            "a recording is already in progress".into(),
        ));
    }
    let recordings_dir = state.data_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir)?;
    let active = audio::ActiveRecording::start(&recordings_dir)?;
    let started = RecordingStarted {
        started_at_ms: active.started_at_ms,
        sample_rate: active.sample_rate,
        channels: active.channels,
    };
    *recording = Some(active);
    Ok(started)
}

#[tauri::command]
fn stop_recording(state: State<'_, AppState>) -> Result<RecordingStopped, AppError> {
    let active = lock_recording(&state)?
        .take()
        .ok_or_else(|| AppError::Recording("no active recording".into()))?;
    let pcm = active.stop()?;
    let wav_path = pcm.path.with_extension("wav");
    if let Err(error) = sidecar::ffmpeg::pcm_to_wav16k_mono(&pcm, &wav_path) {
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
}

#[tauri::command]
fn transcribe_audio(
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
    let mut stt_state = lock_stt(&state)?;
    stt::transcribe(&mut stt_state, &model_file, &wav, &language, &on_event)
}

#[tauri::command]
fn download_model(
    state: State<'_, AppState>,
    model: String,
    on_event: Channel<stt::DownloadEvent>,
) -> Result<(), AppError> {
    stt::download_model(&state.data_dir.join("models"), &model, &on_event)?;
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
fn get_diarizer_status(
    state: State<'_, AppState>,
) -> sidecar::diarizer::DiarizerStatus {
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
fn run_diarization(
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
    sidecar::diarizer::run_diarization(&state.data_dir, &wav, hf_token.as_deref())
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
                stt: Mutex::new(stt::SttState::new()),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            transcribe_audio,
            download_model,
            get_model_status,
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
