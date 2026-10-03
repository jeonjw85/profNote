import styles from "./RecordBar.module.css";
import { useI18n } from "../i18n/context";
import type { ProcessingView } from "../services/pipelineEta";
import { formatTimestamp } from "../services/transcript";
import type { RecorderStatus } from "../hooks/useRecorder";
import type { WhisperModel } from "../types";
import type { ResourceState } from "../types/maintenance";
import { ResourceStatus } from "./ResourceStatus";

interface RecordBarProps {
    recorderStatus: RecorderStatus;
    elapsedMs: number;
    recorderError: string | null;
    modelName: WhisperModel;
    modelState: ResourceState;
    ffmpegState: ResourceState;
    maintenanceBusy: boolean;
    activeResource: { title: string; state: ResourceState } | null;
    processing: ProcessingView | null;
    onStart: () => void;
    onStop: () => void;
    onDownloadModel: () => void;
    onDownloadFfmpeg: () => void;
    onDismissError: () => void;
    onOpenDownloads: () => void;
}

export function RecordBar({
    recorderStatus,
    elapsedMs,
    recorderError,
    modelName,
    modelState,
    ffmpegState,
    maintenanceBusy,
    activeResource,
    processing,
    onStart,
    onStop,
    onDownloadModel,
    onDownloadFfmpeg,
    onDismissError,
    onOpenDownloads,
}: RecordBarProps) {
    const { t } = useI18n();
    const recording = recorderStatus === "recording";
    const requesting = recorderStatus === "requesting";
    const busy = recorderStatus === "stopping";
    const modelReady = modelState.status === "ready";
    const ffmpegReady = ffmpegState.status === "ready";
    const activityBusy = recording || busy || requesting || processing !== null;
    const setupBlocked = activityBusy || maintenanceBusy || !ffmpegReady || !modelReady;
    const resourceActionDisabled = maintenanceBusy || activityBusy;
    const processingPercent = processing?.percent === null || processing?.percent === undefined
        ? null
        : Math.max(0, Math.min(100, processing.percent));
    const resources = [
        { title: t("resources.ffmpeg"), state: ffmpegState, onAction: onDownloadFfmpeg },
        { title: t("resources.model", { model: modelName }), state: modelState, onAction: onDownloadModel },
    ];
    const statusText = recording ? t("record.recording")
        : requesting ? t("record.micRequest")
        : busy ? t("record.saving")
        : processing !== null ? t("record.processing")
        : activeResource?.state.status === "installing" ? t("resources.installing")
        : maintenanceBusy ? t("record.downloading")
        : modelState.status === "checking" || ffmpegState.status === "checking" ? t("record.checkingEngines")
        : !modelReady || !ffmpegReady ? t("record.needsSetup")
        : t("record.idle");
    return (
        <div className={styles.bar}>
            {recorderError && (
                <button type="button" className={styles.error} onClick={onDismissError}>
                    {recorderError}
                </button>
            )}
            {activeResource ? (
                <ResourceStatus title={activeResource.title} state={activeResource.state} compact />
            ) : processing ? (
                <div className={styles.progress}>
                    <p className={styles.hint} role="status" aria-live="polite">{processing.statusText}</p>
                    <div
                        className={`${styles.progressTrack} ${processingPercent === null ? styles.indeterminate : ""}`}
                        role="progressbar"
                        aria-label={processing.statusText}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={processingPercent ?? undefined}
                        aria-valuetext={processing.statusText}
                    >
                        {processingPercent !== null && <div className={styles.progressFill} style={{ width: `${processingPercent}%` }} />}
                    </div>
                </div>
            ) : !recording && (
                resources.filter((resource) => resource.state.status !== "ready").map((resource) => (
                    <ResourceStatus
                        key={resource.title}
                        title={resource.title}
                        state={resource.state}
                        onAction={resource.state.status === "missing" || resource.state.status === "error" ? resource.onAction : undefined}
                        actionLabel={resource.state.status === "error" ? t("resources.retry") : t("resources.download")}
                        disabled={resourceActionDisabled}
                        compact
                    />
                ))
            )}
            <div className={styles.controls}>
                <button
                    type="button"
                    className={`${styles.button} ${recording ? styles.recording : ""}`}
                    onClick={recording ? onStop : onStart}
                    disabled={recording ? false : setupBlocked}
                    aria-label={recording ? t("record.stop") : t("record.start")}
                >
                    <span className={styles.dot} />
                </button>
                <div className={styles.label}>
                    {(recording || busy || processing !== null) && (
                        <span className={styles.timer}>
                            {formatTimestamp(recording || processing === null ? elapsedMs : processing.elapsedMs)}
                        </span>
                    )}
                    <span className={styles.statusText}>{statusText}</span>
                </div>
                <button type="button" className={styles.manageButton} onClick={onOpenDownloads}>
                    {t("record.manageDownloads")}
                </button>
            </div>
        </div>
    );
}
