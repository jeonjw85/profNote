use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: String,
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

pub fn run_diarization(
    python_bin: &Path,
    script: &Path,
    wav: &Path,
    huggingface_token: Option<&str>,
) -> Result<Vec<SpeakerSegment>, AppError> {
    let mut command = Command::new(python_bin);
    command
        .arg(script)
        .arg("--audio")
        .arg(wav)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    if let Some(token) = huggingface_token {
        command.env("HF_TOKEN", token);
    }
    let output = match command.output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::Diarization(format!(
                "python binary not found at {}",
                python_bin.display()
            )));
        }
        Err(error) => return Err(AppError::Diarization(error.to_string())),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().next_back().unwrap_or("unknown diarization error");
        return Err(AppError::Diarization(detail.to_string()));
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
