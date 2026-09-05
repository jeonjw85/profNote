import { useCallback, useState } from "react";
import { useI18n } from "../i18n/context";
import {
  getDiarizerStatus,
  runDiarization,
  transcribeAudio,
  writeMarkdown,
} from "../services/audio";
import { insertNote, updateNoteFields } from "../services/db";
import { toMessage } from "../services/errors";
import { summarizeTranscript } from "../services/openai";
import {
  buildTranscriptText,
  defaultNoteTitle,
  pickProfessorSpeaker,
  renderMarkdownDocument,
} from "../services/transcript";
import type {
  Note,
  PipelineStage,
  RecordingStopped,
  Settings,
  SpeakerSegment,
} from "../types";

export type { PipelineStage };

export interface PipelineState {
  noteId: string;
  stage: PipelineStage;
  percent: number | null;
  charsReceived: number | null;
  audioDurationMs: number;
  pipelineStartedAtMs: number;
  stageStartedAtMs: number;
}

interface PipelineOptions {
  settings: Settings;
  onNotesChanged: () => Promise<void>;
  onNoteCreated: (noteId: string) => void;
}

export function usePipeline({ settings, onNotesChanged, onNoteCreated }: PipelineOptions) {
  const { t } = useI18n();
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const run = useCallback(
    async (capture: RecordingStopped, titleHint?: string) => {
      setFailure(null);
      setWarning(null);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const note: Note = {
        id,
        title: titleHint?.trim() || defaultNoteTitle(new Date(), settings.uiLanguage),
        transcript: "",
        summary_md: "",
        audio_path: capture.wavPath,
        status: "transcribing",
        created_at: now,
        updated_at: now,
        segments_json: "",
        professor_speaker: null,
      };
      const pipelineStartedAtMs = Date.now();
      const audioDurationMs = capture.durationMs;
      const enterStage = (
        stage: PipelineStage,
        extra: Partial<Pick<PipelineState, "percent" | "charsReceived">> = {},
      ): PipelineState => ({
        noteId: id,
        stage,
        percent: extra.percent ?? null,
        charsReceived: extra.charsReceived ?? null,
        audioDurationMs,
        pipelineStartedAtMs,
        stageStartedAtMs: Date.now(),
      });
      try {
        await insertNote(note);
        await onNotesChanged();
        onNoteCreated(id);

        let speakers: SpeakerSegment[] = [];
        if (settings.enableDiarization) {
          if (!settings.huggingFaceToken.trim()) {
            setWarning(t("pipeline.skip.token"));
          } else {
            const engine = await getDiarizerStatus();
            if (!engine.ready) {
              setWarning(t("pipeline.skip.engine"));
            } else {
              setPipeline(enterStage("diarizing"));
              try {
                speakers = await runDiarization(
                  capture.wavPath,
                  settings.huggingFaceToken.trim()
                );
              } catch (caught) {
                console.warn("diarization skipped:", toMessage(caught));
                setWarning(
                  t("pipeline.skip.reason", { reason: toMessage(caught) })
                );
              }
            }
          }
        }

        setPipeline(enterStage("loading"));
        const transcript = await transcribeAudio(
          capture.wavPath,
          settings.whisperModel,
          settings.whisperLanguage,
          (event) => {
            if (event.type === "loading" || event.type === "started") {
              setPipeline((current) => ({
                ...enterStage("loading"),
                stageStartedAtMs:
                  current?.stage === "loading"
                    ? current.stageStartedAtMs
                    : Date.now(),
              }));
            } else if (event.type === "progress") {
              setPipeline((current) => ({
                ...enterStage("transcribing", { percent: event.percent }),
                stageStartedAtMs:
                  current?.stage === "transcribing"
                    ? current.stageStartedAtMs
                    : Date.now(),
              }));
            }
          }
        );
        const professorSpeaker =
          speakers.length >= 2 ? pickProfessorSpeaker(speakers) : null;
        const transcriptText = buildTranscriptText(
          transcript.segments,
          speakers,
          professorSpeaker
        );
        const segmentsJson =
          speakers.length > 0
            ? JSON.stringify({ transcript: transcript.segments, speakers })
            : "";
        const summaryEnabled =
          settings.enableSummary &&
          (settings.openaiApiKey.trim().length > 0 ||
            settings.llmBaseUrl.trim().length > 0);
        await updateNoteFields(id, {
          transcript: transcriptText,
          segments_json: segmentsJson,
          professor_speaker: professorSpeaker,
          status: summaryEnabled ? "summarizing" : "ready",
        });
        await onNotesChanged();

        if (summaryEnabled) {
          setPipeline(enterStage("summarizing", { charsReceived: 0 }));
          const summary = await summarizeTranscript(
            settings.openaiApiKey.trim(),
            { baseUrl: settings.llmBaseUrl, model: settings.llmModel },
            transcriptText,
            settings.summaryLanguage,
            (receivedChars) =>
              setPipeline((current) => ({
                ...enterStage("summarizing", { charsReceived: receivedChars }),
                stageStartedAtMs:
                  current?.stage === "summarizing"
                    ? current.stageStartedAtMs
                    : Date.now(),
              }))
          );
          await updateNoteFields(id, { summary_md: summary, status: "ready" });
          await onNotesChanged();
          try {
            await writeMarkdown(`note_${id.slice(0, 8)}`, renderMarkdownDocument(note.title, summary));
          } catch (caught) {
            setWarning(
              t("pipeline.markdownFail", { reason: toMessage(caught) })
            );
          }
        }
        setPipeline(null);
      } catch (caught) {
        setPipeline(null);
        setFailure(toMessage(caught));
        try {
          await updateNoteFields(id, { status: "error" });
          await onNotesChanged();
        } catch {
          setFailure((current) => current ?? toMessage(caught));
        }
      }
    },
    [settings, onNotesChanged, onNoteCreated, t]
  );

  const regenerateSummary = useCallback(
    async (note: Note) => {
      if (pipeline !== null) {
        return;
      }
      if (note.transcript.length === 0) {
        setFailure(null);
        setWarning(t("pipeline.noTranscript"));
        return;
      }
      if (
        settings.openaiApiKey.trim().length === 0 &&
        settings.llmBaseUrl.trim().length === 0
      ) {
        setFailure(null);
        setWarning(t("pipeline.noLlm"));
        return;
      }

      setFailure(null);
      setWarning(null);
      const pipelineStartedAtMs = Date.now();
      const enterStage = (
        extra: Partial<Pick<PipelineState, "percent" | "charsReceived">> = {},
      ): PipelineState => ({
        noteId: note.id,
        stage: "summarizing",
        percent: extra.percent ?? null,
        charsReceived: extra.charsReceived ?? null,
        audioDurationMs: 0,
        pipelineStartedAtMs,
        stageStartedAtMs: Date.now(),
      });
      setPipeline(enterStage({ charsReceived: 0 }));
      try {
        await updateNoteFields(note.id, { status: "summarizing" });
        await onNotesChanged();
        const summary = await summarizeTranscript(
          settings.openaiApiKey.trim(),
          { baseUrl: settings.llmBaseUrl, model: settings.llmModel },
          note.transcript,
          settings.summaryLanguage,
          (receivedChars) =>
            setPipeline((current) => ({
              ...enterStage({ charsReceived: receivedChars }),
              stageStartedAtMs:
                current?.stage === "summarizing"
                  ? current.stageStartedAtMs
                  : Date.now(),
            }))
        );
        await updateNoteFields(note.id, { summary_md: summary, status: "ready" });
        await onNotesChanged();
        try {
          await writeMarkdown(
            `note_${note.id.slice(0, 8)}`,
            renderMarkdownDocument(note.title, summary)
          );
        } catch (caught) {
          setWarning(
            t("pipeline.markdownFail", { reason: toMessage(caught) })
          );
        }
        setPipeline(null);
      } catch (caught) {
        setPipeline(null);
        setFailure(toMessage(caught));
        try {
          await updateNoteFields(note.id, { status: "ready" });
          await onNotesChanged();
        } catch {
          setFailure((current) => current ?? toMessage(caught));
        }
      }
    },
    [pipeline, settings, onNotesChanged, t]
  );

  const clearFailure = useCallback(() => setFailure(null), []);
  const clearWarning = useCallback(() => setWarning(null), []);

  return {
    pipeline,
    failure,
    clearFailure,
    warning,
    clearWarning,
    run,
    regenerateSummary,
  };
}
