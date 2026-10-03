import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./App.module.css";
import { Editor, type EditorHandle } from "./components/Editor";
import { NoteList } from "./components/NoteList";
import { RecordBar } from "./components/RecordBar";
import { SettingsModal } from "./components/SettingsModal";
import { Toast } from "./components/Toast";
import { useNotes } from "./hooks/useNotes";
import { usePipeline } from "./hooks/usePipeline";
import { useTickingNow } from "./hooks/useTickingNow";
import { useRecorder } from "./hooks/useRecorder";
import { useResources } from "./hooks/useResources";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { buildProcessingView } from "./services/pipelineEta";
import { I18nProvider } from "./i18n";
import { useI18n } from "./i18n/context";
import {
    fileNameWithoutExtension,
    importAudio,
    isImportableAudioPath,
} from "./services/audio";
import { fetchSettings, saveSettings } from "./services/db";
import { toMessage } from "./services/errors";
import type { Settings } from "./types";

const DEFAULT_SETTINGS: Settings = {
    openaiApiKey: "",
    llmBaseUrl: "",
    llmModel: "",
    whisperModel: "medium",
    whisperLanguage: "ko",
    huggingFaceToken: "",
    enableDiarization: true,
    enableSummary: true,
    uiLanguage: "en",
    summaryLanguage: "auto",
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
    const [settings, setSettings] = useState<Settings | null>(null);

    return (
        <I18nProvider locale={settings?.uiLanguage ?? "en"}>
            <AppBody settings={settings} setSettings={setSettings} />
        </I18nProvider>
    );
}

