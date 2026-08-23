import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./App.module.css";
import { Editor } from "./components/Editor";
import { NoteList } from "./components/NoteList";
import { RecordBar } from "./components/RecordBar";
import { SettingsModal } from "./components/SettingsModal";
import { Toast } from "./components/Toast";
import { useNotes } from "./hooks/useNotes";
import { usePipeline, type PipelineStage } from "./hooks/usePipeline";
import { useRecorder } from "./hooks/useRecorder";
import {
    downloadModel,
    fileNameWithoutExtension,
    getDiarizerStatus,
    getModelStatus,
    importAudio,
    isImportableAudioPath,
    prepareDiarizer,
} from "./services/audio";
import { fetchSettings, saveSettings } from "./services/db";
import { toMessage } from "./services/errors";
import { checkForUpdate, installPendingUpdate } from "./services/updater";
import type { DownloadProgress, Settings } from "./types";

type UpdateState =
    | { status: "available"; version: string }
    | { status: "installing"; percent: number | null }
    | null;

const DEFAULT_SETTINGS: Settings = {
    openaiApiKey: "",
    llmBaseUrl: "",
    llmModel: "",
    whisperModel: "medium",
    whisperLanguage: "ko",
    huggingFaceToken: "",
    enableDiarization: true,
    enableSummary: true,
};

const STAGE_TEXT: Record<PipelineStage, string> = {
    diarizing: "화자 분리 단계 | 음성 길이에 따라 몇 분 걸릴 수 있어요",
    transcribing: "로컬 전사 단계",
    summarizing: "요약 생성 단계",
};

