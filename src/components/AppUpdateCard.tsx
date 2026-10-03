import { useI18n } from "../i18n/context";
import type { AppUpdateState } from "../types/maintenance";
import { ResourceProgress } from "./ResourceStatus";
import styles from "./AppUpdateCard.module.css";

interface AppUpdateCardProps {
    update: AppUpdateState;
    disabled: boolean;
    checkDisabled?: boolean;
    onCheck: () => void;
    onInstall: () => void;
    onRestart: () => void;
}

export function AppUpdateCard({ update, disabled, checkDisabled = false, onCheck, onInstall, onRestart }: AppUpdateCardProps) {
    const { t } = useI18n();
    const statusLabels: Record<AppUpdateState["status"], string> = {
        idle: t("updates.idle"),
        checking: t("updates.checking"),
        current: t("updates.current"),
        available: t("updates.available"),
        downloading: t("updates.downloading"),
        installing: t("updates.installing"),
        restartReady: t("updates.restartReady"),
        restarting: t("updates.restarting"),
        error: t("updates.error"),
    };
    const working = update.status === "downloading" || update.status === "installing" || update.status === "restarting";
    const latestVersion = update.version ?? (update.status === "current" ? update.currentVersion : null);
    const canInstall = update.status === "available" || (
        update.status === "error" && update.version !== null && update.version !== update.currentVersion
    );
    return (
        <section className={styles.card} aria-label={t("updates.title")} aria-busy={working || update.status === "checking"}>
            <div className={styles.header}>
                <h3>{t("updates.title")}</h3>
                <span className={styles.status} role="status" aria-live="polite">{statusLabels[update.status]}</span>
            </div>
            <dl className={styles.versions}>
                <div>
                    <dt>{t("updates.currentVersion")}</dt>
                    <dd>{update.currentVersion ? `v${update.currentVersion}` : "—"}</dd>
                </div>
                <div>
                    <dt>{t("updates.latestVersion")}</dt>
                    <dd>{latestVersion ? `v${latestVersion}` : t("updates.notChecked")}</dd>
                </div>
            </dl>
            {working && <ResourceProgress label={statusLabels[update.status]} progress={update.status === "downloading" ? update.progress : null} />}
            {update.status === "restartReady" && <p className={styles.hint}>{t("updates.restartHint")}</p>}
            {update.error && <p className={styles.error} role="alert">{update.error}</p>}
            <div className={styles.actions}>
                <button type="button" onClick={onCheck} disabled={checkDisabled || working || update.status === "checking" || update.status === "restartReady"}>
                    {update.status === "checking" ? t("updates.checking") : update.status === "error" && !canInstall ? t("resources.retry") : t("updates.check")}
                </button>
                {canInstall && (
                    <button type="button" className={styles.primary} onClick={onInstall} disabled={disabled}>
                        {update.status === "error" ? t("updates.retryInstall") : t("updates.install")}
                    </button>
                )}
                {update.status === "restartReady" && (
                    <button type="button" className={styles.primary} onClick={onRestart} disabled={disabled}>
                        {t("updates.restart")}
                    </button>
                )}
            </div>
        </section>
    );
}
