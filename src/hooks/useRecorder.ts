import { useCallback, useEffect, useRef, useState } from "react";
import { startRecording, stopRecording } from "../services/audio";
import { toMessage } from "../services/errors";
import type { RecordingStopped } from "../types";

export type RecorderStatus = "idle" | "recording" | "stopping";

export function useRecorder(onCaptured: (capture: RecordingStopped) => void) {
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
    try {
      const info = await startRecording();
      startedAtRef.current = info.startedAtMs;
      setElapsedMs(0);
      setStatus("recording");
    } catch (caught) {
      setError(toMessage(caught));
    }
  }, []);

  const stop = useCallback(async () => {
    if (status !== "recording") {
      return;
    }
    setStatus("stopping");
    try {
      const result = await stopRecording();
      onCapturedRef.current(result);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      startedAtRef.current = null;
      setElapsedMs(0);
      setStatus("idle");
    }
  }, [status]);

  const dismissError = useCallback(() => setError(null), []);

  return { status, elapsedMs, error, start, stop, dismissError };
}