function AppBody({
    settings,
    setSettings,
}: {
    settings: Settings | null;
    setSettings: (next: Settings | null) => void;
}) {
    const { t } = useI18n();
    const {
        notes,
        selectedId,
        setSelectedId,
        loadError,
        refresh,
        patchNote,
        removeNote,
    } = useNotes();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState<"preferences" | "downloads">("preferences");
    const [appError, setAppError] = useState<string | null>(null);
    const [dropActive, setDropActive] = useState(false);
    const editorRef = useRef<EditorHandle | null>(null);
    const flushEditor = useCallback(async () => {
        try {
            await editorRef.current?.flush();
        } catch (caught) {
            throw Object.assign(new Error(toMessage(caught)), { cause: caught });
        }
    }, []);

    const pipeline = usePipeline({
        settings: settings ?? DEFAULT_SETTINGS,
        onNotesChanged: refresh,
        onNoteCreated: setSelectedId,
    });
    const recorder = useRecorder(pipeline.run);
    const activityBusy = recorder.status !== "idle" || pipeline.pipeline !== null;
    const resources = useResources({ blocked: activityBusy });
    const updater = useAppUpdate({ blocked: activityBusy || resources.busy, beforeInstall: flushEditor, beforeRestart: flushEditor });
    const updateBusy = updater.state.status === "downloading" || updater.state.status === "installing" || updater.state.status === "restarting";
    const maintenanceBusy = resources.busy || updateBusy;
    const modelState = resources.models[settings?.whisperModel ?? DEFAULT_SETTINGS.whisperModel];
    const modelInstalled = modelState.status === "ready";
    const ffmpegInstalled = resources.ffmpeg.status === "ready";
    const importGuardRef = useRef({
        recorderStatus: recorder.status,
        pipelineBusy: pipeline.pipeline !== null,
        modelInstalled,
        ffmpegInstalled,
        maintenanceBusy,
        run: pipeline.run,
    });

    useEffect(() => {
        importGuardRef.current = {
            recorderStatus: recorder.status,
            pipelineBusy: pipeline.pipeline !== null,
            modelInstalled,
            ffmpegInstalled,
            maintenanceBusy,
            run: pipeline.run,
        };
    }, [
        recorder.status,
        pipeline.pipeline,
        modelInstalled,
        ffmpegInstalled,
        maintenanceBusy,
        pipeline.run,
    ]);

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
                            guard.maintenanceBusy ||
                            guard.modelInstalled === false ||
                            guard.ffmpegInstalled === false
                        ) {
                            return;
                        }
                        const path = payload.paths.find(isImportableAudioPath);
                        if (path === undefined) {
                            setAppError(t("app.unsupportedAudio"));
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
    }, [t]);

    useEffect(() => {
        fetchSettings()
            .then(setSettings)
            .catch((caught) => setAppError(toMessage(caught)));
    }, [setSettings]);

    const handleSaveSettings = useCallback(
        async (next: Settings) => {
            try {
                await saveSettings(next);
                setSettings(next);
            } catch (caught) {
                throw Object.assign(new Error(toMessage(caught)), { cause: caught });
            }
        },
        [setSettings],
    );

    const openSettings = (section: "preferences" | "downloads") => {
        setSettingsSection(section);
        setSettingsOpen(true);
    };

    const now = useTickingNow(pipeline.pipeline !== null);

    if (!settings) {
        return (
            <div className={styles.loading}>{appError ?? t("app.loading")}</div>
        );
    }

    const selectedNote = notes.find((note) => note.id === selectedId) ?? null;
    const activeResource = resources.active === null ? null : {
        title: resources.active.kind === "model"
            ? t("resources.model", { model: resources.active.model })
            : t(`resources.${resources.active.kind}`),
        state: resources.active.state,
    };
    const updateNotice = updater.state.status === "available"
        ? t("update.available", { version: updater.state.version ?? "" })
        : updater.state.status === "restartReady"
          ? t("update.restartReady")
          : updater.state.status === "restarting"
            ? t("update.restarting")
          : updateBusy
            ? t(updater.state.status === "installing" ? "update.applying" : "update.downloading")
            : null;
    const processing =
        pipeline.pipeline === null
            ? null
            : buildProcessingView({
                  state: pipeline.pipeline,
                  nowMs: now,
                  t,
              });

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
    } else if (recorder.error) {
        toast = {
            tone: "error",
            text: recorder.error,
            dismiss: recorder.dismissError,
        };
    } else if (loadError ?? appError) {
        toast = { tone: "error", text: loadError ?? appError ?? "" };
    } else if (pipeline.warning) {
        toast = {
            tone: "info",
            text: pipeline.warning,
            dismiss: pipeline.clearWarning,
        };
    } else if (processing) {
        toast = { tone: "info", text: processing.statusText };
    }

    return (
        <div className={styles.app}>
            <aside className={styles.sidebar}>
                <header className={styles.brandRow}>
                    <span className={styles.brand}>profNote</span>
                    <button
                        type="button"
                        className={styles.settingsButton}
                        onClick={() => openSettings("preferences")}
                        aria-label={t("app.settings")}
                    >
                        <GearIcon />
                    </button>
                </header>
                <NoteList
                    notes={notes}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />
                {updateNotice !== null && (
                    <button
                        type="button"
                        className={styles.updateNotice}
                        onClick={() => openSettings("downloads")}
                    >
                        {updateNotice}
                    </button>
                )}
                <RecordBar
                    recorderStatus={recorder.status}
                    elapsedMs={recorder.elapsedMs}
                    recorderError={recorder.error}
                    modelName={settings.whisperModel}
                    modelState={modelState}
                    ffmpegState={resources.ffmpeg}
                    maintenanceBusy={maintenanceBusy}
                    activeResource={activeResource}
                    processing={processing}
                    onStart={() => {
                        if (!activityBusy && !maintenanceBusy && modelInstalled && ffmpegInstalled) {
                            void recorder.start();
                        }
                    }}
                    onStop={() => void recorder.stop()}
                    onDownloadModel={() => { if (!updateBusy) { void resources.installModel(settings.whisperModel); } }}
                    onDownloadFfmpeg={() => { if (!updateBusy) { void resources.installFfmpeg(); } }}
                    onOpenDownloads={() => openSettings("downloads")}
                    onDismissError={recorder.dismissError}
                />
            </aside>
            <main className={styles.main}>
                {selectedNote ? (
                    <Editor
                        ref={editorRef}
                        note={selectedNote}
                        editingDisabled={updater.state.status === "installing" || updater.state.status === "restarting"}
                        liveTranscript={
                            pipeline.preview?.noteId === selectedNote.id
                                ? pipeline.preview.transcript
                                : null
                        }
                        liveSummary={
                            pipeline.preview?.noteId === selectedNote.id
                                ? pipeline.preview.summary
                                : null
                        }
                        onPatch={(patch) => patchNote(selectedNote.id, patch)}
                        onDelete={() => void removeNote(selectedNote.id)}
                        onRegenerateSummary={() =>
                            void pipeline.regenerateSummary(selectedNote)
                        }
                        regenerating={
                            pipeline.pipeline?.stage === "summarizing" &&
                            pipeline.pipeline.noteId === selectedNote.id
                        }
                        pipelineActive={pipeline.pipeline !== null}
                        processingHint={
                            pipeline.pipeline?.noteId === selectedNote.id
                                ? processing?.statusText ?? null
                                : null
                        }
                    />
                ) : (
                    <div className={styles.empty}>
                        <p>{t("app.empty")}</p>
                    </div>
                )}
            </main>
            {settingsOpen && (
                <SettingsModal
                    settings={settings}
                    onSave={handleSaveSettings}
                    onClose={() => setSettingsOpen(false)}
                    initialSection={settingsSection}
                    models={resources.models}
                    ffmpeg={resources.ffmpeg}
                    diarizer={resources.diarizer}
                    update={updater.state}
                    maintenanceBusy={maintenanceBusy}
                    activityBusy={activityBusy}
                    onDownloadModel={(model) => { if (!updateBusy) { void resources.installModel(model); } }}
                    onDownloadFfmpeg={() => { if (!updateBusy) { void resources.installFfmpeg(); } }}
                    onInstallDiarizer={() => { if (!updateBusy) { void resources.installDiarizer(); } }}
                    onCheckUpdate={() => void updater.check()}
                    onInstallUpdate={() => void updater.install()}
                    onRestart={() => void updater.restart()}
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
                        {t("app.drop")}
                    </div>
                </div>
            )}
        </div>
    );
}
