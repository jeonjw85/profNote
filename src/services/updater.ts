import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { z } from "zod";
import type { DownloadProgress } from "../types";
import { toMessage } from "./errors";

const versionSchema = z.string().trim().min(1).max(128);
const metadataSchema = z.object({
  rid: z.number().int().nonnegative().max(4_294_967_295),
  currentVersion: versionSchema,
  version: versionSchema,
}).strict();
const downloadEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("Started"),
    data: z.object({
      contentLength: z.number().int().nonnegative().safe().nullish(),
    }).strict(),
  }).strict(),
  z.object({
    event: z.literal("Progress"),
    data: z.object({ chunkLength: z.number().int().nonnegative().safe() }).strict(),
  }).strict(),
  z.object({ event: z.literal("Finished") }).strict(),
]);

export interface PendingAppUpdate {
  resource: Update;
  currentVersion: string;
  version: string;
}

function updaterError(caught: unknown): Error {
  return Object.assign(new Error(toMessage(caught)), { cause: caught });
}

export async function getCurrentAppVersion(): Promise<string> {
  try {
    const parsed = versionSchema.safeParse(await getVersion());
    if (!parsed.success) {
      throw parsed.error;
    }
    return parsed.data;
  } catch (caught) {
    throw updaterError(caught);
  }
}

export async function closeUpdate(update: PendingAppUpdate | null): Promise<void> {
  if (!update) {
    return;
  }
  try {
    await update.resource.close();
  } catch {
    return;
  }
}

export async function checkForUpdate(): Promise<PendingAppUpdate | null> {
  let resource: Update | null = null;
  try {
    resource = await check({ timeout: 15_000 });
    if (!resource) {
      return null;
    }
    const parsed = metadataSchema.safeParse({
      rid: resource.rid,
      currentVersion: resource.currentVersion,
      version: resource.version,
    });
    if (!parsed.success) {
      throw parsed.error;
    }
    return {
      resource,
      currentVersion: parsed.data.currentVersion,
      version: parsed.data.version,
    };
  } catch (caught) {
    if (resource) {
      try {
        await resource.close();
      } catch {
        throw updaterError(caught);
      }
    }
    throw updaterError(caught);
  }
}

export async function installUpdate(
  update: PendingAppUpdate,
  onProgress: (progress: DownloadProgress) => void,
  onInstalling: () => void,
  canInstall: () => boolean,
  beforeInstall?: () => Promise<void>,
): Promise<void> {
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  let started = false;
  let finished = false;
  let eventError: Error | null = null;
  try {
    if (!canInstall()) {
      throw new Error("An active task is preventing the update.");
    }
    await update.resource.download((message) => {
      if (eventError) {
        return;
      }
      try {
        const parsed = downloadEventSchema.safeParse(message);
        if (!parsed.success) {
          eventError = parsed.error;
          return;
        }
        const event = parsed.data;
        if (finished) {
          throw new Error("Received update progress after download completion.");
        }
        if (event.event === "Started") {
          if (started) {
            throw new Error("Received duplicate update download metadata.");
          }
          started = true;
          totalBytes = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          if (!started) {
            throw new Error("Received update progress before download metadata.");
          }
          downloadedBytes += event.data.chunkLength;
          if (!Number.isSafeInteger(downloadedBytes) ||
            (totalBytes !== null && downloadedBytes > totalBytes)) {
            throw new Error("Invalid update download progress.");
          }
        } else {
          if (!started) {
            throw new Error("Received download completion before download metadata.");
          }
          if (totalBytes !== null && downloadedBytes !== totalBytes) {
            throw new Error("The update download is incomplete.");
          }
          finished = true;
        }
        onProgress({ downloadedBytes, totalBytes });
        if (finished) {
          onInstalling();
        }
      } catch (caught) {
        eventError = updaterError(caught);
      }
    });
    if (eventError) {
      throw eventError;
    }
    if (!finished) {
      throw new Error("The update download did not finish.");
    }
    if (!canInstall()) {
      throw new Error("An active task is preventing the update.");
    }
    await beforeInstall?.();
    if (!canInstall()) {
      throw new Error("An active task is preventing the update.");
    }
    await update.resource.install();
  } catch (caught) {
    throw updaterError(caught);
  }
}

export async function restartApp(): Promise<void> {
  try {
    await relaunch();
  } catch (caught) {
    throw updaterError(caught);
  }
}
