import type { Translate } from "../i18n/context";
import {
  WHISPER_MODEL_META,
  type PipelineStage,
  type WhisperModel,
} from "../types";

const LOAD_MODEL_MS = 20_000;
const SUMMARY_MS = 45_000;
const DIARIZE_REALTIME_FACTOR = 0.45;
const MIN_PROGRESS_PERCENT = 2;
const ETA_SOON_MS = 20_000;
const MAX_INDETERMINATE_PERCENT = 95;

export type PipelineEtaState = {
  readonly stage: PipelineStage;
  readonly percent: number | null;
  readonly charsReceived: number | null;
  readonly audioDurationMs: number;
  readonly pipelineStartedAtMs: number;
  readonly stageStartedAtMs: number;
};

export type ProcessingView = {
  readonly elapsedMs: number;
  readonly percent: number | null;
  readonly statusText: string;
};

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

export function estimateSttMs(
  audioDurationMs: number,
  model: WhisperModel,
): number {
  return Math.max(0, Math.round(audioDurationMs * WHISPER_MODEL_META[model].sttRealtimeFactor));
}

export function estimateDiarizeMs(audioDurationMs: number): number {
  return Math.max(0, Math.round(audioDurationMs * DIARIZE_REALTIME_FACTOR));
}

export function sttMinutesPerAudioHour(model: WhisperModel): number {
  return Math.max(1, Math.round(WHISPER_MODEL_META[model].sttRealtimeFactor * 60));
}

export function remainingMsFromProgress(
  elapsedMs: number,
  percent: number,
): number | null {
  if (elapsedMs <= 0 || percent < MIN_PROGRESS_PERCENT) {
    return null;
  }
  const clamped = Math.min(percent, 99);
  return Math.round((elapsedMs * (100 - clamped)) / clamped);
}

function remainingFromEstimate(
  elapsedMs: number,
  estimateMs: number,
): number | null {
  if (estimateMs <= 0 || elapsedMs >= estimateMs) {
    return null;
  }
  return estimateMs - elapsedMs;
}

export function remainingMsForStage(
  state: PipelineEtaState,
  nowMs: number,
  whisperModel: WhisperModel,
): number | null {
  const stageElapsedMs = Math.max(0, nowMs - state.stageStartedAtMs);
  switch (state.stage) {
    case "diarizing":
      return remainingFromEstimate(
        stageElapsedMs,
        estimateDiarizeMs(state.audioDurationMs),
      );
    case "loading":
      return remainingFromEstimate(stageElapsedMs, LOAD_MODEL_MS);
    case "transcribing": {
      if (state.percent !== null && state.percent >= MIN_PROGRESS_PERCENT) {
        return remainingMsFromProgress(stageElapsedMs, state.percent);
      }
      return remainingFromEstimate(
        stageElapsedMs,
        estimateSttMs(state.audioDurationMs, whisperModel),
      );
    }
    case "summarizing":
      return remainingFromEstimate(stageElapsedMs, SUMMARY_MS);
    default:
      return assertNever(state.stage);
  }
}

function timeBasedPercent(elapsedMs: number, estimateMs: number): number | null {
  if (estimateMs <= 0) {
    return null;
  }
  return Math.min(
    MAX_INDETERMINATE_PERCENT,
    Math.floor((elapsedMs / estimateMs) * 100),
  );
}

export function displayPercentForStage(
  state: PipelineEtaState,
  nowMs: number,
  whisperModel: WhisperModel,
): number | null {
  const stageElapsedMs = Math.max(0, nowMs - state.stageStartedAtMs);
  switch (state.stage) {
    case "diarizing":
      return timeBasedPercent(
        stageElapsedMs,
        estimateDiarizeMs(state.audioDurationMs),
      );
    case "loading":
      return timeBasedPercent(stageElapsedMs, LOAD_MODEL_MS);
    case "transcribing":
      if (state.percent !== null && state.percent > 0) {
        return Math.min(99, state.percent);
      }
      return timeBasedPercent(
        stageElapsedMs,
        estimateSttMs(state.audioDurationMs, whisperModel),
      );
    case "summarizing":
      return timeBasedPercent(stageElapsedMs, SUMMARY_MS);
    default:
      return assertNever(state.stage);
  }
}

function stageLabel(stage: PipelineStage, t: Translate): string {
  switch (stage) {
    case "diarizing":
      return t("pipeline.stage.diarizing");
    case "loading":
      return t("pipeline.stage.loading");
    case "transcribing":
      return t("pipeline.stage.transcribing");
    case "summarizing":
      return t("pipeline.stage.summarizing");
    default:
      return assertNever(stage);
  }
}

function etaLabel(remainingMs: number, t: Translate): string {
  if (remainingMs < ETA_SOON_MS) {
    return t("pipeline.eta.soon");
  }
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return t("pipeline.eta.minutes", { minutes });
}

export function buildProcessingView(input: {
  readonly state: PipelineEtaState;
  readonly nowMs: number;
  readonly whisperModel: WhisperModel;
  readonly t: Translate;
}): ProcessingView {
  const { state, nowMs, whisperModel, t } = input;
  const elapsedMs = Math.max(0, nowMs - state.pipelineStartedAtMs);
  const remainingMs = remainingMsForStage(state, nowMs, whisperModel);
  const percent = displayPercentForStage(state, nowMs, whisperModel);
  let head = stageLabel(state.stage, t);
  switch (state.stage) {
    case "transcribing":
      if (state.percent !== null && state.percent > 0) {
        head = t("pipeline.stage.percent", {
          stage: head,
          percent: Math.min(99, state.percent),
        });
      }
      break;
    case "summarizing":
      if (state.charsReceived !== null) {
        head = `${head}${t("pipeline.suffix.chars", {
          chars: state.charsReceived.toLocaleString(),
        })}`;
      }
      break;
    case "diarizing":
    case "loading":
      break;
    default:
      assertNever(state.stage);
  }
  const statusText =
    remainingMs === null ? head : `${head} · ${etaLabel(remainingMs, t)}`;
  return { elapsedMs, percent, statusText };
}
