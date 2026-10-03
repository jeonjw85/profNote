import { useEffect, useRef, useState } from "react";
import styles from "./SettingsModal.module.css";
import { useI18n } from "../i18n/context";
import { toMessage } from "../services/errors";
import { sttMinutesPerAudioHour } from "../services/pipelineEta";
import { AppUpdateCard } from "./AppUpdateCard";
import { ResourceStatus } from "./ResourceStatus";
import type { AppUpdateState, ResourceState } from "../types/maintenance";
import {
    SUMMARY_LANGUAGES,
    WHISPER_MODELS,
    isWhisperModel,
    type Settings,
    type SummaryLanguage,
    type WhisperModel,
} from "../types";

function assertNever(value: never): never {
    throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

function whisperMetaKey(model: WhisperModel): string {
    switch (model) {
        case "medium":
            return "settings.whisper.meta.medium";
        case "large-v3":
            return "settings.whisper.meta.large-v3";
        case "large-v3-turbo":
            return "settings.whisper.meta.large-v3-turbo";
        default:
            return assertNever(model);
    }
}

const SUMMARY_LANGUAGE_LABEL: Record<SummaryLanguage, string> = {
    auto: "settings.summaryAuto",
    ko: "settings.summaryKo",
    en: "settings.summaryEn",
};

interface SettingsModalProps {
    settings: Settings;
    onSave: (settings: Settings) => Promise<void>;
    onClose: () => void;
    models: Record<WhisperModel, ResourceState>;
    ffmpeg: ResourceState;
    diarizer: ResourceState;
    update: AppUpdateState;
    maintenanceBusy: boolean;
    activityBusy: boolean;
    initialSection?: "preferences" | "downloads";
    onDownloadModel: (model: WhisperModel) => void;
    onDownloadFfmpeg: () => void;
    onInstallDiarizer: () => void;
    onCheckUpdate: () => void;
    onInstallUpdate: () => void;
    onRestart: () => void;
}

export function SettingsModal({
    settings,
    onSave,
    onClose,
    models,
    ffmpeg,
    diarizer,
    update: appUpdate,
    maintenanceBusy,
    activityBusy,
    initialSection = "preferences",
    onDownloadModel,
    onDownloadFfmpeg,
    onInstallDiarizer,
    onCheckUpdate,
    onInstallUpdate,
    onRestart,
}: SettingsModalProps) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<Settings>(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [section, setSection] = useState(initialSection);
    const modalRef = useRef<HTMLDivElement>(null);
    const installsDisabled = maintenanceBusy || activityBusy;

    useEffect(() => {
        const previousFocus = document.activeElement;
        const modal = modalRef.current;
        const focusModal = () => modal?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
        const keepFocusInside = (event: FocusEvent) => {
            if (event.target instanceof Node && !modal?.contains(event.target)) focusModal();
        };
        focusModal();
        document.addEventListener("focusin", keepFocusInside);
        return () => {
            document.removeEventListener("focusin", keepFocusInside);
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, []);

    useEffect(() => {
        const modal = modalRef.current;
        if (modal !== null && !modal.contains(document.activeElement)) {
            modal.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
        }
    }, [section]);

    const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        setDraft((current) => ({ ...current, [key]: value }));
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            await onSave(draft);
            onClose();
        } catch (caught) {
            setError(toMessage(caught));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.overlay} onClick={() => { if (!saving) onClose(); }}>
            <div
                ref={modalRef}
                className={styles.modal}
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-title"
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key === "Escape" && !saving) {
                        event.stopPropagation();
                        onClose();
                    } else if (event.key === "Tab") {
                        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
                            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
                        )].filter((element) => element.tabIndex >= 0 && element.offsetParent !== null);
                        const first = focusable[0];
                        const last = focusable[focusable.length - 1];
                        if (first === undefined) {
                            event.preventDefault();
                            event.currentTarget.focus();
                        } else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) {
                            event.preventDefault();
                            last?.focus();
                        } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
                            event.preventDefault();
                            first.focus();
                        }
                    }
                }}
            >
                <div className={styles.header}>
                    <h2 id="settings-title" className={styles.title}>{t("settings.title")}</h2>
                    {appUpdate.currentVersion.length > 0 && (
                        <span className={styles.version}>v{appUpdate.currentVersion}</span>
                    )}
                </div>
                <div className={styles.tabs} role="tablist" aria-label={t("settings.title")}>
                    {(["preferences", "downloads"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            id={`settings-tab-${value}`}
                            role="tab"
                            aria-selected={section === value}
                            aria-controls={`settings-panel-${value}`}
                            tabIndex={section === value ? 0 : -1}
                            onClick={() => setSection(value)}
                            onKeyDown={(event) => {
                                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                                    event.preventDefault();
                                    const next = event.key === "Home" ? "preferences" : event.key === "End" ? "downloads" : value === "preferences" ? "downloads" : "preferences";
                                    setSection(next);
                                    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
                                    buttons?.[next === "preferences" ? 0 : 1]?.focus();
                                }
                            }}
                        >
                            {t(`settings.sections.${value}`)}
                        </button>
                    ))}
                </div>
                <div className={styles.content}>
                    {section === "preferences" ? (
                        <div className={styles.stack} role="tabpanel" id="settings-panel-preferences" aria-labelledby="settings-tab-preferences">
                            <label className={styles.field}>
                                <span>{t("settings.uiLanguage")}</span>
                                <select
                                    value={draft.uiLanguage}
                                    onChange={(event) =>
                                        update(
                                            "uiLanguage",
                                            event.target.value === "en" ? "en" : "ko",
                                        )
                                    }
                                >
                                    <option value="ko">{t("settings.uiLanguage.ko")}</option>
                                    <option value="en">{t("settings.uiLanguage.en")}</option>
                                </select>
                            </label>
                            <div className={styles.group}>
                                <label className={styles.toggle}>
                                    <input
                                        type="checkbox"
                                        checked={draft.enableSummary}
                                        onChange={(event) =>
                                            update("enableSummary", event.target.checked)
                                        }
                                    />
                                    <span>{t("settings.enableSummary")}</span>
                                </label>
                                <div
                                    className={
                                        draft.enableSummary
                                            ? styles.stack
                                            : `${styles.stack} ${styles.dimmed}`
                                    }
                                >
                                    <label className={styles.field}>
                                        <span>{t("settings.summaryLanguage")}</span>
                                        <select
                                            value={draft.summaryLanguage}
                                            onChange={(event) => {
                                                const value = event.target.value;
                                                if (
                                                    value === "auto" ||
                                                    value === "ko" ||
                                                    value === "en"
                                                ) {
                                                    update("summaryLanguage", value);
                                                }
                                            }}
                                        >
                                            {SUMMARY_LANGUAGES.map((language) => (
                                                <option key={language} value={language}>
                                                    {t(SUMMARY_LANGUAGE_LABEL[language])}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className={styles.field}>
                                        <span>{t("settings.apiKey")}</span>
                                        <input
                                            type="password"
                                            value={draft.openaiApiKey}
                                            onChange={(event) =>
                                                update("openaiApiKey", event.target.value)
                                            }
                                            placeholder={t("settings.apiKey.placeholder")}
                                        />
                                    </label>
                                    <div className={styles.row}>
                                        <label className={styles.field}>
                                            <span>{t("settings.baseUrl")}</span>
                                            <input
                                                value={draft.llmBaseUrl}
                                                onChange={(event) =>
                                                    update("llmBaseUrl", event.target.value)
                                                }
                                                placeholder={t(
                                                    "settings.baseUrl.placeholder",
                                                )}
                                            />
                                        </label>
                                        <label className={styles.field}>
                                            <span>{t("settings.llmModel")}</span>
                                            <input
                                                value={draft.llmModel}
                                                onChange={(event) =>
                                                    update("llmModel", event.target.value)
                                                }
                                                placeholder={t(
                                                    "settings.llmModel.placeholder",
                                                )}
                                            />
                                        </label>
                                    </div>
                                </div>
                            </div>
                            <fieldset className={styles.modelField}>
                                <legend>{t("settings.whisperModel")}</legend>
                                <div className={styles.modelList}>
                                    {WHISPER_MODELS.map((model) => (
                                        <label
                                            key={model}
                                            className={styles.modelOption}
                                            data-selected={
                                                draft.whisperModel === model || undefined
                                            }
                                        >
                                            <input
                                                type="radio"
                                                name="whisperModel"
                                                value={model}
                                                checked={draft.whisperModel === model}
                                                onChange={(event) => {
                                                    const value = event.target.value;
                                                    if (isWhisperModel(value)) {
                                                        update("whisperModel", value);
                                                    }
                                                }}
                                            />
                                            <span className={styles.modelCopy}>
                                                <span className={styles.modelName}>
                                                    {model}
                                                </span>
                                                <span className={styles.modelMeta}>
                                                    {t(whisperMetaKey(model))}
                                                    <br />
                                                    {t("settings.whisper.perHour", {
                                                        minutes: sttMinutesPerAudioHour(
                                                            model,
                                                        ),
                                                    })}
                                                </span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                                <p className={styles.hint}>{t("settings.whisper.hint")}</p>
                            </fieldset>
                            <label className={styles.field}>
                                <span>{t("settings.whisperLanguage")}</span>
                                <input
                                    value={draft.whisperLanguage}
                                    onChange={(event) =>
                                        update("whisperLanguage", event.target.value)
                                    }
                                    placeholder={t("settings.whisperLanguage.placeholder")}
                                />
                            </label>
                            <div className={styles.group}>
                                <label className={styles.toggle}>
                                    <input
                                        type="checkbox"
                                        checked={draft.enableDiarization}
                                        onChange={(event) =>
                                            update(
                                                "enableDiarization",
                                                event.target.checked,
                                            )
                                        }
                                    />
                                    <span>{t("settings.enableDiarization")}</span>
                                </label>
                                <div
                                    className={
                                        draft.enableDiarization
                                            ? styles.stack
                                            : `${styles.stack} ${styles.dimmed}`
                                    }
                                >
                                    <p className={styles.hint}>
                                        {diarizer.status === "ready"
                                            ? t("settings.diarizer.hint.ready")
                                            : t("settings.diarizer.hint.missing")}
                                    </p>
                                    <button
                                        type="button"
                                        className={styles.secondary}
                                        onClick={() => setSection("downloads")}
                                    >
                                        {t("record.manageDownloads")}
                                    </button>
                                    <label className={styles.field}>
                                        <span>{t("settings.hfToken")}</span>
                                        <input
                                            type="password"
                                            value={draft.huggingFaceToken}
                                            onChange={(event) =>
                                                update(
                                                    "huggingFaceToken",
                                                    event.target.value,
                                                )
                                            }
                                            placeholder={t("settings.hfToken.placeholder")}
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.stack} role="tabpanel" id="settings-panel-downloads" aria-labelledby="settings-tab-downloads">
                            <AppUpdateCard update={appUpdate} disabled={installsDisabled} checkDisabled={maintenanceBusy} onCheck={onCheckUpdate} onInstall={onInstallUpdate} onRestart={onRestart} />
                            {activityBusy && <p className={styles.hint}>{t("settings.activityBusy")}</p>}
                            <div className={styles.resourceGroup}>
                                <h3>{t("settings.downloads.modelsTitle")}</h3>
                                <p className={styles.hint}>{t("settings.downloads.modelsHint")}</p>
                                {WHISPER_MODELS.map((model) => (
                                    <ResourceStatus
                                        key={model}
                                        title={t("resources.model", { model })}
                                        description={t(whisperMetaKey(model))}
                                        state={models[model]}
                                        onAction={models[model].status === "missing" || models[model].status === "error" ? () => onDownloadModel(model) : undefined}
                                        actionLabel={models[model].status === "error" ? t("resources.retry") : t("resources.download")}
                                        disabled={installsDisabled}
                                    />
                                ))}
                            </div>
                            <div className={styles.resourceGroup}>
                                <h3>{t("settings.downloads.enginesTitle")}</h3>
                                <ResourceStatus
                                    title={t("resources.ffmpeg")}
                                    description={t("resources.ffmpeg.description")}
                                    state={ffmpeg}
                                    onAction={ffmpeg.status === "missing" || ffmpeg.status === "error" ? onDownloadFfmpeg : undefined}
                                    actionLabel={ffmpeg.status === "error" ? t("resources.retry") : t("resources.download")}
                                    disabled={installsDisabled}
                                />
                                <ResourceStatus
                                    title={t("resources.diarizer")}
                                    description={t("settings.diarizer.hint.missing")}
                                    state={diarizer}
                                    onAction={diarizer.status === "missing" || diarizer.status === "error" || diarizer.status === "ready" ? onInstallDiarizer : undefined}
                                    actionLabel={diarizer.status === "error" ? t("resources.retry") : diarizer.status === "ready" ? t("resources.reinstall") : t("resources.install")}
                                    disabled={installsDisabled}
                                />
                            </div>
                        </div>
                    )}
                </div>
                {error && <p className={styles.error} role="alert">{error}</p>}
                <div className={styles.actions}>
                    <button type="button" onClick={onClose} disabled={saving}>
                        {t(section === "preferences" ? "settings.cancel" : "settings.close")}
                    </button>
                    {section === "preferences" && (
                        <button
                            type="button"
                            className={styles.primary}
                            onClick={() => void handleSave()}
                            disabled={saving}
                        >
                            {saving ? t("settings.saving") : t("settings.save")}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
