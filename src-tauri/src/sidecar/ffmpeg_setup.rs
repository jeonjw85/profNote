use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::ipc::Channel;

use crate::error::AppError;
use crate::sidecar::ffmpeg::{
    FfmpegDownloadEvent, ffmpeg_dir, managed_binary, probe_ffmpeg,
};

const DOWNLOAD_CHUNK_BYTES: usize = 256 * 1024;
const PROGRESS_EVENT_BYTES: u64 = 256 * 1024;
const MAX_REDIRECTS: u32 = 5;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const ARCHIVE_URL: &str =
    "https://github.com/vanloctech/ffmpeg-macos/releases/latest/download/ffmpeg-macos-arm64.tar.gz";

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const ARCHIVE_URL: &str = "https://evermeet.cx/ffmpeg/getrelease/zip";

#[cfg(target_os = "windows")]
const ARCHIVE_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip";

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const ARCHIVE_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

pub fn download_ffmpeg(
    data_dir: &Path,
    on_event: &Channel<FfmpegDownloadEvent>,
) -> Result<PathBuf, AppError> {
    let dest_dir = ffmpeg_dir(data_dir);
    std::fs::create_dir_all(&dest_dir)?;
    let archive = dest_dir.join("ffmpeg-download.archive");
    let extract_dir = dest_dir.join("extract");
    download_file(ARCHIVE_URL, &archive, on_event)?;
    if extract_dir.exists() {
        std::fs::remove_dir_all(&extract_dir)?;
    }
    std::fs::create_dir_all(&extract_dir)?;
    extract_archive(&archive, &extract_dir)?;
    let installed = install_extracted(&extract_dir, data_dir)?;
    probe_ffmpeg(&installed)?;
    std::fs::remove_file(&archive).ok();
    std::fs::remove_dir_all(&extract_dir).ok();
    let _ = on_event.send(FfmpegDownloadEvent::Done {
        path: installed.to_string_lossy().into_owned(),
    });
    Ok(installed)
}

fn download_file(
    url: &str,
    destination: &Path,
    on_event: &Channel<FfmpegDownloadEvent>,
) -> Result<(), AppError> {
    let partial = destination.with_extension("part");
    let response = fetch_following_redirects(url)?;
    let total_bytes = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let _ = on_event.send(FfmpegDownloadEvent::Progress {
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
            .map_err(|error| AppError::Download(error.to_string()))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
        downloaded += read as u64;
        let finished = total_bytes.is_some_and(|total| downloaded == total);
        if downloaded - last_reported >= PROGRESS_EVENT_BYTES || finished {
            last_reported = downloaded;
            let _ = on_event.send(FfmpegDownloadEvent::Progress {
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
    std::fs::rename(&partial, destination)?;
    Ok(())
}

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), AppError> {
    let status = Command::new("tar")
        .args([
            "-xf",
            &archive.to_string_lossy(),
            "-C",
            &dest.to_string_lossy(),
        ])
        .status()
        .map_err(|error| AppError::Ffmpeg(error.to_string()))?;
    if !status.success() {
        return Err(AppError::Ffmpeg("failed to extract ffmpeg archive".into()));
    }
    Ok(())
}

fn install_extracted(extract_root: &Path, data_dir: &Path) -> Result<PathBuf, AppError> {
    let found = find_ffmpeg_binary(extract_root)?;
    let parent = found.parent().ok_or_else(|| {
        AppError::Ffmpeg("ffmpeg binary has no parent directory".into())
    })?;
    let dest_dir = ffmpeg_dir(data_dir);
    std::fs::create_dir_all(&dest_dir)?;
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        std::fs::copy(entry.path(), dest_dir.join(entry.file_name()))?;
    }
    let dest = managed_binary(data_dir);
    if !dest.is_file() {
        std::fs::copy(&found, &dest)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&dest)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&dest, permissions)?;
    }
    Ok(dest)
}

fn find_ffmpeg_binary(root: &Path) -> Result<PathBuf, AppError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "ffmpeg" || name == "ffmpeg.exe" {
                return Ok(path);
            }
        }
    }
    Err(AppError::Ffmpeg(
        "ffmpeg binary missing from downloaded archive".into(),
    ))
}

fn fetch_following_redirects(url: &str) -> Result<ureq::http::Response<ureq::Body>, AppError> {
    let mut current_url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let response = ureq::get(&current_url)
            .call()
            .map_err(|error| AppError::Download(error.to_string()))?;
        let status = response.status();
        if !status.is_redirection() {
            if !status.is_success() {
                return Err(AppError::Download(format!(
                    "ffmpeg download returned HTTP {}",
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
        "too many redirects while downloading ffmpeg".into(),
    ))
}
