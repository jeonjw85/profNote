use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::AppError;

use super::diarize_setup::{diarize_dir, engine_marker, ensure_engine, uv_binary, venv_python};

const DIARIZE_PY: &str = include_str!("../../../scripts/diarize.py");
const STDERR_TAIL_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_LINE_BYTES: usize = 8 * 1024 * 1024;

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
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiarizerPrepareEvent {
    Stage {
        name: String,
    },
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiarizationEvent {
    Stage {
        name: String,
    },
    Progress {
        name: String,
        completed: u32,
        total: u32,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum ScriptEvent {
    Stage {
        name: String,
    },
    Progress {
        name: String,
        completed: u32,
        total: u32,
    },
    Done {
        segments: Vec<RawSegment>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSegment {
    start: f64,
    end: f64,
    speaker: String,
}

struct RunningChild {
    process: Child,
    reaped: bool,
}

impl Drop for RunningChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.process.kill();
            let _ = self.process.wait();
        }
    }
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
    on_event: &Channel<DiarizationEvent>,
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
        .arg("-u")
        .arg(&script)
        .arg("--audio")
        .arg(wav)
        .arg("--stream")
        .env("HF_HOME", &hf_home)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(token) = huggingface_token {
        command.env("HF_TOKEN", token);
    }
    run_command(&mut command, |event| {
        let _ = on_event.send(event);
    })
}

fn run_command(
    command: &mut Command,
    on_event: impl FnMut(DiarizationEvent),
) -> Result<Vec<SpeakerSegment>, AppError> {
    let process = command
        .spawn()
        .map_err(|error| AppError::Diarization(error.to_string()))?;
    let mut child = RunningChild {
        process,
        reaped: false,
    };
    let stdout = child
        .process
        .stdout
        .take()
        .ok_or_else(|| AppError::Diarization("diarizer stdout is unavailable".into()))?;
    let stderr = child
        .process
        .stderr
        .take()
        .ok_or_else(|| AppError::Diarization("diarizer stderr is unavailable".into()))?;
    let stderr_task = thread::Builder::new()
        .name("diarizer-stderr".into())
        .spawn(move || read_stderr_tail(stderr))?;
    let parsed = read_script_events(stdout, on_event);
    if parsed.is_err() {
        let _ = child.process.kill();
    }
    let status = child.process.wait();
    child.reaped = status.is_ok();
    if !child.reaped {
        let _ = child.process.kill();
        child.reaped = child.process.wait().is_ok();
    }
    let stderr = stderr_task
        .join()
        .map_err(|_| AppError::Diarization("diarizer stderr reader failed".into()))??;
    let parsed = parsed?;
    let status = status.map_err(|error| AppError::Diarization(error.to_string()))?;
    if !status.success() {
        return Err(AppError::Diarization(error_detail(&stderr).into()));
    }
    parsed.ok_or_else(|| AppError::Diarization("diarizer did not return a result".into()))
}

fn read_stderr_tail(mut reader: impl Read) -> Result<String, AppError> {
    let mut tail = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..read]);
        if tail.len() > STDERR_TAIL_BYTES {
            tail.drain(..tail.len() - STDERR_TAIL_BYTES);
        }
    }
    Ok(String::from_utf8_lossy(&tail).into_owned())
}

