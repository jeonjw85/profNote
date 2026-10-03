import type { DownloadProgress } from "./index";

export interface ResourceState {
    status: "checking" | "missing" | "ready" | "downloading" | "installing" | "error";
    progress: DownloadProgress | null;
    stage: "uv" | "python" | "packages" | null;
    error: string | null;
}

export interface AppUpdateState {
    status: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "restartReady" | "restarting" | "error";
    currentVersion: string;
    version: string | null;
    progress: DownloadProgress | null;
    error: string | null;
}

export function isResourceBusy(state: ResourceState): boolean {
    return state.status === "downloading" || state.status === "installing";
}
