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

pub fn pcm_to_wav16k_mono(pcm: &PcmDescriptor, output: &Path) -> Result<(), AppError> {
    let ffmpeg = resolve_ffmpeg()?;
    let output = Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-f")
        .arg("s16le")
        .arg("-ar")
        .arg(pcm.sample_rate.to_string())
        .arg("-ac")
        .arg(pcm.channels.to_string())
        .arg("-i")
        .arg(&pcm.path)
        .arg("-ar")
        .arg(TARGET_SAMPLE_RATE.to_string())
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output)
        .output()
        .map_err(|error| AppError::Ffmpeg(error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().next_back().unwrap_or("unknown ffmpeg error");
        return Err(AppError::Ffmpeg(detail.to_string()));
    }
    Ok(())
}
