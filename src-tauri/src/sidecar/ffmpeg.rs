use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::audio::PcmDescriptor;
use crate::error::AppError;

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

const SYSTEM_CANDIDATES: &[&str] = &[
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
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
pub enum FfmpegDownloadEvent {
    Progress {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Done {
        path: String,
    },
}

pub fn ffmpeg_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ffmpeg")
}

pub fn managed_binary(data_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        ffmpeg_dir(data_dir).join("ffmpeg.exe")
    } else {
        ffmpeg_dir(data_dir).join("ffmpeg")
    }
}

pub fn probe_ffmpeg(path: &Path) -> Result<(), AppError> {
    let output = Command::new(path)
        .arg("-version")
        .output()
        .map_err(|error| AppError::Ffmpeg(error.to_string()))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Ffmpeg("ffmpeg -version failed".into()))
    }
}

pub fn status(data_dir: &Path) -> FfmpegStatus {
    match resolve_ffmpeg(data_dir) {
        Ok(path) => {
            let size_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            FfmpegStatus {
                installed: true,
                size_bytes,
                path: path.to_string_lossy().into_owned(),
            }
        }
        Err(_) => FfmpegStatus {
            installed: false,
            size_bytes: 0,
            path: managed_binary(data_dir).to_string_lossy().into_owned(),
        },
    }
}

fn resolve_ffmpeg(data_dir: &Path) -> Result<PathBuf, AppError> {
    let managed = managed_binary(data_dir);
    if managed.is_file() && probe_ffmpeg(&managed).is_ok() {
        return Ok(managed);
    }
    for candidate in SYSTEM_CANDIDATES {
        let path = PathBuf::from(candidate);
        match Command::new(&path).arg("-version").output() {
            Ok(output) if output.status.success() => return Ok(path),
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(AppError::Ffmpeg(error.to_string())),
        }
    }
    Err(AppError::Ffmpeg(
        "ffmpeg is not installed; download it from the record bar".into(),
    ))
}

fn convert_to_wav16k_mono(
    data_dir: &Path,
    extra_input_args: &[&str],
    input: &Path,
    output: &Path,
) -> Result<(), AppError> {
    let ffmpeg = resolve_ffmpeg(data_dir)?;
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

pub fn pcm_to_wav16k_mono(
    data_dir: &Path,
    pcm: &PcmDescriptor,
    output: &Path,
) -> Result<(), AppError> {
    let sample_rate = pcm.sample_rate.to_string();
    let channels = pcm.channels.to_string();
    convert_to_wav16k_mono(
        data_dir,
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

pub fn file_to_wav16k_mono(
    data_dir: &Path,
    input: &Path,
    output: &Path,
) -> Result<(), AppError> {
    convert_to_wav16k_mono(data_dir, &[], input, output)
}
