import { useI18n } from "../i18n/context";
import type { DownloadProgress } from "../types";
import type { ResourceState } from "../types/maintenance";
import styles from "./ResourceStatus.module.css";

interface ResourceProgressProps {
    label: string;
    progress: DownloadProgress | null;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000_000) {
        return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    }
    if (bytes >= 1_000_000) {
        return `${(bytes / 1_000_000).toFixed(1)} MB`;
    }
    return `${Math.max(0, Math.round(bytes / 1_000)).toLocaleString()} KB`;
}

export function ResourceProgress({ label, progress }: ResourceProgressProps) {
    const { t } = useI18n();
    const totalBytes = progress?.totalBytes;
    const percent = totalBytes !== null && totalBytes !== undefined && totalBytes > 0
        ? Math.min(100, Math.max(0, Math.floor(100 * (progress?.downloadedBytes ?? 0) / totalBytes)))
        : null;
    const bytes = progress !== null && progress.downloadedBytes > 0
        ? totalBytes !== null && totalBytes !== undefined && totalBytes > 0
            ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(totalBytes)}`
            : t("resources.receivedBytes", { amount: formatBytes(progress.downloadedBytes) })
        : null;
    return (
        <div className={styles.progress}>
            <div className={styles.progressCopy} role="status" aria-live="polite">
                <span>{label}</span>
                {percent !== null && <span>{percent}%</span>}
            </div>
            <div
                className={`${styles.track} ${percent === null ? styles.indeterminate : ""}`}
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                aria-valuetext={percent === null ? label : `${label} ${percent}%`}
            >
                {percent !== null && <div className={styles.fill} style={{ width: `${percent}%` }} />}
            </div>
            {bytes !== null && <p className={styles.bytes}>{bytes}</p>}
        </div>
    );
}

interface ResourceStatusProps {
    title: string;
    description?: string;
    state: ResourceState;
    onAction?: () => void;
    actionLabel?: string;
    disabled?: boolean;
    compact?: boolean;
}

export function ResourceStatus({
    title,
    description,
    state,
    onAction,
    actionLabel,
    disabled = false,
    compact = false,
}: ResourceStatusProps) {
    const { t } = useI18n();
    const statusLabels: Record<ResourceState["status"], string> = {
        checking: t("resources.checking"),
        missing: t("resources.missing"),
        ready: t("resources.ready"),
        downloading: t("resources.downloading"),
        installing: t("resources.installing"),
        error: t("resources.error"),
    };
    const working = state.status === "downloading" || state.status === "installing";
    const stageLabels = {
        uv: t("resources.stage.uv"),
        python: t("resources.stage.python"),
        packages: t("resources.stage.packages"),
    };
    const progressLabel = state.stage !== null
        ? stageLabels[state.stage]
        : state.status === "downloading" && (state.progress?.downloadedBytes ?? 0) === 0 && !state.progress?.totalBytes
            ? t("resources.preparing")
            : statusLabels[state.status];
    return (
        <section
            className={`${styles.resource} ${compact ? styles.compact : ""}`}
            aria-label={title}
            aria-busy={working || state.status === "checking"}
            data-status={state.status}
        >
            <div className={styles.header}>
                <div className={styles.copy}>
                    <h4 className={styles.title}>{title}</h4>
                    {description && <p className={styles.description}>{description}</p>}
                </div>
                <span className={styles.status} role="status" aria-live="polite">{statusLabels[state.status]}</span>
            </div>
            {working && (
                <ResourceProgress
                    label={progressLabel}
                    progress={state.status === "downloading" ? state.progress : null}
                />
            )}
            {state.error && <p className={styles.error} role="alert">{state.error}</p>}
            {onAction && actionLabel && (
                <button
                    type="button"
                    className={styles.action}
                    onClick={onAction}
                    disabled={disabled || working || state.status === "checking"}
                    aria-label={`${actionLabel} · ${title}`}
                >
                    {actionLabel}
                </button>
            )}
        </section>
    );
}
