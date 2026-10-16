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
use tauri::ipc::Channel;

use crate::RecordingEvent;
use crate::error::AppError;

const CALLBACK_CHUNK_SAMPLES: usize = 8192;
const FLUSH_SAMPLE_COUNT: u64 = 480_000;

fn no_input_device() -> AppError {
    AppError::AudioDevice("no default input device found".into())
}

fn mic_denied_or(fallback: AppError) -> AppError {
    #[cfg(target_os = "macos")]
    {
        super::mic_macos::denied_or(fallback)
    }
    #[cfg(target_os = "windows")]
    {
        super::mic_windows::denied_or(fallback)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        fallback
    }
}

pub struct PcmDescriptor {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_ms: u64,
}

struct WrittenPcm {
    total_samples: u64,
}

enum CaptureMessage {
    Chunk(Vec<i16>),
    Error(String),
}

pub struct ActiveRecording {
    stream: Option<Stream>,
    writer: Option<thread::JoinHandle<Result<WrittenPcm, AppError>>>,
    chunk_tx: Option<mpsc::Sender<CaptureMessage>>,
    pub pcm_path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub started_at_ms: u64,
}

impl ActiveRecording {
    pub fn start(
        recordings_dir: &Path,
        on_event: Channel<RecordingEvent>,
    ) -> Result<ActiveRecording, AppError> {
        #[cfg(target_os = "macos")]
        super::mic_macos::ensure_access()?;
        #[cfg(target_os = "windows")]
        super::mic_windows::ensure_access()?;
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or_else(|| {
            mic_denied_or(no_input_device())
        })?;
        let supported = device
            .default_input_config()
            .map_err(|error| mic_denied_or(error.into()))?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| AppError::Recording(e.to_string()))?
            .as_millis() as u64;
        let pcm_path = recordings_dir.join(format!("recording_{started_at_ms}.pcm"));

        let file = File::create(&pcm_path)?;
        let (chunk_tx, chunk_rx) = mpsc::channel();
        let capture_failed = Arc::new(AtomicBool::new(false));
        let stream = match supported.sample_format() {
            SampleFormat::I16 => build_capture_stream::<i16>(
                &device,
                supported.config(),
                chunk_tx.clone(),
                Arc::clone(&capture_failed),
            ),
            SampleFormat::F32 => build_capture_stream::<f32>(
                &device,
                supported.config(),
                chunk_tx.clone(),
                Arc::clone(&capture_failed),
            ),
            other => Err(AppError::AudioConfig(format!(
                "input device sample format not supported: {other:?}"
            ))),
        }?;
        stream
            .play()
            .map_err(|error| mic_denied_or(error.into()))?;
        let writer_path = pcm_path.clone();
        let writer = thread::Builder::new().spawn(move || {
            write_pcm(
                chunk_rx,
                BufWriter::with_capacity(64 * 1024, file),
                &writer_path,
                &capture_failed,
                |message| {
                    let _ = on_event.send(RecordingEvent::Error { message });
                },
            )
        })?;

