import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

let pending: Update | null = null;

export async function checkForUpdate(): Promise<{ version: string } | null> {
  const update = await check();
  pending = update;
  if (!update) {
    return null;
  }
  return { version: update.version };
}

export async function installPendingUpdate(
  onProgress: (downloadedBytes: number, totalBytes: number | null) => void
): Promise<void> {
  if (!pending) {
    throw new Error("no pending update");
  }
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress(downloaded, total);
  });
  await relaunch();
}
