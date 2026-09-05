import { z } from "zod";

export const NOTE_STATUSES = [
  "recording",
  "transcribing",
  "summarizing",
  "ready",
  "error",
] as const;

export const NoteStatusSchema = z.enum(NOTE_STATUSES);
export type NoteStatus = z.infer<typeof NoteStatusSchema>;

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  transcript: z.string(),
  summary_md: z.string(),
  audio_path: z.string().nullable(),
  status: NoteStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  segments_json: z.string(),
  professor_speaker: z.string().nullable(),
});
export type Note = z.infer<typeof NoteSchema>;

export const RecordingStartedSchema = z.object({
  startedAtMs: z.number(),
  sampleRate: z.number(),
  channels: z.number(),
});
export type RecordingStarted = z.infer<typeof RecordingStartedSchema>;

export const RecordingStoppedSchema = z.object({
  wavPath: z.string(),
  durationMs: z.number(),
});
export type RecordingStopped = z.infer<typeof RecordingStoppedSchema>;

export const SpeakerSegmentSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  speaker: z.string(),
});
export type SpeakerSegment = z.infer<typeof SpeakerSegmentSchema>;

export const TranscriptSegmentSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  segments: z.array(TranscriptSegmentSchema),
  text: z.string(),
  language: z.string(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const SpeakerDataSchema = z.object({
  transcript: z.array(TranscriptSegmentSchema),
  speakers: z.array(SpeakerSegmentSchema),
});
export type SpeakerData = z.infer<typeof SpeakerDataSchema>;

export const SttEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("loading") }),
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("progress"), percent: z.number() }),
  z.object({ type: z.literal("finished") }),
]);
export type SttEvent = z.infer<typeof SttEventSchema>;

export const DownloadEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    downloadedBytes: z.number(),
    totalBytes: z.number().nullable(),
  }),
  z.object({ type: z.literal("done"), path: z.string() }),
]);
export type DownloadEvent = z.infer<typeof DownloadEventSchema>;

export const ModelStatusSchema = z.object({
  installed: z.boolean(),
  sizeBytes: z.number(),
  path: z.string(),
});
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export const FfmpegStatusSchema = ModelStatusSchema;
export type FfmpegStatus = ModelStatus;

export const DiarizerStatusSchema = z.object({
  ready: z.boolean(),
  uvInstalled: z.boolean(),
  engineInstalled: z.boolean(),
});
export type DiarizerStatus = z.infer<typeof DiarizerStatusSchema>;

export const DiarizerPrepareEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), name: z.string() }),
  z.object({
    type: z.literal("progress"),
    downloadedBytes: z.number(),
    totalBytes: z.number().nullable(),
  }),
  z.object({ type: z.literal("done") }),
]);
export type DiarizerPrepareEvent = z.infer<typeof DiarizerPrepareEventSchema>;

export const PIPELINE_STAGES = [
  "diarizing",
  "loading",
  "transcribing",
  "summarizing",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const WHISPER_MODELS = ["medium", "large-v3", "large-v3-turbo"] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export const WHISPER_MODEL_META = {
  medium: {
    sizeBytes: 1_532_833_792,
    sttRealtimeFactor: 0.58,
  },
  "large-v3-turbo": {
    sizeBytes: 1_622_809_600,
    sttRealtimeFactor: 0.33,
  },
  "large-v3": {
    sizeBytes: 2_955_219_968,
    sttRealtimeFactor: 1.5,
  },
} as const satisfies Record<
  WhisperModel,
  { readonly sizeBytes: number; readonly sttRealtimeFactor: number }
>;

export function isWhisperModel(value: string): value is WhisperModel {
  return WHISPER_MODELS.some((model) => model === value);
}

export const SUMMARY_LANGUAGES = ["auto", "ko", "en"] as const;
export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number];

export const SettingsSchema = z.object({
  openaiApiKey: z.string().default(""),
  llmBaseUrl: z.string().default(""),
  llmModel: z.string().default(""),
  whisperModel: z.enum(WHISPER_MODELS).default("medium"),
  whisperLanguage: z.string().default("ko"),
  huggingFaceToken: z.string().default(""),
  enableDiarization: z.boolean().default(true),
  enableSummary: z.boolean().default(true),
  uiLanguage: z.enum(["ko", "en"]).default("en"),
  summaryLanguage: z.enum(SUMMARY_LANGUAGES).default("auto"),
});
export type Settings = z.infer<typeof SettingsSchema>;

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}
