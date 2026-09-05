import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import styles from "./SettingsModal.module.css";
import { useI18n } from "../i18n/context";
import { toMessage } from "../services/errors";
import { sttMinutesPerAudioHour } from "../services/pipelineEta";
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
    diarizerReady: boolean;
    diarizerInstalling: boolean;
    diarizerProgress: string | null;
    onInstallDiarizer: () => void;
}

export function SettingsModal({
    settings,
    onSave,
    onClose,
    diarizerReady,
    diarizerInstalling,
    diarizerProgress,
    onInstallDiarizer,
}: SettingsModalProps) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<Settings>(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState("");

    useEffect(() => {
        void getVersion()
            .then(setVersion)
            .catch(() => undefined);
    }, []);

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
        <div className={styles.overlay} onClick={onClose}>
            <div
                className={styles.modal}
                onClick={(event) => event.stopPropagation()}
            >
                <h2 className={styles.title}>{t("settings.title")}</h2>
                {version.length > 0 && (
                    <p className={styles.version}>v{version}</p>
                )}
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
                            {diarizerReady
                                ? t("settings.diarizer.hint.ready")
                                : t("settings.diarizer.hint.missing")}
                        </p>
                        <button
                            type="button"
                            className={styles.secondary}
                            onClick={onInstallDiarizer}
                            disabled={
                                diarizerInstalling || !draft.enableDiarization
                            }
                        >
                            {diarizerInstalling
                                ? (diarizerProgress ??
                                  t("settings.diarizer.installing"))
                                : diarizerReady
                                  ? t("settings.diarizer.reinstall")
                                  : t("settings.diarizer.install")}
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
                {error && <p className={styles.error}>{error}</p>}
                <div className={styles.actions}>
                    <button type="button" onClick={onClose} disabled={saving}>
                        {t("settings.cancel")}
                    </button>
                    <button
                        type="button"
                        className={styles.primary}
                        onClick={() => void handleSave()}
                        disabled={saving}
                    >
                        {saving ? t("settings.saving") : t("settings.save")}
                    </button>
                </div>
            </div>
        </div>
    );
}
