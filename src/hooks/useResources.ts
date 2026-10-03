import { useCallback, useEffect, useRef, useState } from "react";
import {
    downloadFfmpeg,
    downloadModel,
    getDiarizerStatus,
    getFfmpegStatus,
    getModelStatus,
    prepareDiarizer,
} from "../services/audio";
import { toMessage } from "../services/errors";
import { WHISPER_MODELS, type WhisperModel } from "../types";
import { isResourceBusy, type ResourceState } from "../types/maintenance";

function resourceState(status: ResourceState["status"]): ResourceState {
    return { status, progress: null, stage: null, error: null };
}

function failedResource(caught: unknown): ResourceState {
    return { ...resourceState("error"), error: toMessage(caught) };
}

export function useResources({ blocked }: { blocked: boolean }) {
    const [models, setModels] = useState<Record<WhisperModel, ResourceState>>({
        medium: resourceState("checking"),
        "large-v3": resourceState("checking"),
        "large-v3-turbo": resourceState("checking"),
    });
    const [ffmpeg, setFfmpeg] = useState<ResourceState>(resourceState("checking"));
    const [diarizer, setDiarizer] = useState<ResourceState>(resourceState("checking"));
    const operationRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        const checkModel = async (model: WhisperModel) => {
            let next: ResourceState;
            try {
                const status = await getModelStatus(model);
                next = resourceState(status.installed ? "ready" : "missing");
            } catch (caught) {
                next = failedResource(caught);
            }
            if (!cancelled) {
                setModels((current) => isResourceBusy(current[model])
                    ? current
                    : { ...current, [model]: next });
            }
        };
        const checkFfmpeg = async () => {
            let next: ResourceState;
            try {
                const status = await getFfmpegStatus();
                next = resourceState(status.installed ? "ready" : "missing");
            } catch (caught) {
                next = failedResource(caught);
            }
            if (!cancelled) {
                setFfmpeg((current) => isResourceBusy(current) ? current : next);
            }
        };
        const checkDiarizer = async () => {
            let next: ResourceState;
            try {
                const status = await getDiarizerStatus();
                next = resourceState(status.ready ? "ready" : "missing");
            } catch (caught) {
                next = failedResource(caught);
            }
            if (!cancelled) {
                setDiarizer((current) => isResourceBusy(current) ? current : next);
            }
        };
        void Promise.allSettled([
            ...WHISPER_MODELS.map(checkModel),
            checkFfmpeg(),
            checkDiarizer(),
        ]);
        return () => { cancelled = true; };
    }, []);

    const installModel = useCallback(async (model: WhisperModel) => {
        if (blocked || operationRef.current || models[model].status === "ready" || models[model].status === "checking") {
            return;
        }
        operationRef.current = true;
        setModels((current) => ({ ...current, [model]: {
            ...resourceState("downloading"),
            progress: { downloadedBytes: 0, totalBytes: null },
        } }));
        try {
            await downloadModel(model, (event) => {
                if (event.type === "progress") {
                    const complete = event.totalBytes !== null && event.totalBytes > 0 && event.downloadedBytes >= event.totalBytes;
                    setModels((current) => ({ ...current, [model]: {
                        ...resourceState(complete ? "installing" : "downloading"),
                        progress: { downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes },
                    } }));
                } else {
                    setModels((current) => ({ ...current, [model]: resourceState("installing") }));
                }
            });
            const status = await getModelStatus(model);
            if (!status.installed) {
                throw new Error("The speech recognition model is unavailable after downloading.");
            }
            setModels((current) => ({ ...current, [model]: resourceState("ready") }));
        } catch (caught) {
            setModels((current) => ({ ...current, [model]: failedResource(caught) }));
        } finally {
            operationRef.current = false;
        }
    }, [blocked, models]);

    const installFfmpeg = useCallback(async () => {
        if (blocked || operationRef.current || ffmpeg.status === "ready" || ffmpeg.status === "checking") {
            return;
        }
        operationRef.current = true;
        setFfmpeg({ ...resourceState("downloading"), progress: { downloadedBytes: 0, totalBytes: null } });
        try {
            await downloadFfmpeg((event) => {
                if (event.type === "progress") {
                    const complete = event.totalBytes !== null && event.totalBytes > 0 && event.downloadedBytes >= event.totalBytes;
                    setFfmpeg({
                        ...resourceState(complete ? "installing" : "downloading"),
                        progress: { downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes },
                    });
                } else {
                    setFfmpeg(resourceState("installing"));
                }
            });
            const status = await getFfmpegStatus();
            if (!status.installed) {
                throw new Error("The audio processing engine is unavailable after downloading.");
            }
            setFfmpeg(resourceState("ready"));
        } catch (caught) {
            setFfmpeg(failedResource(caught));
        } finally {
            operationRef.current = false;
        }
    }, [blocked, ffmpeg.status]);

    const installDiarizer = useCallback(async () => {
        if (blocked || operationRef.current || diarizer.status === "checking") {
            return;
        }
        const force = diarizer.status === "ready";
        operationRef.current = true;
        setDiarizer(resourceState("installing"));
        try {
            await prepareDiarizer((event) => {
                if (event.type === "stage") {
                    const stage = event.name === "uv" ? "uv" : event.name === "python" ? "python" : "packages";
                    setDiarizer({
                        ...resourceState(stage === "uv" ? "downloading" : "installing"),
                        stage,
                        progress: stage === "uv" ? { downloadedBytes: 0, totalBytes: null } : null,
                    });
                } else if (event.type === "progress") {
                    setDiarizer({
                        ...resourceState("downloading"),
                        stage: "uv",
                        progress: { downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes },
                    });
                }
            }, force);
            const status = await getDiarizerStatus();
            if (!status.ready) {
                throw new Error("The speaker separation engine is unavailable after installation.");
            }
            setDiarizer(resourceState("ready"));
        } catch (caught) {
            setDiarizer(failedResource(caught));
        } finally {
            operationRef.current = false;
        }
    }, [blocked, diarizer.status]);

    const activeModel = WHISPER_MODELS.find((model) => isResourceBusy(models[model]));
    const active = activeModel !== undefined
        ? { kind: "model" as const, model: activeModel, state: models[activeModel] }
        : isResourceBusy(ffmpeg)
          ? { kind: "ffmpeg" as const, state: ffmpeg }
          : isResourceBusy(diarizer)
            ? { kind: "diarizer" as const, state: diarizer }
            : null;

    return { models, ffmpeg, diarizer, busy: active !== null, active, installModel, installFfmpeg, installDiarizer };
}
