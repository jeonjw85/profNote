import type { Translate } from "../i18n/context";
import {
  WHISPER_MODEL_META,
  type PipelineStage,
  type WhisperModel,
} from "../types";

const MIN_PROGRESS_PERCENT = 2;
const ETA_SOON_MS = 20_000;

export type PipelineEtaState = {
  readonly stage: PipelineStage;
  readonly percent: number | null;
  readonly charsReceived: number | null;
  readonly diarizationStep: string | null;
  readonly diarizationCompleted: number | null;
  readonly diarizationTotal: number | null;
  readonly summaryCompletedRequests: number | null;
  readonly summaryTotalRequests: number | null;
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

export function remainingMsForStage(
  state: PipelineEtaState,
  nowMs: number,
): number | null {
  const stageElapsedMs = Math.max(0, nowMs - state.stageStartedAtMs);
  switch (state.stage) {
    case "diarizing":
    case "loading":
    case "summarizing":
      return null;
    case "transcribing":
      return state.percent === null
        ? null
        : remainingMsFromProgress(stageElapsedMs, state.percent);
    default:
      return assertNever(state.stage);
  }
}

export function displayPercentForStage(state: PipelineEtaState): number | null {
  switch (state.stage) {
    case "diarizing":
      return state.diarizationCompleted === null ||
        state.diarizationTotal === null || state.diarizationTotal <= 0
        ? null
        : Math.min(100, Math.floor(100 * state.diarizationCompleted / state.diarizationTotal));
    case "loading":
      return null;
    case "transcribing":
      return state.percent === null ? null : Math.min(99, Math.max(0, state.percent));
    case "summarizing":
      return state.summaryCompletedRequests === null ||
        state.summaryTotalRequests === null || state.summaryTotalRequests <= 0
        ? null
        : Math.min(99, Math.floor(100 * state.summaryCompletedRequests / state.summaryTotalRequests));
    default:
      return assertNever(state.stage);
  }
}

function diarizationStepLabel(step: string | null, t: Translate): string | null {
  switch (step) {
    case "initializing":
      return t("pipeline.diarization.initializing");
    case "loadingModel":
      return t("pipeline.diarization.loading");
    case "loadingAudio":
      return t("pipeline.diarization.loadingAudio");
    case "segmentation":
      return t("pipeline.diarization.segmentation");
    case "embeddings":
      return t("pipeline.diarization.embeddings");
    case "speaker_counting":
      return t("pipeline.diarization.speakerCounting");
    case "clustering":
      return t("pipeline.diarization.clustering");
    case "discrete_diarization":
    case "finalizing":
      return t("pipeline.diarization.finalizing");
    case "retrying":
      return t("pipeline.diarization.retrying");
    default:
      return null;
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
  readonly t: Translate;
}): ProcessingView {
  const { state, nowMs, t } = input;
  const elapsedMs = Math.max(0, nowMs - state.pipelineStartedAtMs);
  const remainingMs = remainingMsForStage(state, nowMs);
  const percent = displayPercentForStage(state);
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
      if (state.summaryCompletedRequests !== null && state.summaryTotalRequests !== null) {
        head += t("pipeline.suffix.steps", {
          completed: state.summaryCompletedRequests,
          total: state.summaryTotalRequests,
        });
      }
      if (state.charsReceived !== null) {
        head = `${head}${t("pipeline.suffix.chars", {
          chars: state.charsReceived.toLocaleString(),
        })}`;
      }
      break;
    case "diarizing": {
      const step = diarizationStepLabel(state.diarizationStep, t);
      if (step !== null) {
        head += ` · ${step}`;
      }
      if (state.diarizationCompleted !== null && state.diarizationTotal !== null) {
        head += ` ${state.diarizationCompleted.toLocaleString()}/${state.diarizationTotal.toLocaleString()}`;
      }
      break;
    }
    case "loading":
      break;
    default:
      assertNever(state.stage);
  }
  const statusText =
    remainingMs === null ? head : `${head} · ${etaLabel(remainingMs, t)}`;
  return { elapsedMs, percent, statusText };
}
