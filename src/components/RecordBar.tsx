import styles from "./RecordBar.module.css";
import { useI18n } from "../i18n/context";
import { formatTimestamp } from "../services/transcript";
import type { RecorderStatus } from "../hooks/useRecorder";
import type { DownloadProgress } from "../types";

interface RecordBarProps {
    recorderStatus: RecorderStatus;
    elapsedMs: number;
    recorderError: string | null;
    modelReady: boolean;
    modelName: string;
    download: DownloadProgress | null;
    onStart: () => void;
    onStop: () => void;
    onDownloadModel: () => void;
    onDismissError: () => void;
}

function downloadLabel(
    progress: DownloadProgress,
    t: (key: string, vars?: Record<string, string | number>) => string,
): string {
    const downloadedMb = (progress.downloadedBytes / (1024 * 1024)).toFixed(0);
    if (progress.totalBytes === null) {
        return t("record.download.mb", { mb: downloadedMb });
    }
    const percent = Math.min(
        100,
        Math.floor((progress.downloadedBytes / progress.totalBytes) * 100),
    );
    return t("record.download.percent", { percent });
}

export function RecordBar({
    recorderStatus,
    elapsedMs,
    recorderError,
    modelReady,
    modelName,
    download,
    onStart,
    onStop,
    onDownloadModel,
    onDismissError,
}: RecordBarProps) {
    const { t } = useI18n();
    const recording = recorderStatus === "recording";
    const busy = recorderStatus === "stopping";
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
            {download ? (
                <p className={styles.hint}>{downloadLabel(download, t)}</p>
            ) : !modelReady ? (
                <button
                    type="button"
                    className={styles.modelButton}
                    onClick={onDownloadModel}
                >
                    {t("record.download.needed", { model: modelName })}
                    <br />{t("record.download.click")}
                </button>
            ) : null}
            <div className={styles.controls}>
                <button
                    type="button"
                    className={`${styles.button} ${recording ? styles.recording : ""}`}
                    onClick={recording ? onStop : onStart}
                    disabled={busy || Boolean(download)}
                    aria-label={recording ? t("record.stop") : t("record.start")}
                >
                    <span className={styles.dot} />
                </button>
                <div className={styles.label}>
                    {recording && (
                        <span className={styles.timer}>
                            {formatTimestamp(elapsedMs)}
                        </span>
                    )}
                    <span className={styles.statusText}>
                        {busy
                            ? t("record.saving")
                            : recording
                              ? t("record.recording")
                              : t("record.idle")}
                    </span>
                </div>
            </div>
        </div>
    );
}
