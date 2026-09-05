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
import { useI18n } from "../i18n/context";
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
    processingHint: string | null;
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

function bodyPlaceholder(
    status: NoteStatus,
    editingSummary: boolean,
    t: (key: string) => string,
): string {
    if (status === "transcribing") {
        return t("editor.placeholder.transcribing");
    }
    if (status === "summarizing") {
        return t("editor.placeholder.summarizing");
    }
    if (status === "error") {
        return t("editor.placeholder.error");
    }
    return editingSummary
        ? t("editor.placeholder.summary")
        : t("editor.placeholder.transcript");
}

export function Editor({
    note,
    onPatch,
    onDelete,
    onRegenerateSummary,
    regenerating,
    pipelineActive,
    processingHint,
}: EditorProps) {
    const { t } = useI18n();
    const statusText: Record<NoteStatus, string> = {
        recording: t("editor.status.recording"),
        transcribing: t("editor.status.transcribing"),
        summarizing: t("editor.status.summarizing"),
        ready: t("editor.status.ready"),
        error: t("editor.status.error"),
    };
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
                    placeholder={t("editor.title.placeholder")}
                    aria-label={t("editor.aria.title")}
                />
                <div className={styles.actions}>
                    {speakerOptions.length >= 2 && (
                        <label className={styles.speakerPicker}>
                            {t("editor.professor")}
                            <select
                                value={professor ?? ""}
                                onChange={(event) =>
                                    handleProfessorChange(event.target.value)
                                }
                                aria-label={t("editor.aria.professor")}
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
                        {statusText[note.status]}
                    </span>
                    <button
                        type="button"
                        onClick={() => setPreview((value) => !value)}
                    >
                        {preview ? t("editor.edit") : t("editor.preview")}
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
                            {t("editor.regenerate")}
                        </button>
                    )}
                    <button
                        type="button"
                        className={styles.danger}
                        data-confirm={confirmingDelete || undefined}
                        onClick={handleDelete}
                    >
                        {confirmingDelete
                            ? t("editor.delete.confirm")
                            : t("editor.delete")}
                    </button>
                </div>
            </header>
            <div className={styles.tabs}>
                <button
                    type="button"
                    data-active={tab === "transcript" || undefined}
                    onClick={() => setTab("transcript")}
                >
                    {t("editor.tab.transcript")}
                </button>
                <button
                    type="button"
                    data-active={tab === "summary" || undefined}
                    onClick={() => setTab("summary")}
                >
                    {t("editor.tab.summary")}
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
                                    {processingHint ??
                                        t("editor.empty.summary")}
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
                                    {processingHint ??
                                        t("editor.empty.transcript")}
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
                        placeholder={
                            processingHint ??
                            bodyPlaceholder(
                                note.status,
                                tab === "summary",
                                t,
                            )
                        }
                        aria-label={t("editor.aria.body")}
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
                        aria-label={
                            playing ? t("editor.pause") : t("editor.play")
                        }
                    >
                        {playing ? t("editor.pause") : t("editor.play")}
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
                        aria-label={t("editor.aria.seek")}
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
