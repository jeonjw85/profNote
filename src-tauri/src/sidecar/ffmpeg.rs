use std::path::{Path, PathBuf};
use std::process::Command;

use crate::audio::PcmDescriptor;
use crate::error::AppError;

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

const FFMPEG_CANDIDATES: &[&str] = &[
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
];

fn resolve_ffmpeg() -> Result<PathBuf, AppError> {
    for candidate in FFMPEG_CANDIDATES {
        let path = PathBuf::from(candidate);
        match Command::new(&path).arg("-version").output() {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(AppError::Ffmpeg(error.to_string())),
        }
    }
    Err(AppError::Ffmpeg(
        "ffmpeg binary not found; install FFmpeg to enable audio conversion".into(),
    ))
}

fn convert_to_wav16k_mono(
    extra_input_args: &[&str],
    input: &Path,
    output: &Path,
) -> Result<(), AppError> {
    let ffmpeg = resolve_ffmpeg()?;
    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y");
    for arg in extra_input_args {
        command.arg(arg);
    }
    let completed = command
        .arg("-i")
        .arg(input)
        .arg("-ar")
        .arg(TARGET_SAMPLE_RATE.to_string())
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output)
        .output()
        .map_err(|error| AppError::Ffmpeg(error.to_string()))?;
    if !completed.status.success() {
        let stderr = String::from_utf8_lossy(&completed.stderr);
        let detail = stderr.lines().next_back().unwrap_or("unknown ffmpeg error");
        return Err(AppError::Ffmpeg(detail.to_string()));
    }
    Ok(())
}

pub fn pcm_to_wav16k_mono(pcm: &PcmDescriptor, output: &Path) -> Result<(), AppError> {
    let sample_rate = pcm.sample_rate.to_string();
    let channels = pcm.channels.to_string();
    convert_to_wav16k_mono(
        &[
            "-f",
            "s16le",
            "-ar",
            sample_rate.as_str(),
            "-ac",
            channels.as_str(),
        ],
        &pcm.path,
        output,
    )
}

pub fn file_to_wav16k_mono(input: &Path, output: &Path) -> Result<(), AppError> {
    convert_to_wav16k_mono(&[], input, output)
}
