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
  const statusRef = useRef<RecorderStatus>("idle");
  const attemptRef = useRef<{ failed: boolean } | null>(null);
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

  const stop = useCallback(async () => {
    if (statusRef.current !== "recording") {
      return;
    }
    const attempt = attemptRef.current;
    statusRef.current = "stopping";
    setStatus("stopping");
    try {
      const result = await stopRecording();
      if (!attempt?.failed) {
        onCapturedRef.current(result);
      }
    } catch (caught) {
      if (!attempt?.failed) {
        setError(recorderMessage(caught, t));
      }
    } finally {
      attemptRef.current = null;
      startedAtRef.current = null;
      setElapsedMs(0);
      statusRef.current = "idle";
      setStatus("idle");
    }
  }, [t]);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") {
      return;
    }
    const attempt = { failed: false };
    attemptRef.current = attempt;
    statusRef.current = "requesting";
    setError(null);
    setStatus("requesting");
    try {
      const info = await startRecording((event) => {
        if (attemptRef.current !== attempt || attempt.failed) {
          return;
        }
        attempt.failed = true;
        setError(recorderMessage(event.message, t));
        if (statusRef.current === "recording") {
          void stop();
        }
      });
      startedAtRef.current = info.startedAtMs;
      setElapsedMs(0);
      statusRef.current = "recording";
      if (attempt.failed) {
        await stop();
        return;
      }
      setStatus("recording");
    } catch (caught) {
      attemptRef.current = null;
      startedAtRef.current = null;
      statusRef.current = "idle";
      setStatus("idle");
      if (!attempt.failed) {
        setError(recorderMessage(caught, t));
      }
    }
  }, [stop, t]);

  const dismissError = useCallback(() => setError(null), []);

  return { status, elapsedMs, error, start, stop, dismissError };
}
