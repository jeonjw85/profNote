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
import type { Note, RecordingStopped, Settings, SpeakerSegment } from "../types";

export type PipelineStage = "diarizing" | "loading" | "transcribing" | "summarizing";

export interface PipelineState {
  noteId: string;
  stage: PipelineStage;
  percent: number | null;
  charsReceived: number | null;
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
              setPipeline({
                noteId: id,
                stage: "diarizing",
                percent: null,
                charsReceived: null,
              });
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

        setPipeline({
          noteId: id,
          stage: "loading",
          percent: null,
          charsReceived: null,
        });
        const transcript = await transcribeAudio(
          capture.wavPath,
          settings.whisperModel,
          settings.whisperLanguage,
          (event) => {
            if (event.type === "loading" || event.type === "started") {
              setPipeline({
                noteId: id,
                stage: "loading",
                percent: null,
                charsReceived: null,
              });
            } else if (event.type === "progress") {
              setPipeline({
                noteId: id,
                stage: "transcribing",
                percent: event.percent,
                charsReceived: null,
              });
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
          setPipeline({
            noteId: id,
            stage: "summarizing",
            percent: null,
            charsReceived: 0,
          });
          const summary = await summarizeTranscript(
            settings.openaiApiKey.trim(),
            { baseUrl: settings.llmBaseUrl, model: settings.llmModel },
            transcriptText,
            settings.summaryLanguage,
            (receivedChars) =>
              setPipeline({
                noteId: id,
                stage: "summarizing",
                percent: null,
                charsReceived: receivedChars,
              })
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
      setPipeline({
        noteId: note.id,
        stage: "summarizing",
        percent: null,
        charsReceived: 0,
      });
      try {
        await updateNoteFields(note.id, { status: "summarizing" });
        await onNotesChanged();
        const summary = await summarizeTranscript(
          settings.openaiApiKey.trim(),
          { baseUrl: settings.llmBaseUrl, model: settings.llmModel },
          note.transcript,
          settings.summaryLanguage,
          (receivedChars) =>
            setPipeline({
              noteId: note.id,
              stage: "summarizing",
              percent: null,
              charsReceived: receivedChars,
            })
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
