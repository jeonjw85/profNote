import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { toMessage } from "./errors";

const CredentialsSchema = z.object({
  openaiApiKey: z.string(),
  huggingFaceToken: z.string(),
}).strict();

export type Credentials = z.infer<typeof CredentialsSchema>;

export async function getCredentials(): Promise<Credentials | null> {
  try {
    return CredentialsSchema.nullable().parse(await invoke("get_credentials"));
  } catch (caught) {
    throw Object.assign(new Error(toMessage(caught)), { cause: caught });
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  try {
    await invoke("save_credentials", { credentials: CredentialsSchema.parse(credentials) });
    const saved = await getCredentials();
    if (saved?.openaiApiKey !== credentials.openaiApiKey ||
        saved?.huggingFaceToken !== credentials.huggingFaceToken) {
      throw new Error("Credential storage verification failed.");
    }
  } catch (caught) {
    throw Object.assign(new Error(toMessage(caught)), { cause: caught });
  }
}
