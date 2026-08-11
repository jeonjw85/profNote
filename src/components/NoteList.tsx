import styles from "./NoteList.module.css";
import type { Note, NoteStatus } from "../types";

interface NoteListProps {
  notes: Note[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_LABEL: Record<NoteStatus, string | null> = {
  recording: "녹음 중",
  transcribing: "전사 중",
  summarizing: "요약 중",
  ready: null,
  error: "오류",
};

function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getMonth() + 1}. ${date.getDate()}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function NoteList({ notes, selectedId, onSelect }: NoteListProps) {
  if (notes.length === 0) {
    return <p className={styles.empty}>아직 노트가 없습니다. 아래 녹음 버튼으로 시작하세요.</p>;
  }
  return (
    <nav className={styles.list}>
      {notes.map((note) => (
        <button
          key={note.id}
          type="button"
          className={`${styles.item} ${note.id === selectedId ? styles.selected : ""}`}
          onClick={() => onSelect(note.id)}
        >
          <span className={styles.title}>{note.title}</span>
          <span className={styles.meta}>
            <time>{formatCreated(note.created_at)}</time>
            {STATUS_LABEL[note.status] && (
              <em className={styles.status}>{STATUS_LABEL[note.status]}</em>
            )}
          </span>
        </button>
      ))}
    </nav>
  );
}
