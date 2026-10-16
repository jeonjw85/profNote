import { useCallback, useEffect, useRef, useState } from "react";
import { deleteAudio } from "../services/audio";
import {
  deleteNote,
  fetchNotes,
  recoverInterruptedNotes,
  updateNoteFields,
  type NotePatch,
} from "../services/db";
import { toMessage } from "../services/errors";
import { syncNoteMarkdown } from "../services/markdown";
import type { Note } from "../types";

export function useNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    try {
      const loaded = await fetchNotes();
      if (sequence !== loadSequenceRef.current) return;
      setNotes(loaded);
      setLoadError(null);
    } catch (caught) {
      if (sequence === loadSequenceRef.current) setLoadError(toMessage(caught));
    }
  }, []);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    const load = async () => {
      try {
        await recoverInterruptedNotes();
        const loaded = await fetchNotes();
        if (sequence !== loadSequenceRef.current) return;
        setNotes(loaded);
        setLoadError(null);
      } catch (caught) {
        if (sequence === loadSequenceRef.current) setLoadError(toMessage(caught));
      }
    };
    void load();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, []);

  const patchNote = useCallback(
    async (id: string, patch: NotePatch) => {
      try {
        await updateNoteFields(id, patch);
        await refresh();
        await syncNoteMarkdown(id);
      } catch (caught) {
        setLoadError(toMessage(caught));
        throw caught instanceof Error
          ? caught
          : Object.assign(new Error(toMessage(caught)), { cause: caught });
      }
    },
    [refresh]
  );

  const removeNote = useCallback(
    async (id: string) => {
      try {
        const target = notes.find((note) => note.id === id);
        await deleteNote(id);
        if (target?.audio_path) {
          await deleteAudio(target.audio_path).catch(() => undefined);
        }
        await refresh();
        setSelectedId((current) => (current === id ? null : current));
      } catch (caught) {
        setLoadError(toMessage(caught));
      }
    },
    [notes, refresh]
  );

  return {
    notes,
    selectedId,
    setSelectedId,
    loadError,
    refresh,
    patchNote,
    removeNote,
  };
}
