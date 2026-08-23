import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
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

export const IMPORT_AUDIO_EXTENSIONS = [
  "mp3",
  "m4a",
  "aac",
  "wav",
  "flac",
  "ogg",
  "oga",
  "opus",
  "webm",
  "wma",
  "mp4",
  "mov",
] as const;

export async function importAudio(sourcePath: string): Promise<RecordingStopped> {
  return RecordingStoppedSchema.parse(await invoke("import_audio", { sourcePath }));
}

export function isImportableAudioPath(path: string): boolean {
  const ext = fileExtension(path);
  return ext !== undefined && IMPORT_AUDIO_EXTENSIONS.some((allowed) => allowed === ext);
}

export function fileNameWithoutExtension(path: string): string {
  const name = pathBasename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function pathBasename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function fileExtension(path: string): string | undefined {
  const name = pathBasename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return name.slice(dot + 1).toLowerCase();
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

export function audioSrc(path: string): string {
  return convertFileSrc(path);
}
