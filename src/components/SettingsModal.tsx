import { useState } from "react";
import styles from "./SettingsModal.module.css";
import { toMessage } from "../services/errors";
import { WHISPER_MODELS, type Settings } from "../types";

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
    const [draft, setDraft] = useState<Settings>(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
                <h2 className={styles.title}>설정</h2>
                <div className={styles.group}>
                    <label className={styles.toggle}>
                        <input
                            type="checkbox"
                            checked={draft.enableSummary}
                            onChange={(event) =>
                                update("enableSummary", event.target.checked)
                            }
                        />
                        <span>AI 요약 사용</span>
                    </label>
                    <div
                        className={
                            draft.enableSummary
                                ? styles.stack
                                : `${styles.stack} ${styles.dimmed}`
                        }
                    >
                        <label className={styles.field}>
                            <span>LLM API 키 (OpenAI 호환)</span>
                            <input
                                type="password"
                                value={draft.openaiApiKey}
                                onChange={(event) =>
                                    update("openaiApiKey", event.target.value)
                                }
                                placeholder="API 키 또는 Base URL이 없으면 요약을 건너뜁니다"
                            />
                        </label>
                        <div className={styles.row}>
                            <label className={styles.field}>
                                <span>API Base URL (선택)</span>
                                <input
                                    value={draft.llmBaseUrl}
                                    onChange={(event) =>
                                        update("llmBaseUrl", event.target.value)
                                    }
                                    placeholder="기본: https://api.openai.com/v1"
                                />
                            </label>
                            <label className={styles.field}>
                                <span>모델명 (선택)</span>
                                <input
                                    value={draft.llmModel}
                                    onChange={(event) =>
                                        update("llmModel", event.target.value)
                                    }
                                    placeholder="기본: gpt-4o"
                                />
                            </label>
                        </div>
                    </div>
                </div>
                <div className={styles.row}>
                    <label className={styles.field}>
                        <span>Whisper 모델</span>
                        <select
                            value={draft.whisperModel}
                            onChange={(event) =>
                                update(
                                    "whisperModel",
                                    event.target
                                        .value as Settings["whisperModel"],
                                )
                            }
                        >
                            {WHISPER_MODELS.map((model) => (
                                <option key={model} value={model}>
                                    {model}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span>전사 언어</span>
                        <input
                            value={draft.whisperLanguage}
                            onChange={(event) =>
                                update("whisperLanguage", event.target.value)
                            }
                            placeholder="ko / en / auto"
                        />
                    </label>
                </div>
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
                        <span>화자 분리 사용</span>
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
                                ? "화자 분리 엔진이 설치되어 있습니다."
                                : "엔진 설치 시 Python·torch를 받아 최초 한 번 수 분 걸릴 수 있습니다."}
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
                                ? (diarizerProgress ?? "엔진 설치 중")
                                : diarizerReady
                                  ? "엔진 다시 설치"
                                  : "화자 분리 엔진 설치"}
                        </button>
                        <label className={styles.field}>
                            <span>HuggingFace 토큰</span>
                            <input
                                type="password"
                                value={draft.huggingFaceToken}
                                onChange={(event) =>
                                    update(
                                        "huggingFaceToken",
                                        event.target.value,
                                    )
                                }
                                placeholder="pyannote 모델 접근용"
                            />
                        </label>
                    </div>
                </div>
                {error && <p className={styles.error}>{error}</p>}
                <div className={styles.actions}>
                    <button type="button" onClick={onClose} disabled={saving}>
                        취소
                    </button>
                    <button
                        type="button"
                        className={styles.primary}
                        onClick={() => void handleSave()}
                        disabled={saving}
                    >
                        {saving ? "저장 중" : "저장"}
                    </button>
                </div>
            </div>
        </div>
    );
}
