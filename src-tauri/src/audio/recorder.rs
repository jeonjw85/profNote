use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};

use crate::error::AppError;

const CALLBACK_CHUNK_SAMPLES: usize = 8192;
const FLUSH_SAMPLE_COUNT: u64 = 480_000;

pub struct PcmDescriptor {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_ms: u64,
}

struct WrittenPcm {
    total_samples: u64,
}

pub struct ActiveRecording {
    stream: Option<Stream>,
    writer: Option<thread::JoinHandle<Result<WrittenPcm, AppError>>>,
    chunk_tx: Option<mpsc::Sender<Vec<i16>>>,
    stream_errored: Arc<AtomicBool>,
    pub pcm_path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub started_at_ms: u64,
}

impl ActiveRecording {
    pub fn start(recordings_dir: &Path) -> Result<ActiveRecording, AppError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| AppError::AudioDevice("no default input device found".into()))?;
        let supported = device.default_input_config()?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| AppError::Recording(e.to_string()))?
            .as_millis() as u64;
        let pcm_path = recordings_dir.join(format!("recording_{started_at_ms}.pcm"));

        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<i16>>();
        let writer_path = pcm_path.clone();
        let writer = thread::spawn(move || write_pcm(chunk_rx, &writer_path));

        let stream_errored = Arc::new(AtomicBool::new(false));
        let stream = match supported.sample_format() {
            SampleFormat::I16 => build_capture_stream::<i16>(
                &device,
                supported.config(),
                chunk_tx.clone(),
                Arc::clone(&stream_errored),
            ),
            SampleFormat::F32 => build_capture_stream::<f32>(
                &device,
                supported.config(),
                chunk_tx.clone(),
                Arc::clone(&stream_errored),
            ),
            other => Err(AppError::AudioConfig(format!(
                "input device sample format not supported: {other:?}"
            ))),
        }?;
        stream.play()?;

        Ok(ActiveRecording {
            stream: Some(stream),
            writer: Some(writer),
            chunk_tx: Some(chunk_tx),
            stream_errored,
            pcm_path,
            sample_rate,
            channels,
            started_at_ms,
        })
    }

    pub fn stop(mut self) -> Result<PcmDescriptor, AppError> {
        let stream_result: Result<(), AppError> = self
            .stream
            .take()
            .ok_or_else(|| AppError::Recording("capture stream already closed".into()))
            .and_then(|stream| stream.pause().map_err(AppError::from));
        drop(self.chunk_tx.take());
        let writer = self
            .writer
            .take()
            .ok_or_else(|| AppError::Recording("writer thread already stopped".into()))?;
        let written = writer
            .join()
            .map_err(|_| AppError::Recording("writer thread panicked".into()))??;
        stream_result?;
        if self.stream_errored.load(Ordering::SeqCst) {
            return Err(AppError::Recording(format!(
                "input stream failed during capture; partial data kept at {}",
                self.pcm_path.display()
            )));
        }
        let samples_per_second =
            u64::from(self.channels).saturating_mul(u64::from(self.sample_rate));
        let duration_ms = written
            .total_samples
            .saturating_mul(1000)
            .checked_div(samples_per_second)
            .unwrap_or(0);
        Ok(PcmDescriptor {
            path: self.pcm_path.clone(),
            sample_rate: self.sample_rate,
            channels: self.channels,
            duration_ms,
        })
    }
}

fn build_capture_stream<S>(
    device: &cpal::Device,
    config: StreamConfig,
    chunk_tx: mpsc::Sender<Vec<i16>>,
    stream_errored: Arc<AtomicBool>,
) -> Result<Stream, AppError>
where
    S: Sample + SizedSample,
    i16: FromSample<S>,
{
    let mut buffer: Vec<i16> = Vec::with_capacity(CALLBACK_CHUNK_SAMPLES);
    let stream = device.build_input_stream::<S, _, _>(
        config,
        move |data: &[S], _| {
            buffer.extend(data.iter().map(|sample| i16::from_sample(*sample)));
            if buffer.len() >= CALLBACK_CHUNK_SAMPLES {
                let chunk =
                    std::mem::replace(&mut buffer, Vec::with_capacity(CALLBACK_CHUNK_SAMPLES));
                if chunk_tx.send(chunk).is_err() {
                    buffer.clear();
                }
            }
        },
        move |error| {
            eprintln!("input stream error: {error}");
            stream_errored.store(true, Ordering::SeqCst);
        },
        None,
    )?;
    Ok(stream)
}

fn write_pcm(receiver: mpsc::Receiver<Vec<i16>>, path: &Path) -> Result<WrittenPcm, AppError> {
    let file = File::create(path)?;
    let mut writer = BufWriter::with_capacity(64 * 1024, file);
    let mut total_samples: u64 = 0;
    let mut unflushed: u64 = 0;
    while let Ok(chunk) = receiver.recv() {
        let bytes: Vec<u8> = chunk.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        writer.write_all(&bytes)?;
        total_samples += chunk.len() as u64;
        unflushed += chunk.len() as u64;
        if unflushed >= FLUSH_SAMPLE_COUNT {
            writer.flush()?;
            unflushed = 0;
        }
    }
    writer.flush()?;
    Ok(WrittenPcm { total_samples })
}
