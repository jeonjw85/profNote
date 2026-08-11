use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("audio device unavailable: {0}")]
    AudioDevice(String),
    #[error("audio configuration failed: {0}")]
    AudioConfig(String),
    #[error("recording failed: {0}")]
    Recording(String),
    #[error("io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("diarization failed: {0}")]
    Diarization(String),
    #[error("transcription failed: {0}")]
    Transcription(String),
    #[error("model unavailable: {0}")]
    Model(String),
    #[error("download failed: {0}")]
    Download(String),
    #[error("llm request failed: {0}")]
    Llm(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<cpal::Error> for AppError {
    fn from(error: cpal::Error) -> Self {
        AppError::AudioDevice(error.to_string())
    }
}

impl From<hound::Error> for AppError {
    fn from(error: hound::Error) -> Self {
        AppError::Transcription(error.to_string())
    }
}
