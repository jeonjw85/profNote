import { useCallback, useEffect, useState } from "react";
import { deleteAudio } from "../services/audio";
import {
  deleteNote,
  fetchNotes,
  recoverInterruptedNotes,
  updateNoteFields,
  type NotePatch,
} from "../services/db";
import { toMessage } from "../services/errors";
import type { Note } from "../types";

export function useNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setNotes(await fetchNotes());
      setLoadError(null);
    } catch (caught) {
      setLoadError(toMessage(caught));
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        await recoverInterruptedNotes();
        const loaded = await fetchNotes();
        setNotes(loaded);
        setLoadError(null);
      } catch (caught) {
        setLoadError(toMessage(caught));
      }
    };
    void load();
  }, []);

  const patchNote = useCallback(
    async (id: string, patch: NotePatch) => {
      try {
        await updateNoteFields(id, patch);
        await refresh();
      } catch (caught) {
        setLoadError(toMessage(caught));
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
