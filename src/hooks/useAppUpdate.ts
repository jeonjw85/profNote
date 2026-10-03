import { useCallback, useEffect, useRef, useState } from "react";
import { toMessage } from "../services/errors";
import {
  checkForUpdate,
  closeUpdate,
  getCurrentAppVersion,
  installUpdate,
  restartApp,
  type PendingAppUpdate,
} from "../services/updater";
import type { AppUpdateState } from "../types/maintenance";

const initialState: AppUpdateState = {
  status: "idle",
  currentVersion: "",
  version: null,
  progress: null,
  error: null,
};

export function useAppUpdate({ blocked, beforeInstall, beforeRestart }: {
  blocked: boolean;
  beforeInstall?: () => Promise<void>;
  beforeRestart?: () => Promise<void>;
}) {
  const [state, setState] = useState<AppUpdateState>(initialState);
  const stateRef = useRef(initialState);
  const pendingRef = useRef<PendingAppUpdate | null>(null);
  const operationRef = useRef(false);
  const mountedRef = useRef(false);
  const blockedRef = useRef(blocked);
  const beforeInstallRef = useRef(beforeInstall);
  const beforeRestartRef = useRef(beforeRestart);

  useEffect(() => {
    blockedRef.current = blocked;
    beforeInstallRef.current = beforeInstall;
    beforeRestartRef.current = beforeRestart;
  }, [blocked, beforeInstall, beforeRestart]);

  const publish = useCallback((patch: Partial<AppUpdateState>) => {
    if (mountedRef.current) {
      stateRef.current = { ...stateRef.current, ...patch };
      setState(stateRef.current);
    }
  }, []);

  const finishOperation = useCallback(async () => {
    operationRef.current = false;
    if (!mountedRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      try {
        await closeUpdate(pending);
      } catch {
        return;
      }
    }
  }, []);

  const check = useCallback(async () => {
    if (!mountedRef.current || operationRef.current ||
      ["restartReady", "restarting"].includes(stateRef.current.status)) {
      return;
    }
    operationRef.current = true;
    publish({ status: "checking", progress: null, error: null });
    try {
      publish({ currentVersion: await getCurrentAppVersion() });
      if (!mountedRef.current) {
        return;
      }
      const found = await checkForUpdate();
      if (!mountedRef.current) {
        await closeUpdate(found);
        return;
      }
      const previous = pendingRef.current;
      pendingRef.current = found;
      await closeUpdate(previous);
      publish({
        status: found ? "available" : "current",
        version: found?.version ?? null,
        currentVersion: found?.currentVersion ?? stateRef.current.currentVersion,
        error: null,
      });
    } catch (caught) {
      publish({ status: "error", error: toMessage(caught) });
    } finally {
      await finishOperation();
    }
  }, [publish, finishOperation]);

  const install = useCallback(async () => {
    if (!mountedRef.current || blocked || blockedRef.current || operationRef.current || !stateRef.current.version ||
      !["available", "error"].includes(stateRef.current.status)) {
      return;
    }
    operationRef.current = true;
    publish({
      status: "downloading",
      progress: { downloadedBytes: 0, totalBytes: null },
      error: null,
    });
    try {
      if (!pendingRef.current) {
        pendingRef.current = await checkForUpdate();
      }
      const pending = pendingRef.current;
      if (!pending) {
        publish({ status: "current", version: null, progress: null });
        return;
      }
      publish({ version: pending.version, currentVersion: pending.currentVersion });
      await installUpdate(
        pending,
        (progress) => publish({ progress }),
        () => publish({ status: "installing" }),
        () => mountedRef.current && !blockedRef.current,
        () => beforeInstallRef.current?.() ?? Promise.resolve(),
      );
      pendingRef.current = null;
      await closeUpdate(pending);
      publish({ status: "restartReady", progress: null, error: null });
    } catch (caught) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      await closeUpdate(pending);
      publish({ status: "error", error: toMessage(caught) });
    } finally {
      await finishOperation();
    }
  }, [blocked, publish, finishOperation]);

  const restart = useCallback(async () => {
    if (!mountedRef.current || blocked || blockedRef.current || operationRef.current || stateRef.current.status !== "restartReady") {
      return;
    }
    operationRef.current = true;
    publish({ status: "restarting", error: null });
    try {
      await beforeRestartRef.current?.();
      if (!mountedRef.current || blockedRef.current) {
        throw new Error("An active task is preventing the restart.");
      }
      await restartApp();
    } catch (caught) {
      publish({ status: "restartReady", error: toMessage(caught) });
    } finally {
      await finishOperation();
    }
  }, [blocked, publish, finishOperation]);

  useEffect(() => {
    mountedRef.current = true;
    void check();
    return () => {
      mountedRef.current = false;
      if (!operationRef.current) {
        const pending = pendingRef.current;
        pendingRef.current = null;
        void closeUpdate(pending);
      }
    };
  }, [check]);

  return { state, check, install, restart };
}
