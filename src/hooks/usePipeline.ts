import { useCallback, useState } from "react";
import { runDiarization, transcribeAudio, writeMarkdown } from "../services/audio";
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

export type PipelineStage = "diarizing" | "transcribing" | "summarizing";

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
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(
    async (capture: RecordingStopped) => {
      setFailure(null);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const note: Note = {
        id,
        title: defaultNoteTitle(new Date()),
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
        if (
          settings.enableDiarization &&
          settings.diarizationPython.trim() &&
          settings.diarizationScript.trim()
        ) {
          setPipeline({
            noteId: id,
            stage: "diarizing",
            percent: null,
            charsReceived: null,
          });
          try {
            speakers = await runDiarization(
              capture.wavPath,
              settings.diarizationPython.trim(),
              settings.diarizationScript.trim(),
              settings.huggingFaceToken
            );
          } catch (caught) {
            console.warn("diarization skipped:", toMessage(caught));
          }
        }

        setPipeline({
          noteId: id,
          stage: "transcribing",
          percent: 0,
          charsReceived: null,
        });
        const transcript = await transcribeAudio(
          capture.wavPath,
          settings.whisperModel,
          settings.whisperLanguage,
          (event) => {
            if (event.type === "progress") {
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
            (receivedChars) =>
              setPipeline({
                noteId: id,
                stage: "summarizing",
                percent: null,
                charsReceived: receivedChars,
              })
          );
          await writeMarkdown(`note_${id.slice(0, 8)}`, renderMarkdownDocument(note.title, summary));
          await updateNoteFields(id, { summary_md: summary, status: "ready" });
          await onNotesChanged();
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
    [settings, onNotesChanged, onNoteCreated]
  );

  const clearFailure = useCallback(() => setFailure(null), []);

  return { pipeline, failure, clearFailure, run };
}
