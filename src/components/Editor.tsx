import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./Editor.module.css";
import {
    SpeakerDataSchema,
    type Note,
    type NoteStatus,
    type SpeakerData,
} from "../types";
import { audioSrc } from "../services/audio";
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
    onRegenerateSummary: () => void;
    regenerating: boolean;
    pipelineActive: boolean;
}

const TIMESTAMP_PREFIX = /^\[(\d{2,}:\d{2}:\d{2}|\d{2}:\d{2})\](?: |$)/;

type TranscriptBlock =
    | { kind: "timed"; stamp: string; seconds: number; text: string }
    | { kind: "plain"; text: string };

function timestampToSeconds(stamp: string): number {
    const parts = stamp.split(":").map(Number);
    if (parts.length === 3) {
        const [hours, minutes, seconds] = parts;
        return hours * 3600 + minutes * 60 + seconds;
    }
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
}

function parseTranscriptBlocks(transcript: string): TranscriptBlock[] {
    return transcript.split("\n").map((line) => {
        const match = TIMESTAMP_PREFIX.exec(line);
        if (match === null || match[1] === undefined) {
            return { kind: "plain", text: line };
        }
        return {
            kind: "timed",
            stamp: match[1],
            seconds: timestampToSeconds(match[1]),
            text: line.slice(match[0].length),
        };
    });
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

export function Editor({
    note,
    onPatch,
    onDelete,
    onRegenerateSummary,
    regenerating,
    pipelineActive,
}: EditorProps) {
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
    const [syncedValues, setSyncedValues] = useState({
        title: note.title,
        summary: note.summary_md,
        transcript: note.transcript,
        professor: note.professor_speaker,
    });
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [audioFailed, setAudioFailed] = useState(false);
    const audioRef = useRef<HTMLAudioElement>(null);

    if (syncedId !== note.id) {
        setSyncedId(note.id);
        setSyncedAt(note.updated_at);
        setSyncedValues({
            title: note.title,
            summary: note.summary_md,
            transcript: note.transcript,
            professor: note.professor_speaker,
        });
        setTitle(note.title);
        setSummary(note.summary_md);
        setTranscript(note.transcript);
        setProfessor(note.professor_speaker);
        setConfirmingDelete(false);
        setTab(note.summary_md.length > 0 ? "summary" : "transcript");
        setPreview(true);
        setPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setAudioFailed(false);
    }
    if (syncedAt !== note.updated_at) {
        setSyncedAt(note.updated_at);
        if (title === syncedValues.title) setTitle(note.title);
        if (summary === syncedValues.summary) setSummary(note.summary_md);
        if (transcript === syncedValues.transcript) {
            setTranscript(note.transcript);
        }
        if (professor === syncedValues.professor) {
            setProfessor(note.professor_speaker);
        }
        setSyncedValues({
            title: note.title,
            summary: note.summary_md,
            transcript: note.transcript,
            professor: note.professor_speaker,
        });
        setConfirmingDelete(false);
    }

    const speakerData = useMemo(
        () => parseSpeakerData(note.segments_json),
        [note.segments_json],
    );
    const speakerOptions = speakerData
        ? summarizeSpeakers(speakerData.speakers)
        : [];
    const transcriptBlocks = useMemo(
        () => parseTranscriptBlocks(note.transcript),
        [note.transcript],
    );
    const audioInteractive = note.audio_path !== null && !audioFailed;
    const seekable = Number.isFinite(duration) && duration > 0;

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

    const handleTogglePlay = useCallback(() => {
        const element = audioRef.current;
        if (element === null) {
            return;
        }
        if (element.paused) {
            void element.play().catch(() => {
                setAudioFailed(true);
            });
        } else {
            element.pause();
        }
    }, []);

    const handleSeekBar = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => {
            const element = audioRef.current;
            const next = Number(event.target.value);
            if (element === null || !Number.isFinite(next)) {
                return;
            }
            element.currentTime = next;
            setCurrentTime(next);
        },
        [],
    );

    const handleSeekTimestamp = useCallback((seconds: number) => {
        const element = audioRef.current;
        if (element === null) {
            return;
        }
        element.currentTime = seconds;
        setCurrentTime(seconds);
        void element.play().catch(() => {
            setAudioFailed(true);
        });
    }, []);

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
                    {note.transcript.length > 0 && (
                        <button
                            type="button"
                            disabled={
                                pipelineActive ||
                                regenerating ||
                                note.status === "transcribing"
                            }
                            onClick={onRegenerateSummary}
                        >
                            요약 재생성
                        </button>
                    )}
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
                                <div className={styles.transcriptText}>
                                    {transcriptBlocks.map((block, index) => (
                                        <span key={index}>
                                            {block.kind === "timed" ? (
                                                <>
                                                    <button
                                                        type="button"
                                                        className={
                                                            styles.timestamp
                                                        }
                                                        disabled={
                                                            !audioInteractive
                                                        }
                                                        onClick={() =>
                                                            handleSeekTimestamp(
                                                                block.seconds,
                                                            )
                                                        }
                                                    >
                                                        {block.stamp}
                                                    </button>
                                                    {block.text.length > 0
                                                        ? ` ${block.text}`
                                                        : ""}
                                                </>
                                            ) : (
                                                block.text
                                            )}
                                            {index <
                                            transcriptBlocks.length - 1
                                                ? "\n"
                                                : ""}
                                        </span>
                                    ))}
                                </div>
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
            {note.audio_path !== null && !audioFailed && (
                <div className={styles.player}>
                    <audio
                        key={note.id}
                        ref={audioRef}
                        src={audioSrc(note.audio_path)}
                        preload="metadata"
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => setPlaying(false)}
                        onTimeUpdate={(event) =>
                            setCurrentTime(event.currentTarget.currentTime)
                        }
                        onLoadedMetadata={(event) => {
                            const next = event.currentTarget.duration;
                            setDuration(Number.isFinite(next) ? next : 0);
                        }}
                        onError={() => setAudioFailed(true)}
                    />
                    <button
                        type="button"
                        onClick={handleTogglePlay}
                        aria-label={playing ? "일시정지" : "재생"}
                    >
                        {playing ? "일시정지" : "재생"}
                    </button>
                    <input
                        type="range"
                        className={styles.playerSeek}
                        min={0}
                        max={seekable ? duration : 0}
                        step={0.1}
                        value={seekable ? currentTime : 0}
                        disabled={!seekable}
                        onChange={handleSeekBar}
                        aria-label="재생 위치"
                    />
                    <span className={styles.playerTime}>
                        {formatTimestamp(
                            Number.isFinite(currentTime)
                                ? currentTime * 1000
                                : 0,
                        )}{" "}
                        /{" "}
                        {formatTimestamp(
                            Number.isFinite(duration) ? duration * 1000 : 0,
                        )}
                    </span>
                </div>
            )}
        </div>
    );
}
