import { Channel, invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  DownloadEventSchema,
  ModelStatusSchema,
  RecordingStartedSchema,
  RecordingStoppedSchema,
  SpeakerSegmentSchema,
  SttEventSchema,
  TranscriptSchema,
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
  pythonBin: string,
  scriptPath: string,
  huggingFaceToken: string
): Promise<SpeakerSegment[]> {
  const segments = await invoke("run_diarization", {
    wavPath,
    pythonBin,
    scriptPath,
    hfToken: huggingFaceToken.length > 0 ? huggingFaceToken : null,
  });
  return z.array(SpeakerSegmentSchema).parse(segments);
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
