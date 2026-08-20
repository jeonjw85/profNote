use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::ipc::Channel;

use crate::error::AppError;

use super::diarizer::DiarizerPrepareEvent;

pub const UV_VERSION: &str = "0.8.22";
const DOWNLOAD_CHUNK_BYTES: usize = 256 * 1024;
const PROGRESS_EVENT_BYTES: u64 = 1024 * 1024;
const MAX_REDIRECTS: u32 = 5;

pub fn diarize_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("diarize")
}

pub fn uv_binary(data_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        diarize_dir(data_dir).join("uv.exe")
    } else {
        diarize_dir(data_dir).join("uv")
    }
}

pub fn venv_python(data_dir: &Path) -> PathBuf {
    let venv = diarize_dir(data_dir).join("venv");
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

pub fn engine_marker(data_dir: &Path) -> PathBuf {
    diarize_dir(data_dir).join("engine.ok")
}

pub fn uv_artifact(os: &str, arch: &str) -> Result<(String, &'static str), AppError> {
    let triple = match (os, arch) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        _ => {
            return Err(AppError::Diarization(format!(
                "unsupported diarizer platform: {os}/{arch}"
            )));
        }
    };
    let ext = if os == "windows" { "zip" } else { "tar.gz" };
    Ok((triple.to_string(), ext))
}

fn host_uv_artifact() -> Result<(String, &'static str), AppError> {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "other"
    };
    uv_artifact(os, arch)
}

pub fn ensure_engine(
    data_dir: &Path,
    on_event: &Channel<DiarizerPrepareEvent>,
) -> Result<(), AppError> {
    std::fs::create_dir_all(diarize_dir(data_dir))?;
    if !uv_binary(data_dir).is_file() {
        let _ = on_event.send(DiarizerPrepareEvent::Stage {
            name: "uv".into(),
        });
        install_uv(data_dir, on_event)?;
    }
    if !engine_marker(data_dir).is_file() {
        let _ = on_event.send(DiarizerPrepareEvent::Stage {
            name: "engine".into(),
        });
        install_engine(data_dir)?;
        std::fs::write(engine_marker(data_dir), UV_VERSION)?;
    }
    let _ = on_event.send(DiarizerPrepareEvent::Done);
    Ok(())
}

fn install_uv(data_dir: &Path, on_event: &Channel<DiarizerPrepareEvent>) -> Result<(), AppError> {
    let (triple, ext) = host_uv_artifact()?;
    let archive_name = format!("uv-{triple}.{ext}");
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{archive_name}"
    );
    let work = diarize_dir(data_dir).join("uv-work");
    if work.exists() {
        std::fs::remove_dir_all(&work)?;
    }
    std::fs::create_dir_all(&work)?;
    let archive = work.join(&archive_name);
    download_file(&url, &archive, on_event)?;
    extract_archive(&archive, &work, ext)?;
    let binary_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let found = find_file(&work, binary_name)
        .ok_or_else(|| AppError::Diarization("uv binary missing from archive".into()))?;
    std::fs::copy(&found, uv_binary(data_dir))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(uv_binary(data_dir), std::fs::Permissions::from_mode(0o755))?;
        let _ = Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(uv_binary(data_dir))
            .status();
        let _ = Command::new("codesign")
            .args(["--sign", "-", "--force"])
            .arg(uv_binary(data_dir))
            .status();
    }
    std::fs::remove_dir_all(&work).ok();
    Ok(())
}

fn install_engine(data_dir: &Path) -> Result<(), AppError> {
    let uv = uv_binary(data_dir);
    let venv = diarize_dir(data_dir).join("venv");
    let python_dir = diarize_dir(data_dir).join("python");
    let cache_dir = diarize_dir(data_dir).join("cache");
    std::fs::create_dir_all(&python_dir)?;
    std::fs::create_dir_all(&cache_dir)?;
    run_uv(
        &uv,
        &["venv", &venv.to_string_lossy(), "--python", "3.11"],
        &python_dir,
        &cache_dir,
    )?;
    let python = venv_python(data_dir);
    run_uv(
        &uv,
        &[
            "pip",
            "install",
            "--python",
            &python.to_string_lossy(),
            "pyannote.audio",
        ],
        &python_dir,
        &cache_dir,
    )?;
    Ok(())
}

fn run_uv(uv: &Path, args: &[&str], python_dir: &Path, cache_dir: &Path) -> Result<(), AppError> {
    let output = Command::new(uv)
        .args(args)
        .env("UV_PYTHON_INSTALL_DIR", python_dir)
        .env("UV_CACHE_DIR", cache_dir)
        .output()
        .map_err(|e| AppError::Diarization(e.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr
        .lines()
        .next_back()
        .unwrap_or("uv command failed");
    Err(AppError::Diarization(detail.to_string()))
}

fn extract_archive(archive: &Path, dest: &Path, ext: &str) -> Result<(), AppError> {
    let status = if ext == "zip" {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    dest.display()
                ),
            ])
            .status()
    } else {
        Command::new("tar")
            .args(["-xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
            .status()
    }
    .map_err(|e| AppError::Diarization(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Diarization("failed to extract uv archive".into()))
    }
}

fn find_file(root: &Path, name: impl AsRef<std::ffi::OsStr>) -> Option<PathBuf> {
    let name = name.as_ref();
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name() == Some(name) {
            return Some(path);
        }
    }
    None
}

fn download_file(
    url: &str,
    destination: &Path,
    on_event: &Channel<DiarizerPrepareEvent>,
) -> Result<(), AppError> {
    let partial = destination.with_extension("part");
    let response = fetch_following_redirects(url)?;
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
            let _ = on_event.send(DiarizerPrepareEvent::Progress {
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
                    "uv download returned HTTP {}",
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
    Err(AppError::Download("too many redirects while downloading uv".into()))
}

#[cfg(test)]
mod tests {
    use super::uv_artifact;

    #[test]
    fn macos_arm_uses_darwin_tarball() {
        let (triple, ext) = uv_artifact("macos", "aarch64").expect("macos arm");
        assert_eq!(triple, "aarch64-apple-darwin");
        assert_eq!(ext, "tar.gz");
    }

    #[test]
    fn windows_x64_uses_msvc_zip() {
        let (triple, ext) = uv_artifact("windows", "x86_64").expect("windows x64");
        assert_eq!(triple, "x86_64-pc-windows-msvc");
        assert_eq!(ext, "zip");
    }

    #[test]
    fn unsupported_platform_is_rejected() {
        assert!(uv_artifact("linux", "x86_64").is_err());
    }
}
