import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import { startRecording, stopRecording } from "../services/audio";
import { toMessage } from "../services/errors";
import type { RecordingStopped } from "../types";

export type RecorderStatus = "idle" | "requesting" | "recording" | "stopping";

function recorderMessage(
  error: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const raw = toMessage(error);
  if (raw.includes("microphone_denied_windows")) {
    return t("record.micDenied.win");
  }
  if (raw.includes("microphone_denied")) {
    return t("record.micDenied.mac");
  }
  return raw;
}

export function useRecorder(onCaptured: (capture: RecordingStopped) => void) {
  const { t } = useI18n();
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const onCapturedRef = useRef(onCaptured);

  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);

  useEffect(() => {
    if (status !== "recording") {
      return;
    }
    const timer = setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  const start = useCallback(async () => {
    setError(null);
    setStatus("requesting");
    try {
      const info = await startRecording();
      startedAtRef.current = info.startedAtMs;
      setElapsedMs(0);
      setStatus("recording");
    } catch (caught) {
      setStatus("idle");
      setError(recorderMessage(caught, t));
    }
  }, [t]);

    const stop = useCallback(async () => {
    if (status !== "recording") {
      return;
    }
    setStatus("stopping");
    try {
      const result = await stopRecording();
      setStatus("idle");
      startedAtRef.current = null;
      setElapsedMs(0);
      onCapturedRef.current(result);
    } catch (caught) {
      startedAtRef.current = null;
      setElapsedMs(0);
      setStatus("idle");
      setError(recorderMessage(caught, t));
    }
  }, [status, t]);

  const dismissError = useCallback(() => setError(null), []);

  return { status, elapsedMs, error, start, stop, dismissError };
}
