import { useCallback, useRef, useState } from "react";
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
  diarizationStep: string | null;
  diarizationCompleted: number | null;
  diarizationTotal: number | null;
  summaryCompletedRequests: number | null;
  summaryTotalRequests: number | null;
  audioDurationMs: number;
  pipelineStartedAtMs: number;
  stageStartedAtMs: number;
}

export interface PipelinePreview {
  noteId: string;
  transcript: string | null;
  summary: string | null;
}

interface PipelineOptions {
  settings: Settings;
  onNotesChanged: () => Promise<void>;
  onNoteCreated: (noteId: string) => void;
}

export function usePipeline({ settings, onNotesChanged, onNoteCreated }: PipelineOptions) {
  const { t } = useI18n();
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [preview, setPreview] = useState<PipelinePreview | null>(null);
  const runningRef = useRef(false);
  const reportSummaryProgress = useCallback(
    (noteId: string, receivedChars: number, completedRequests: number, totalRequests: number) => {
      setPipeline((current) => current?.noteId !== noteId || current.stage !== "summarizing" ? current : {
        ...current,
        charsReceived: receivedChars,
        summaryCompletedRequests: completedRequests,
        summaryTotalRequests: totalRequests,
      });
    },
    []
  );
  const reportSummaryContent = useCallback((noteId: string, summary: string) => {
    setPreview((current) => current?.noteId !== noteId ? current : { ...current, summary });
  }, []);
  const [failure, setFailure] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const run = useCallback(
    async (capture: RecordingStopped, titleHint?: string) => {
      if (runningRef.current) {
        return;
      }
      runningRef.current = true;
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
        diarizationStep: null,
        diarizationCompleted: null,
        diarizationTotal: null,
        summaryCompletedRequests: null,
        summaryTotalRequests: null,
        audioDurationMs,
        pipelineStartedAtMs,
        stageStartedAtMs: Date.now(),
      });
      setPipeline(enterStage("loading"));
      setPreview({ noteId: id, transcript: "", summary: null });
      let transcriptSaved = false;
      try {
        await insertNote(note);
        await onNotesChanged();
        onNoteCreated(id);

        setPipeline(enterStage("loading"));
        const transcript = await transcribeAudio(
          capture.wavPath,
          settings.whisperModel,
          settings.whisperLanguage,
          (event) => {
            if (event.type === "segments") {
              const addition = buildTranscriptText(event.segments, [], null);
              if (addition.length > 0) {
                setPreview((current) => current?.noteId !== id ? current : {
                  ...current,
                  transcript: [current.transcript, addition].filter(Boolean).join("\n"),
                });
              }
            } else if (event.type === "started") {
              setPipeline((current) => current?.noteId !== id
                ? current
                : enterStage("transcribing", { percent: 0 }));
            } else if (event.type === "loading") {
              setPipeline((current) => current?.noteId !== id ? current : ({
                ...enterStage("loading"),
                stageStartedAtMs:
                  current?.stage === "loading"
                    ? current.stageStartedAtMs
                    : Date.now(),
              }));
            } else if (event.type === "progress") {
              setPipeline((current) => current?.noteId !== id ? current : ({
                ...enterStage("transcribing", { percent: event.percent }),
                stageStartedAtMs:
                  current?.stage === "transcribing"
                    ? current.stageStartedAtMs
                    : Date.now(),
              }));
            }
          }
        );
        const unfilteredTranscript = buildTranscriptText(transcript.segments, [], null);
        setPreview({
          noteId: id,
          transcript: unfilteredTranscript,
          summary: null,
        });
        await updateNoteFields(id, { transcript: unfilteredTranscript });
        transcriptSaved = true;

        let speakers: SpeakerSegment[] = [];
        if (settings.enableDiarization) {
          if (!settings.huggingFaceToken.trim()) {
            setWarning(t("pipeline.skip.token"));
          } else {
            try {
              const engine = await getDiarizerStatus();
              if (!engine.ready) {
                setWarning(t("pipeline.skip.engine"));
              } else {
                setPipeline(enterStage("diarizing"));
                speakers = await runDiarization(
                  capture.wavPath,
                  settings.huggingFaceToken.trim(),
                  (event) => setPipeline((current) => {
                    if (current?.noteId !== id || current.stage !== "diarizing") {
                      return current;
                    }
                    return {
                      ...current,
                      diarizationStep: event.name,
                      diarizationCompleted: event.type === "progress" ? event.completed : null,
                      diarizationTotal: event.type === "progress" ? event.total : null,
                    };
                  })
                );
              }
            } catch (caught) {
              console.warn("diarization skipped:", toMessage(caught));
              setWarning(
                t("pipeline.skip.reason", { reason: toMessage(caught) })
              );
            }
          }
        }

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
        transcriptSaved = true;
        setPreview({ noteId: id, transcript: null, summary: summaryEnabled ? "" : null });
        await onNotesChanged();

        if (summaryEnabled) {
          setPipeline(enterStage("summarizing", { charsReceived: 0 }));
          const summary = await summarizeTranscript(
            settings.openaiApiKey.trim(),
            { baseUrl: settings.llmBaseUrl, model: settings.llmModel },
            transcriptText,
            settings.summaryLanguage,
            (chars, completed, total) => reportSummaryProgress(id, chars, completed, total),
            (content) => reportSummaryContent(id, content)
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
      } catch (caught) {
        setFailure(toMessage(caught));
        try {
          await updateNoteFields(id, { status: transcriptSaved ? "ready" : "error" });
          await onNotesChanged();
        } catch {
          setFailure((current) => current ?? toMessage(caught));
        }
      } finally {
        runningRef.current = false;
        setPreview(null);
        setPipeline(null);
      }
    },
    [settings, onNotesChanged, onNoteCreated, t, reportSummaryProgress, reportSummaryContent]
  );

  const regenerateSummary = useCallback(
    async (note: Note) => {
      if (runningRef.current) {
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
        diarizationStep: null,
        diarizationCompleted: null,
        diarizationTotal: null,
        summaryCompletedRequests: null,
        summaryTotalRequests: null,
        audioDurationMs: 0,
        pipelineStartedAtMs,
        stageStartedAtMs: Date.now(),
      });
      runningRef.current = true;
      setPreview({ noteId: note.id, transcript: null, summary: "" });
      setPipeline(enterStage({ charsReceived: 0 }));
      try {
        await updateNoteFields(note.id, { status: "summarizing" });
        await onNotesChanged();
        const summary = await summarizeTranscript(
          settings.openaiApiKey.trim(),
          { baseUrl: settings.llmBaseUrl, model: settings.llmModel },
          note.transcript,
          settings.summaryLanguage,
          (chars, completed, total) => reportSummaryProgress(note.id, chars, completed, total),
          (content) => reportSummaryContent(note.id, content)
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
      } catch (caught) {
        setFailure(toMessage(caught));
        try {
          await updateNoteFields(note.id, { status: "ready" });
          await onNotesChanged();
        } catch {
          setFailure((current) => current ?? toMessage(caught));
        }
      } finally {
        runningRef.current = false;
        setPreview(null);
        setPipeline(null);
      }
    },
    [settings, onNotesChanged, t, reportSummaryProgress, reportSummaryContent]
  );

  const clearFailure = useCallback(() => setFailure(null), []);
  const clearWarning = useCallback(() => setWarning(null), []);

  return {
    pipeline,
    preview,
    failure,
    clearFailure,
    warning,
    clearWarning,
    run,
    regenerateSummary,
  };
}
