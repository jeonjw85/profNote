use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::AppError;

use super::diarize_setup::{
    diarize_dir, engine_marker, ensure_engine, uv_binary, venv_python,
};

const DIARIZE_PY: &str = include_str!("../../../scripts/diarize.py");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizerStatus {
    pub ready: bool,
    pub uv_installed: bool,
    pub engine_installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DiarizerPrepareEvent {
    Stage { name: String },
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Done,
}

#[derive(Debug, Deserialize)]
struct ScriptOutput {
    segments: Vec<RawSegment>,
}

#[derive(Debug, Deserialize)]
struct RawSegment {
    start: f64,
    end: f64,
    speaker: String,
}

pub fn status(data_dir: &Path) -> DiarizerStatus {
    let uv_installed = uv_binary(data_dir).is_file();
    let engine_installed = engine_marker(data_dir).is_file() && venv_python(data_dir).is_file();
    DiarizerStatus {
        ready: uv_installed && engine_installed,
        uv_installed,
        engine_installed,
    }
}

pub fn prepare(
    data_dir: &Path,
    on_event: &Channel<DiarizerPrepareEvent>,
    force: bool,
) -> Result<(), AppError> {
    write_script(data_dir)?;
    if force {
        std::fs::remove_file(engine_marker(data_dir)).ok();
        std::fs::remove_dir_all(diarize_dir(data_dir).join("venv")).ok();
    }
    ensure_engine(data_dir, on_event)
}

pub fn run_diarization(
    data_dir: &Path,
    wav: &Path,
    huggingface_token: Option<&str>,
) -> Result<Vec<SpeakerSegment>, AppError> {
    write_script(data_dir)?;
    let python = venv_python(data_dir);
    if !python.is_file() {
        return Err(AppError::Diarization(
            "diarizer engine is not installed".into(),
        ));
    }
    let script = diarize_dir(data_dir).join("diarize.py");
    let hf_home = diarize_dir(data_dir).join("hf");
    std::fs::create_dir_all(&hf_home)?;
    let mut command = Command::new(&python);
    command
        .arg(&script)
        .arg("--audio")
        .arg(wav)
        .env("HF_HOME", &hf_home)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    if let Some(token) = huggingface_token {
        command.env("HF_TOKEN", token);
    }
    let output = command
        .output()
        .map_err(|error| AppError::Diarization(error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Diarization(error_detail(&stderr).into()));
    }
    let parsed: ScriptOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Diarization(format!("invalid diarizer output: {e}")))?;
    Ok(parsed
        .segments
        .into_iter()
        .map(|segment| SpeakerSegment {
            start_ms: (segment.start.max(0.0) * 1000.0) as u64,
            end_ms: (segment.end.max(0.0) * 1000.0) as u64,
            speaker: segment.speaker,
        })
        .collect())
}

fn write_script(data_dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(diarize_dir(data_dir))?;
    std::fs::write(diarize_dir(data_dir).join("diarize.py"), DIARIZE_PY)?;
    Ok(())
}

fn error_detail(stderr: &str) -> &str {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.contains("libtorchcodec loading traceback"))
        .unwrap_or("unknown diarization error")
}

#[cfg(test)]
mod tests {
    use super::{DiarizerPrepareEvent, DiarizerStatus};

    #[test]
    fn status_schema_is_camel_case() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&DiarizerStatus {
            ready: true,
            uv_installed: true,
            engine_installed: false,
        })?;
        assert_eq!(
            json,
            r#"{"ready":true,"uvInstalled":true,"engineInstalled":false}"#
        );
        Ok(())
    }

    #[test]
    fn prepare_progress_event_matches_frontend_schema() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&DiarizerPrepareEvent::Progress {
            downloaded_bytes: 10,
            total_bytes: Some(20),
        })?;
        assert_eq!(
            json,
            r#"{"type":"progress","downloadedBytes":10,"totalBytes":20}"#
        );
        Ok(())
    }

    #[test]
    fn embedded_script_is_present() {
        assert!(super::DIARIZE_PY.contains("pyannote.audio"));
        assert!(super::DIARIZE_PY.contains("load_pcm16_wav"));
        assert!(super::DIARIZE_PY.contains("waveform"));
    }

    #[test]
    fn error_detail_skips_torchcodec_footer() {
        let stderr = "OSError: Could not load this library: libtorchcodec_core5.dylib\n[end of libtorchcodec loading traceback].\n";
        assert_eq!(
            super::error_detail(stderr),
            "OSError: Could not load this library: libtorchcodec_core5.dylib"
        );
    }

    #[test]
    fn error_detail_uses_last_real_line() {
        assert_eq!(super::error_detail("pyannote.audio is not installed\n"), "pyannote.audio is not installed");
        assert_eq!(super::error_detail("   \n"), "unknown diarization error");
    }
}
