import styles from "./RecordBar.module.css";
import { useI18n } from "../i18n/context";
import type { ProcessingView } from "../services/pipelineEta";
import { formatTimestamp } from "../services/transcript";
import type { RecorderStatus } from "../hooks/useRecorder";
import type { DownloadProgress } from "../types";

interface RecordBarProps {
    recorderStatus: RecorderStatus;
    elapsedMs: number;
    recorderError: string | null;
    modelReady: boolean;
    ffmpegReady: boolean;
    modelName: string;
    download: DownloadProgress | null;
    downloadKind: "ffmpeg" | "model" | null;
    processing: ProcessingView | null;
    onStart: () => void;
    onStop: () => void;
    onDownloadModel: () => void;
    onDownloadFfmpeg: () => void;
    onDismissError: () => void;
}

function downloadLabel(
    progress: DownloadProgress,
    kind: "ffmpeg" | "model",
    t: (key: string, vars?: Record<string, string | number>) => string,
): string {
    const mb = progress.downloadedBytes / (1024 * 1024);
    const mbLabel = mb < 10 ? mb.toFixed(1) : mb.toFixed(0);
    const prefix = kind === "ffmpeg" ? "record.ffmpeg" : "record.download";
    if (progress.totalBytes === null || progress.totalBytes === 0) {
        return t(`${prefix}.mb`, { mb: mbLabel });
    }
    const percent = Math.min(
        99,
        Math.floor((progress.downloadedBytes / progress.totalBytes) * 100),
    );
    return t(`${prefix}.percent`, { percent, mb: mbLabel });
}

function downloadPercent(progress: DownloadProgress): number | null {
    if (progress.totalBytes === null || progress.totalBytes === 0) {
        return null;
    }
    return Math.min(
        99,
        Math.floor((progress.downloadedBytes / progress.totalBytes) * 100),
    );
}

export function RecordBar({
    recorderStatus,
    elapsedMs,
    recorderError,
    modelReady,
    ffmpegReady,
    modelName,
    download,
    downloadKind,
    processing,
    onStart,
    onStop,
    onDownloadModel,
    onDownloadFfmpeg,
    onDismissError,
}: RecordBarProps) {
    const { t } = useI18n();
    const recording = recorderStatus === "recording";
    const requesting = recorderStatus === "requesting";
    const busy = recorderStatus === "stopping";
    const processingActive = processing !== null;
    const setupBlocked =
        busy ||
        requesting ||
        processingActive ||
        Boolean(download) ||
        !ffmpegReady ||
        !modelReady;
    return (
        <div className={styles.bar}>
            {recorderError && (
                <button
                    type="button"
                    className={styles.error}
                    onClick={onDismissError}
                >
                    {recorderError}
                </button>
            )}
            {download && downloadKind ? (
                <div className={styles.progress}>
                    <p className={styles.hint}>
                        {downloadLabel(download, downloadKind, t)}
                    </p>
                    <div className={styles.progressTrack}>
                        <div
                            className={styles.progressFill}
                            style={{
                                width: `${downloadPercent(download) ?? 0}%`,
                            }}
                        />
                    </div>
                </div>
            ) : processing ? (
                <div className={styles.progress}>
                    <p className={styles.hint}>{processing.statusText}</p>
                    <div className={styles.progressTrack}>
                        <div
                            className={styles.progressFill}
                            style={{
                                width: `${processing.percent ?? 0}%`,
                            }}
                        />
                    </div>
                </div>
            ) : !ffmpegReady ? (
                <button
                    type="button"
                    className={styles.modelButton}
                    onClick={onDownloadFfmpeg}
                >
                    {t("record.ffmpeg.needed")}
                    <br />
                    {t("record.ffmpeg.click")}
                </button>
            ) : !modelReady ? (
                <button
                    type="button"
                    className={styles.modelButton}
                    onClick={onDownloadModel}
                >
                    {t("record.download.needed", { model: modelName })}
                    <br />
                    {t("record.download.click")}
                </button>
            ) : null}
            <div className={styles.controls}>
                <button
                    type="button"
                    className={`${styles.button} ${recording ? styles.recording : ""}`}
                    onClick={recording ? onStop : onStart}
                    disabled={setupBlocked}
                    aria-label={recording ? t("record.stop") : t("record.start")}
                >
                    <span className={styles.dot} />
                </button>
                <div className={styles.label}>
                    {(recording || busy || processing !== null) && (
                        <span className={styles.timer}>
                            {formatTimestamp(
                                processing === null
                                    ? elapsedMs
                                    : processing.elapsedMs,
                            )}
                        </span>
                    )}
                    <span className={styles.statusText}>
                        {download
                            ? t("record.downloading")
                            : requesting
                              ? t("record.micRequest")
                              : busy
                                ? t("record.saving")
                                : processing !== null
                                  ? t("record.processing")
                                  : recording
                                    ? t("record.recording")
                                    : t("record.idle")}
                    </span>
                </div>
            </div>
        </div>
    );
}