function assertNever(value: never): never {
    throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

function GearIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

export default function App() {
    const {
        notes,
        selectedId,
        setSelectedId,
        loadError,
        refresh,
        patchNote,
        removeNote,
    } = useNotes();
    const [settings, setSettings] = useState<Settings | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [modelInstalled, setModelInstalled] = useState<boolean | null>(null);
    const [download, setDownload] = useState<DownloadProgress | null>(null);
    const [diarizerReady, setDiarizerReady] = useState(false);
    const [diarizerInstalling, setDiarizerInstalling] = useState(false);
    const [diarizerProgress, setDiarizerProgress] = useState<string | null>(
        null,
    );
    const [appError, setAppError] = useState<string | null>(null);
    const [update, setUpdate] = useState<UpdateState>(null);
    const [dropActive, setDropActive] = useState(false);

    const pipeline = usePipeline({
        settings: settings ?? DEFAULT_SETTINGS,
        onNotesChanged: refresh,
        onNoteCreated: setSelectedId,
    });
    const recorder = useRecorder(pipeline.run);
    const importGuardRef = useRef({
        recorderStatus: recorder.status,
        pipelineBusy: pipeline.pipeline !== null,
        modelInstalled,
        run: pipeline.run,
    });

    useEffect(() => {
        importGuardRef.current = {
            recorderStatus: recorder.status,
            pipelineBusy: pipeline.pipeline !== null,
            modelInstalled,
            run: pipeline.run,
        };
    }, [recorder.status, pipeline.pipeline, modelInstalled, pipeline.run]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        void getCurrentWebview()
            .onDragDropEvent((event) => {
                const payload = event.payload;
                switch (payload.type) {
                    case "enter":
                    case "over":
                        setDropActive(true);
                        return;
                    case "leave":
                        setDropActive(false);
                        return;
                    case "drop": {
                        setDropActive(false);
                        const guard = importGuardRef.current;
                        if (
                            guard.recorderStatus !== "idle" ||
                            guard.pipelineBusy ||
                            guard.modelInstalled === false
                        ) {
                            return;
                        }
                        const path = payload.paths.find(isImportableAudioPath);
                        if (path === undefined) {
                            setAppError("지원하지 않는 오디오 형식입니다");
                            return;
                        }
                        void (async () => {
                            try {
                                await guard.run(
                                    await importAudio(path),
                                    fileNameWithoutExtension(path),
                                );
                            } catch (caught) {
                                setAppError(toMessage(caught));
                            }
                        })();
                        return;
                    }
                    default:
                        assertNever(payload);
                }
            })
            .then((fn) => {
                if (cancelled) {
                    fn();
                    return;
                }
                unlisten = fn;
            })
            .catch((caught) => {
                setAppError(toMessage(caught));
            });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        fetchSettings()
            .then(setSettings)
            .catch((caught) => setAppError(toMessage(caught)));
    }, []);

    useEffect(() => {
        checkForUpdate()
            .then((found) => {
                if (found) {
                    setUpdate({ status: "available", version: found.version });
                }
            })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!settings) {
            return;
        }
        getModelStatus(settings.whisperModel)
            .then((status) => setModelInstalled(status.installed))
            .catch((caught) => setAppError(toMessage(caught)));
        getDiarizerStatus()
            .then((status) => setDiarizerReady(status.ready))
            .catch((caught) => setAppError(toMessage(caught)));
    }, [settings]);

    const handleDownloadModel = useCallback(async () => {
        if (!settings || download) {
            return;
        }
        setDownload({ downloadedBytes: 0, totalBytes: null });
        try {
            await downloadModel(settings.whisperModel, (event) => {
                if (event.type === "progress") {
                    setDownload({
                        downloadedBytes: event.downloadedBytes,
                        totalBytes: event.totalBytes,
                    });
                }
            });
            setModelInstalled(true);
        } catch (caught) {
            setAppError(toMessage(caught));
        } finally {
            setDownload(null);
        }
    }, [settings, download]);

    const handleSaveSettings = useCallback(async (next: Settings) => {
        await saveSettings(next);
        setSettings(next);
    }, []);

    const handleInstallDiarizer = useCallback(async () => {
        if (diarizerInstalling) {
            return;
        }
        setDiarizerInstalling(true);
        setDiarizerProgress("엔진 설치 중");
        try {
            await prepareDiarizer((event) => {
                if (event.type === "stage") {
                    setDiarizerProgress(
                        event.name === "uv"
                            ? "런타임 다운로드 중"
                            : "화자 분리 엔진 설치 중",
                    );
                } else if (event.type === "progress") {
                    if (event.totalBytes === null) {
                        return;
                    }
                    const percent = Math.min(
                        100,
                        Math.round(
                            (event.downloadedBytes / event.totalBytes) * 100,
                        ),
                    );
                    setDiarizerProgress(`런타임 다운로드 중 ${percent}%`);
                }
            });
            setDiarizerReady(true);
        } catch (caught) {
            setAppError(toMessage(caught));
        } finally {
            setDiarizerInstalling(false);
            setDiarizerProgress(null);
        }
    }, [diarizerInstalling]);

    const handleInstallUpdate = useCallback(async () => {
        setUpdate({ status: "installing", percent: null });
        try {
            await installPendingUpdate((downloadedBytes, totalBytes) => {
                const percent =
                    totalBytes === null
                        ? null
                        : Math.min(
                              100,
                              Math.round((downloadedBytes / totalBytes) * 100),
                          );
                setUpdate({ status: "installing", percent });
            });
        } catch (caught) {
            setUpdate(null);
            setAppError(toMessage(caught));
        }
    }, []);

    if (!settings) {
        return (
            <div className={styles.loading}>{appError ?? "불러오는 중"}</div>
        );
    }

    const selectedNote = notes.find((note) => note.id === selectedId) ?? null;

    let toast: {
        tone: "info" | "error";
        text: string;
        dismiss?: () => void;
    } | null = null;
    if (pipeline.failure) {
        toast = {
            tone: "error",
            text: pipeline.failure,
            dismiss: pipeline.clearFailure,
        };
    } else if (loadError ?? appError) {
        toast = { tone: "error", text: loadError ?? appError ?? "" };
    } else if (pipeline.warning) {
        toast = {
            tone: "info",
            text: pipeline.warning,
            dismiss: pipeline.clearWarning,
        };
    } else if (pipeline.pipeline) {
        const { stage, percent, charsReceived } = pipeline.pipeline;
        let suffix = "";
        if (stage === "transcribing") {
            suffix =
                percent === null || percent === 0
                    ? " (모델을 불러오는 중)"
                    : ` ${percent}%`;
        } else if (stage === "summarizing" && charsReceived !== null) {
            suffix = ` ${charsReceived.toLocaleString()}자`;
        }
        toast = { tone: "info", text: `${STAGE_TEXT[stage]}${suffix}` };
    } else if (update?.status === "available") {
        toast = {
            tone: "info",
            text: `v${update.version} 업데이트 가능 | 클릭해서 설치`,
            dismiss: () => void handleInstallUpdate(),
        };
    } else if (update?.status === "installing") {
        toast = {
            tone: "info",
            text:
                update.percent === null
                    ? "업데이트 다운로드 중"
                    : `업데이트 설치 중 ${update.percent}%`,
        };
    }

    return (
        <div className={styles.app}>
            <aside className={styles.sidebar}>
                <header className={styles.brandRow}>
                    <span className={styles.brand}>profNote</span>
                    <button
                        type="button"
                        className={styles.settingsButton}
                        onClick={() => setSettingsOpen(true)}
                        aria-label="설정"
                    >
                        <GearIcon />
                    </button>
                </header>
                <NoteList
                    notes={notes}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />
                <RecordBar
                    recorderStatus={recorder.status}
                    elapsedMs={recorder.elapsedMs}
                    recorderError={recorder.error}
                    modelReady={modelInstalled === true}
                    modelName={settings.whisperModel}
                    download={download}
                    onStart={() => void recorder.start()}
                    onStop={() => void recorder.stop()}
                    onDownloadModel={() => void handleDownloadModel()}
                    onDismissError={recorder.dismissError}
                />
            </aside>
            <main className={styles.main}>
                {selectedNote ? (
                    <Editor
                        note={selectedNote}
                        onPatch={(patch) =>
                            void patchNote(selectedNote.id, patch)
                        }
                        onDelete={() => void removeNote(selectedNote.id)}
                        onRegenerateSummary={() =>
                            void pipeline.regenerateSummary(selectedNote)
                        }
                        regenerating={
                            pipeline.pipeline?.stage === "summarizing" &&
                            pipeline.pipeline.noteId === selectedNote.id
                        }
                        pipelineActive={pipeline.pipeline !== null}
                    />
                ) : (
                    <div className={styles.empty}>
                        <p>
                            강의를 녹음하면 전사와 요약이 자동으로 여기에
                            표시됩니다
                        </p>
                    </div>
                )}
            </main>
            {settingsOpen && (
                <SettingsModal
                    settings={settings}
                    onSave={handleSaveSettings}
                    onClose={() => setSettingsOpen(false)}
                    diarizerReady={diarizerReady}
                    diarizerInstalling={diarizerInstalling}
                    diarizerProgress={diarizerProgress}
                    onInstallDiarizer={() => void handleInstallDiarizer()}
                />
            )}
            {toast && (
                <Toast tone={toast.tone} onDismiss={toast.dismiss}>
                    {toast.text}
                </Toast>
            )}
            {dropActive && (
                <div className={styles.dropOverlay} role="status">
                    <div className={styles.dropOverlayFrame}>
                        오디오 파일을 놓아서 가져오기
                    </div>
                </div>
            )}
        </div>
    );
}
