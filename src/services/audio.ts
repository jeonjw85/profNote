import { Channel, invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  DiarizerPrepareEventSchema,
  DiarizerStatusSchema,
  DownloadEventSchema,
  ModelStatusSchema,
  RecordingStartedSchema,
  RecordingStoppedSchema,
  SpeakerSegmentSchema,
  SttEventSchema,
  TranscriptSchema,
  type DiarizerPrepareEvent,
  type DiarizerStatus,
  type DownloadEvent,
  type ModelStatus,
  type RecordingStarted,
  type RecordingStopped,
  type SpeakerSegment,
  type SttEvent,
  type Transcript,
} from "../types";

export async function startRecording(): Promise<RecordingStarted> {
  return RecordingStartedSchema.parse(await invoke("start_recording"));
}

export async function stopRecording(): Promise<RecordingStopped> {
  return RecordingStoppedSchema.parse(await invoke("stop_recording"));
}

export async function transcribeAudio(
  wavPath: string,
  model: string,
  language: string,
  onEvent: (event: SttEvent) => void
): Promise<Transcript> {
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => {
    onEvent(SttEventSchema.parse(message));
  };
  return TranscriptSchema.parse(
    await invoke("transcribe_audio", { wavPath, model, language, onEvent: channel })
  );
}

export async function runDiarization(
  wavPath: string,
  huggingFaceToken: string
): Promise<SpeakerSegment[]> {
  const segments = await invoke("run_diarization", {
    wavPath,
    hfToken: huggingFaceToken.length > 0 ? huggingFaceToken : null,
  });
  return z.array(SpeakerSegmentSchema).parse(segments);
}

export async function getDiarizerStatus(): Promise<DiarizerStatus> {
  return DiarizerStatusSchema.parse(await invoke("get_diarizer_status"));
}

export async function prepareDiarizer(
  onEvent: (event: DiarizerPrepareEvent) => void
): Promise<void> {
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => {
    onEvent(DiarizerPrepareEventSchema.parse(message));
  };
  await invoke("prepare_diarizer", { force: true, onEvent: channel });
}

export async function getModelStatus(model: string): Promise<ModelStatus> {
  return ModelStatusSchema.parse(await invoke("get_model_status", { model }));
}

export async function downloadModel(
  model: string,
  onEvent: (event: DownloadEvent) => void
): Promise<void> {
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => {
    onEvent(DownloadEventSchema.parse(message));
  };
  await invoke("download_model", { model, onEvent: channel });
}

export async function writeMarkdown(filename: string, content: string): Promise<string> {
  return z.string().parse(await invoke("write_markdown", { filename, content }));
}

export async function deleteAudio(path: string): Promise<void> {
  await invoke("delete_audio", { path });
}
