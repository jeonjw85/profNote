import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./Editor.module.css";
import {
    SpeakerDataSchema,
    type Note,
    type NoteStatus,
    type SpeakerData,
} from "../types";
import type { NotePatch } from "../services/db";
import {
    buildTranscriptText,
    formatTimestamp,
    summarizeSpeakers,
} from "../services/transcript";

interface EditorProps {
    note: Note;
    onPatch: (patch: NotePatch) => void;
    onDelete: () => void;
}

const EDIT_DEBOUNCE_MS = 400;
const DELETE_CONFIRM_RESET_MS = 3000;

type EditorTab = "transcript" | "summary";

function parseSpeakerData(raw: string): SpeakerData | null {
    if (raw.length === 0) {
        return null;
    }
    try {
        return SpeakerDataSchema.parse(JSON.parse(raw));
    } catch {
        return null;
    }
}

function bodyPlaceholder(status: NoteStatus, editingSummary: boolean): string {
    if (status === "transcribing") {
        return "전사 중입니다 / 모델과 음성 길이에 따라 몇 분 걸릴 수 있어요";
    }
    if (status === "summarizing") {
        return "요약을 생성하는 중입니다";
    }
    if (status === "error") {
        return "처리 중 오류가 발생했습니다";
    }
    return editingSummary
        ? "요약이 여기에 표시됩니다"
        : "전사 내용이 여기에 표시됩니다";
}

const STATUS_TEXT: Record<NoteStatus, string> = {
    recording: "녹음 중",
    transcribing: "전사 중",
    summarizing: "요약 중",
    ready: "완료",
    error: "처리 실패",
};

export function Editor({ note, onPatch, onDelete }: EditorProps) {
    const [title, setTitle] = useState(note.title);
    const [summary, setSummary] = useState(note.summary_md);
    const [transcript, setTranscript] = useState(note.transcript);
    const [preview, setPreview] = useState(true);
    const [tab, setTab] = useState<EditorTab>(
        note.summary_md.length > 0 ? "summary" : "transcript",
    );
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [professor, setProfessor] = useState(note.professor_speaker);
    const [syncedId, setSyncedId] = useState(note.id);
    const [syncedAt, setSyncedAt] = useState(note.updated_at);

    if (syncedId !== note.id) {
        setSyncedId(note.id);
        setTab(note.summary_md.length > 0 ? "summary" : "transcript");
        setPreview(true);
    }
    if (syncedAt !== note.updated_at) {
        setSyncedAt(note.updated_at);
        setTitle(note.title);
        setSummary(note.summary_md);
        setTranscript(note.transcript);
        setProfessor(note.professor_speaker);
        setConfirmingDelete(false);
    }

    const speakerData = useMemo(
        () => parseSpeakerData(note.segments_json),
        [note.segments_json],
    );
    const speakerOptions = speakerData
        ? summarizeSpeakers(speakerData.speakers)
        : [];

    useEffect(() => {
        if (!confirmingDelete) {
            return;
        }
        const timer = setTimeout(
            () => setConfirmingDelete(false),
            DELETE_CONFIRM_RESET_MS,
        );
        return () => clearTimeout(timer);
    }, [confirmingDelete]);

    useEffect(() => {
        const timer = setTimeout(() => {
            const patch: NotePatch = {};
            if (title !== note.title) patch.title = title;
            if (summary !== note.summary_md) patch.summary_md = summary;
            if (transcript !== note.transcript) patch.transcript = transcript;
            if (Object.keys(patch).length > 0) {
                onPatch(patch);
            }
        }, EDIT_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [
        title,
        summary,
        transcript,
        note.title,
        note.summary_md,
        note.transcript,
        onPatch,
    ]);

    const handleDelete = () => {
        if (confirmingDelete) {
            onDelete();
            return;
        }
        setConfirmingDelete(true);
    };

    const handleProfessorChange = (speaker: string) => {
        if (!speakerData || speaker === professor) {
            return;
        }
        setProfessor(speaker);
        const rebuilt = buildTranscriptText(
            speakerData.transcript,
            speakerData.speakers,
            speaker,
        );
        onPatch({
            transcript: rebuilt,
            professor_speaker: speaker,
            summary_md: "",
        });
    };

    return (
        <div className={styles.editor}>
            <header className={styles.header}>
                <input
                    className={styles.titleInput}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="제목 없는 강의"
                    aria-label="노트 제목"
                />
                <div className={styles.actions}>
                    {speakerOptions.length >= 2 && (
                        <label className={styles.speakerPicker}>
                            교수님
                            <select
                                value={professor ?? ""}
                                onChange={(event) =>
                                    handleProfessorChange(event.target.value)
                                }
                                aria-label="교수님 화자 선택"
                            >
                                {speakerOptions.map((option) => (
                                    <option
                                        key={option.speaker}
                                        value={option.speaker}
                                    >
                                        {option.speaker} ·{" "}
                                        {formatTimestamp(option.durationMs)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    <span className={styles.status} data-status={note.status}>
                        {STATUS_TEXT[note.status]}
                    </span>
                    <button
                        type="button"
                        onClick={() => setPreview((value) => !value)}
                    >
                        {preview ? "편집" : "미리보기"}
                    </button>
                    <button
                        type="button"
                        className={styles.danger}
                        data-confirm={confirmingDelete || undefined}
                        onClick={handleDelete}
                    >
                        {confirmingDelete ? "정말 삭제할까요?" : "삭제"}
                    </button>
                </div>
            </header>
            <div className={styles.tabs}>
                <button
                    type="button"
                    data-active={tab === "transcript" || undefined}
                    onClick={() => setTab("transcript")}
                >
                    원문
                </button>
                <button
                    type="button"
                    data-active={tab === "summary" || undefined}
                    onClick={() => setTab("summary")}
                >
                    요약
                </button>
            </div>
            <div className={styles.body}>
                {preview ? (
                    tab === "summary" ? (
                        <div className={styles.preview}>
                            {note.summary_md.length > 0 ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {note.summary_md}
                                </ReactMarkdown>
                            ) : (
                                <p className={styles.placeholder}>
                                    요약이 아직 없습니다.
                                </p>
                            )}
                        </div>
                    ) : (
                        <div className={styles.preview}>
                            {note.transcript.length > 0 ? (
                                <p className={styles.transcriptText}>
                                    {note.transcript}
                                </p>
                            ) : (
                                <p className={styles.placeholder}>
                                    전사 내용이 아직 없습니다.
                                </p>
                            )}
                        </div>
                    )
                ) : (
                    <textarea
                        className={styles.textarea}
                        value={tab === "summary" ? summary : transcript}
                        onChange={(event) =>
                            tab === "summary"
                                ? setSummary(event.target.value)
                                : setTranscript(event.target.value)
                        }
                        placeholder={bodyPlaceholder(
                            note.status,
                            tab === "summary",
                        )}
                        aria-label="노트 본문"
                    />
                )}
            </div>
        </div>
    );
}
