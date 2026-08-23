#[cfg(target_os = "macos")]
mod mic_macos;
#[cfg(target_os = "windows")]
mod mic_windows;
mod recorder;

pub use recorder::{ActiveRecording, PcmDescriptor};

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

const IMPORT_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "webm", "wma", "mp4", "mov",
];

pub fn is_allowed_import_extension(ext: &str) -> bool {
    IMPORT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn validate_import_source(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::InvalidInput(format!(
            "audio file not found: {}",
            path.display()
        )));
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            AppError::InvalidInput(format!("unsupported audio format: {}", path.display()))
        })?;
    if !is_allowed_import_extension(ext) {
        return Err(AppError::InvalidInput(format!(
            "unsupported audio format: {}",
            path.display()
        )));
    }
    Ok(())
}

pub fn next_recording_wav_path(recordings_dir: &Path) -> Result<PathBuf, AppError> {
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Recording(error.to_string()))?
        .as_millis() as u64;
    Ok(recordings_dir.join(format!("recording_{started_at_ms}.wav")))
}

pub fn wav_duration_ms(path: &Path) -> Result<u64, AppError> {
    let reader = hound::WavReader::open(path)?;
    let sample_rate = u64::from(reader.spec().sample_rate);
    Ok(u64::from(reader.duration())
        .saturating_mul(1000)
        .checked_div(sample_rate)
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::{
        is_allowed_import_extension, next_recording_wav_path, validate_import_source,
        wav_duration_ms,
    };
    use crate::error::AppError;
    use std::path::Path;

    #[test]
    fn import_extension_accepts_allowlist_case_insensitively() {
        assert!(is_allowed_import_extension("MP3"));
        assert!(is_allowed_import_extension("wav"));
        assert!(is_allowed_import_extension("m4a"));
        assert!(is_allowed_import_extension("MOV"));
        assert!(!is_allowed_import_extension("txt"));
        assert!(!is_allowed_import_extension(""));
    }

    #[test]
    fn validate_import_source_rejects_missing_file() {
        let err = validate_import_source(Path::new("/no/such/file.mp3"));
        assert!(matches!(err, Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn validate_import_source_rejects_disallowed_extension() {
        let dir = std::env::temp_dir().join(format!("profnote-import-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("notes.txt");
        std::fs::write(&path, b"x").expect("write");
        let err = validate_import_source(&path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        assert!(matches!(err, Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn next_recording_wav_path_uses_recording_timestamp_convention() {
        let path =
            next_recording_wav_path(Path::new("/tmp/recordings")).expect("timestamped wav path");
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("utf8 file name");
        assert!(name.starts_with("recording_"));
        assert!(name.ends_with(".wav"));
        assert_eq!(path.parent(), Some(Path::new("/tmp/recordings")));
    }

    #[test]
    fn wav_duration_ms_from_sample_count_and_rate() {
        let dir =
            std::env::temp_dir().join(format!("profnote-wav-duration-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("tone.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("wav writer");
        for _ in 0..8_000 {
            writer.write_sample(0i16).expect("sample");
        }
        writer.finalize().expect("finalize wav");
        let ms = wav_duration_ms(&path).expect("duration");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        assert_eq!(ms, 500);
    }
}