fn read_script_events(
    reader: impl Read,
    mut on_event: impl FnMut(DiarizationEvent),
) -> Result<Option<Vec<SpeakerSegment>>, AppError> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut result = None;
    loop {
        line.clear();
        let read = (&mut reader)
            .take((MAX_OUTPUT_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_OUTPUT_LINE_BYTES {
            return Err(AppError::Diarization(
                "diarizer output line is too large".into(),
            ));
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if result.is_some() {
            return Err(AppError::Diarization(
                "diarizer sent data after its result".into(),
            ));
        }
        let event: ScriptEvent = serde_json::from_slice(&line)
            .map_err(|error| AppError::Diarization(format!("invalid diarizer event: {error}")))?;
        match event {
            ScriptEvent::Stage { name } => {
                validate_stage_name(&name)?;
                on_event(DiarizationEvent::Stage { name });
            }
            ScriptEvent::Progress {
                name,
                completed,
                total,
            } => {
                validate_stage_name(&name)?;
                if total == 0 || completed > total {
                    return Err(AppError::Diarization("invalid diarizer progress".into()));
                }
                on_event(DiarizationEvent::Progress {
                    name,
                    completed,
                    total,
                });
            }
            ScriptEvent::Done { segments } => result = Some(validate_segments(segments)?),
            ScriptEvent::Error { message } => {
                if message.trim().is_empty() {
                    return Err(AppError::Diarization(
                        "invalid diarizer error message".into(),
                    ));
                }
                return Err(AppError::Diarization(message.chars().take(4096).collect()));
            }
        }
    }
    Ok(result)
}

fn validate_stage_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() || name.len() > 80 {
        return Err(AppError::Diarization("invalid diarizer stage name".into()));
    }
    Ok(())
}

fn validate_segments(segments: Vec<RawSegment>) -> Result<Vec<SpeakerSegment>, AppError> {
    segments
        .into_iter()
        .map(|segment| {
            if !segment.start.is_finite()
                || !segment.end.is_finite()
                || segment.start < 0.0
                || segment.end < segment.start
                || segment.end > u64::MAX as f64 / 1000.0
                || segment.speaker.trim().is_empty()
            {
                return Err(AppError::Diarization("invalid diarizer segment".into()));
            }
            Ok(SpeakerSegment {
                start_ms: (segment.start.max(0.0) * 1000.0) as u64,
                end_ms: (segment.end.max(0.0) * 1000.0) as u64,
                speaker: segment.speaker,
            })
        })
        .collect()
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
    use std::io::Cursor;

    use super::{DiarizationEvent, DiarizerPrepareEvent, DiarizerStatus, read_script_events};

    #[cfg(unix)]
    fn stub_command(script: &str) -> std::process::Command {
        let mut command = std::process::Command::new("sh");
        command
            .args(["-c", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        command
    }

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
        assert!(super::DIARIZE_PY.contains("speaker_diarization"));
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
        assert_eq!(
            super::error_detail("pyannote.audio is not installed\n"),
            "pyannote.audio is not installed"
        );
        assert_eq!(super::error_detail("   \n"), "unknown diarization error");
    }

    #[test]
    fn streaming_progress_matches_frontend_schema() -> Result<(), serde_json::Error> {
        let event = DiarizationEvent::Progress {
            name: "embedding".into(),
            completed: 12,
            total: 34,
        };
        assert_eq!(
            serde_json::to_string(&event)?,
            r#"{"type":"progress","name":"embedding","completed":12,"total":34}"#
        );
        Ok(())
    }

    #[test]
    fn streaming_events_preserve_segments_and_report_progress() -> Result<(), crate::error::AppError>
    {
        let output = concat!(
            "{\"type\":\"stage\",\"name\":\"loadingModel\"}\n",
            "{\"type\":\"progress\",\"name\":\"segmenting\",\"completed\":4,\"total\":10}\n",
            "{\"type\":\"done\",\"segments\":[{\"start\":0.25,\"end\":1.5,\"speaker\":\"SPEAKER_00\"}]}\n"
        );
        let mut events = Vec::new();
        let result = read_script_events(Cursor::new(output), |event| events.push(event))?;
        let segments = result
            .ok_or_else(|| crate::error::AppError::Diarization("test result missing".into()))?;
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], DiarizationEvent::Stage { name } if name == "loadingModel"));
        assert!(matches!(
            &events[1],
            DiarizationEvent::Progress {
                completed: 4,
                total: 10,
                ..
            }
        ));
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 250);
        assert_eq!(segments[0].end_ms, 1500);
        assert_eq!(segments[0].speaker, "SPEAKER_00");
        Ok(())
    }

    #[test]
    fn malformed_progress_and_segments_are_rejected() {
        for invalid in [
            r#"{"type":"progress","name":"embedding","completed":3,"total":2}"#,
            r#"{"type":"progress","name":"embedding","completed":0,"total":0}"#,
            r#"{"type":"progress","name":"embedding","completed":-1,"total":2}"#,
            r#"{"type":"progress","name":"embedding","completed":0.5,"total":2}"#,
            r#"{"type":"stage","name":"loadingModel","unexpected":true}"#,
            r#"{"type":"done","segments":[{"start":2,"end":1,"speaker":"SPEAKER_00"}]}"#,
            r#"{"type":"done","segments":[{"start":-1,"end":1,"speaker":"SPEAKER_00"}]}"#,
            r#"{"type":"done","segments":[{"start":0,"end":1e30,"speaker":"SPEAKER_00"}]}"#,
            r#"{"type":"done","segments":[{"start":0,"end":1,"speaker":" "}]}"#,
            r#"{"type":"done","segments":[{"start":0,"end":1,"speaker":"SPEAKER_00","unknown":0}]}"#,
        ] {
            assert!(read_script_events(Cursor::new(invalid), |_| {}).is_err());
        }
    }

    #[test]
    fn duplicate_results_are_rejected() {
        let output = "{\"type\":\"done\",\"segments\":[]}\n{\"type\":\"done\",\"segments\":[]}\n";
        assert!(read_script_events(Cursor::new(output), |_| {}).is_err());
    }

    #[test]
    fn script_error_message_is_preserved() {
        let output = r#"{"type":"error","message":"model access denied"}"#;
        let result = read_script_events(Cursor::new(output), |_| {});
        assert!(
            matches!(result, Err(crate::error::AppError::Diarization(message)) if message == "model access denied")
        );
    }

    #[test]
    fn stderr_tail_is_bounded_and_preserves_the_last_error() -> Result<(), crate::error::AppError> {
        let mut bytes = vec![b'x'; super::STDERR_TAIL_BYTES * 3];
        bytes.extend_from_slice(b"\nmodel loading failed\n");
        let tail = super::read_stderr_tail(Cursor::new(bytes))?;
        assert_eq!(tail.len(), super::STDERR_TAIL_BYTES);
        assert_eq!(super::error_detail(&tail), "model loading failed");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn subprocess_progress_arrives_before_exit() -> Result<(), crate::error::AppError> {
        let mut command = stub_command(
            r#"printf '%s\n' '{"type":"stage","name":"loadingModel"}'; sleep 0.2; printf '%s\n' '{"type":"done","segments":[]}'"#,
        );
        let started = std::time::Instant::now();
        let mut received_at = None;
        let result = super::run_command(&mut command, |_| received_at = Some(started.elapsed()))?;
        let elapsed = started.elapsed();
        let received_at = received_at
            .ok_or_else(|| crate::error::AppError::Diarization("test progress missing".into()))?;
        assert!(received_at + std::time::Duration::from_millis(100) < elapsed);
        assert!(result.is_empty());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn malformed_subprocess_output_kills_and_reaps_the_process() {
        let mut command = stub_command(r#"printf '%s\n' 'invalid frame'; exec sleep 5"#);
        let started = std::time::Instant::now();
        let result = super::run_command(&mut command, |_| {});
        assert!(result.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn failed_subprocess_reports_stderr_without_a_pipe_deadlock() {
        let mut command = stub_command(
            r#"head -c 262144 /dev/zero >&2; printf '\nmodel loading failed\n' >&2; exit 7"#,
        );
        let result = super::run_command(&mut command, |_| {});
        assert!(
            matches!(result, Err(crate::error::AppError::Diarization(message)) if message == "model loading failed")
        );
    }
}
