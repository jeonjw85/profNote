import styles from "./RecordBar.module.css";
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

function downloadLabel(progress: DownloadProgress): string {
    const downloadedMb = (progress.downloadedBytes / (1024 * 1024)).toFixed(0);
    if (progress.totalBytes === null) {
        return `모델 다운로드 중 ${downloadedMb}MB`;
    }
    const percent = Math.min(
        100,
        Math.floor((progress.downloadedBytes / progress.totalBytes) * 100),
    );
    return `모델 다운로드 중 ${percent}%`;
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
                <p className={styles.hint}>{downloadLabel(download)}</p>
            ) : !modelReady ? (
                <button
                    type="button"
                    className={styles.modelButton}
                    onClick={onDownloadModel}
                >
                    {modelName} 모델 다운로드 필요!
                    <br /> 클릭하여 다운로드
                </button>
            ) : null}
            <div className={styles.controls}>
                <button
                    type="button"
                    className={`${styles.button} ${recording ? styles.recording : ""}`}
                    onClick={recording ? onStop : onStart}
                    disabled={busy || Boolean(download)}
                    aria-label={recording ? "녹음 정지" : "녹음 시작"}
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
                        {busy ? "저장 중" : recording ? "녹음 중" : "녹음 대기"}
                    </span>
                </div>
            </div>
        </div>
    );
}
