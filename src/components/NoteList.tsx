import { useMemo, useState } from "react";
import styles from "./NoteList.module.css";
import { useI18n } from "../i18n/context";
import type { Note, NoteStatus } from "../types";

interface NoteListProps {
  notes: Note[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function statusLabel(
  status: NoteStatus,
  t: (key: string) => string,
): string | null {
  switch (status) {
    case "recording":
      return t("notes.status.recording");
    case "transcribing":
      return t("notes.status.transcribing");
    case "summarizing":
      return t("notes.status.summarizing");
    case "ready":
      return null;
    case "error":
      return t("notes.status.error");
  }
}

function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getMonth() + 1}. ${date.getDate()}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function NoteList({ notes, selectedId, onSelect }: NoteListProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return notes;
    }
    return notes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        note.transcript.toLowerCase().includes(needle) ||
        note.summary_md.toLowerCase().includes(needle),
    );
  }, [notes, query]);

  if (notes.length === 0) {
    return <p className={styles.empty}>{t("notes.empty")}</p>;
  }

  return (
    <>
      <input
        type="search"
        className={styles.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t("notes.search")}
        placeholder={t("notes.search")}
      />
      {filtered.length === 0 ? (
        <p className={styles.empty}>{t("notes.noResults")}</p>
      ) : (
        <nav className={styles.list}>
          {filtered.map((note) => {
            const label = statusLabel(note.status, t);
            return (
              <button
                key={note.id}
                type="button"
                className={`${styles.item} ${note.id === selectedId ? styles.selected : ""}`}
                onClick={() => onSelect(note.id)}
              >
                <span className={styles.title}>{note.title}</span>
                <span className={styles.meta}>
                  <time>{formatCreated(note.created_at)}</time>
                  {label && <em className={styles.status}>{label}</em>}
                </span>
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}