        Ok(ActiveRecording {
            stream: Some(stream),
            writer: Some(writer),
            chunk_tx: Some(chunk_tx),
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

impl Drop for ActiveRecording {
    fn drop(&mut self) {
        drop(self.stream.take());
        drop(self.chunk_tx.take());
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

fn build_capture_stream<S>(
    device: &cpal::Device,
    config: StreamConfig,
    chunk_tx: mpsc::Sender<CaptureMessage>,
    capture_failed: Arc<AtomicBool>,
) -> Result<Stream, AppError>
where
    S: Sample + SizedSample,
    i16: FromSample<S>,
{
    let mut buffer: Vec<i16> = Vec::with_capacity(CALLBACK_CHUNK_SAMPLES);
    let error_tx = chunk_tx.clone();
    let stream_failed = Arc::clone(&capture_failed);
    let stream = device.build_input_stream::<S, _, _>(
        config,
        move |data: &[S], _| {
            if capture_failed.load(Ordering::SeqCst) {
                buffer.clear();
                return;
            }
            buffer.extend(data.iter().map(|sample| i16::from_sample(*sample)));
            if buffer.len() >= CALLBACK_CHUNK_SAMPLES {
                let chunk =
                    std::mem::replace(&mut buffer, Vec::with_capacity(CALLBACK_CHUNK_SAMPLES));
                if chunk_tx.send(CaptureMessage::Chunk(chunk)).is_err() {
                    capture_failed.store(true, Ordering::SeqCst);
                    buffer.clear();
                }
            }
        },
        move |error| {
            report_capture_error(
                &error_tx,
                &stream_failed,
                format!("input stream error: {error}"),
            );
        },
        None,
    )?;
    Ok(stream)
}

fn report_capture_error(
    sender: &mpsc::Sender<CaptureMessage>,
    failed: &AtomicBool,
    message: String,
) {
    if !failed.swap(true, Ordering::SeqCst) {
        let _ = sender.send(CaptureMessage::Error(message));
    }
}

fn write_pcm<W: Write>(
    receiver: mpsc::Receiver<CaptureMessage>,
    mut writer: W,
    path: &Path,
    failed: &AtomicBool,
    notify_error: impl FnOnce(String),
) -> Result<WrittenPcm, AppError> {
    let result = write_chunks(receiver, &mut writer);
    result.map_err(|error| {
        failed.store(true, Ordering::SeqCst);
        let error = AppError::Recording(format!(
            "{error}; partial PCM kept at {} for recovery",
            path.display()
        ));
        notify_error(error.to_string());
        error
    })
}

fn write_chunks<W: Write>(
    receiver: mpsc::Receiver<CaptureMessage>,
    writer: &mut W,
) -> Result<WrittenPcm, AppError> {
    let mut total_samples: u64 = 0;
    let mut unflushed: u64 = 0;
    while let Ok(message) = receiver.recv() {
        let chunk = match message {
            CaptureMessage::Chunk(chunk) => chunk,
            CaptureMessage::Error(message) => {
                writer.flush()?;
                return Err(AppError::Recording(message));
            }
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    struct FailingWriter {
        fail_write: bool,
        fail_flush: bool,
    }

    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail_write {
                return Err(io::Error::other("disk full"));
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            if self.fail_flush {
                return Err(io::Error::other("flush failed"));
            }
            Ok(())
        }
    }

    #[test]
    fn writer_failure_stops_capture_and_notifies_before_capture_is_stopped() {
        let (sender, receiver) = mpsc::channel();
        let failed = Arc::new(AtomicBool::new(false));
        let (events_tx, events_rx) = mpsc::channel();
        sender
            .send(CaptureMessage::Chunk(vec![1, 2]))
            .expect("chunk");
        let writer_failed = Arc::clone(&failed);
        let writer = thread::spawn(move || {
            write_pcm(
                receiver,
                FailingWriter {
                    fail_write: true,
                    fail_flush: false,
                },
                Path::new("/recordings/partial.pcm"),
                &writer_failed,
                |message| {
                    events_tx.send(message).expect("error event");
                },
            )
        });

        let message = events_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("immediate failure");
        assert!(failed.load(Ordering::SeqCst));
        assert!(message.contains("disk full"));
        assert!(message.contains("/recordings/partial.pcm"));
        assert!(writer.join().expect("writer joined").is_err());
        assert!(events_rx.try_recv().is_err());
        drop(sender);
    }

    #[test]
    fn flush_failures_are_reported_during_capture_and_on_stop() {
        for sample_count in [2, FLUSH_SAMPLE_COUNT as usize] {
            let (sender, receiver) = mpsc::channel();
            let failed = Arc::new(AtomicBool::new(false));
            let writer_failed = Arc::clone(&failed);
            let (events_tx, events_rx) = mpsc::channel();
            let writer = thread::spawn(move || {
                write_pcm(
                    receiver,
                    FailingWriter {
                        fail_write: false,
                        fail_flush: true,
                    },
                    Path::new("/recordings/partial.pcm"),
                    &writer_failed,
                    |message| {
                        events_tx.send(message).expect("error event");
                    },
                )
            });
            sender
                .send(CaptureMessage::Chunk(vec![0; sample_count]))
                .expect("chunk");
            let sender = if sample_count == 2 {
                drop(sender);
                None
            } else {
                Some(sender)
            };

            let message = events_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("flush failure");
            assert!(failed.load(Ordering::SeqCst));
            assert!(message.contains("flush failed"));
            drop(sender);
            assert!(writer.join().expect("writer joined").is_err());
            assert!(events_rx.try_recv().is_err());
        }
    }

    #[test]
    fn stream_failures_only_notify_once_and_preserve_flushed_pcm() {
        let (sender, receiver) = mpsc::channel();
        let failed = AtomicBool::new(false);
        sender
            .send(CaptureMessage::Chunk(vec![0x1234, -2]))
            .expect("chunk");
        report_capture_error(&sender, &failed, "device disconnected".into());
        assert!(failed.load(Ordering::SeqCst));
        report_capture_error(&sender, &failed, "repeated stream error".into());
        drop(sender);
        let mut events = Vec::new();
        let mut bytes = Vec::new();
        let result = write_pcm(
            receiver,
            &mut bytes,
            Path::new("/recordings/partial.pcm"),
            &failed,
            |message| events.push(message),
        );

        assert!(result.is_err());
        assert_eq!(bytes, [0x34, 0x12, 0xfe, 0xff]);
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("device disconnected"));
    }

    #[test]
    fn successful_writer_preserves_samples_without_error_events() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(CaptureMessage::Chunk(vec![1, -1, i16::MIN]))
            .expect("chunk");
        drop(sender);
        let failed = AtomicBool::new(false);
        let mut bytes = Vec::new();
        let result = write_pcm(
            receiver,
            &mut bytes,
            Path::new("/recordings/complete.pcm"),
            &failed,
            |_| panic!("unexpected recording error"),
        )
        .expect("written PCM");

        assert_eq!(result.total_samples, 3);
        assert_eq!(bytes, [1, 0, 0xff, 0xff, 0, 0x80]);
        assert!(!failed.load(Ordering::SeqCst));
    }
}
