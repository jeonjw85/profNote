import Database from "@tauri-apps/plugin-sql";
import { z } from "zod";
import {
  NoteSchema,
  SettingsSchema,
  type Note,
  type Settings,
  type SummaryLanguage,
} from "../types";

const DATABASE_URL = "sqlite:profnote.db";

let connection: Promise<Database> | null = null;

function getConnection(): Promise<Database> {
  if (!connection) {
    connection = Database.load(DATABASE_URL);
  }
  return connection;
}

const SELECT_NOTE_COLUMNS =
  "id, title, transcript, summary_md, audio_path, status, created_at, updated_at, segments_json, professor_speaker";

export async function fetchNotes(): Promise<Note[]> {
  const db = await getConnection();
  const rows = await db.select<unknown[]>(
    `SELECT ${SELECT_NOTE_COLUMNS} FROM notes ORDER BY created_at DESC`
  );
  return z.array(NoteSchema).parse(rows);
}

export async function fetchNote(id: string): Promise<Note | null> {
  const db = await getConnection();
  const rows = await db.select<unknown[]>(
    `SELECT ${SELECT_NOTE_COLUMNS} FROM notes WHERE id = $1`, [id]
  );
  return rows.length === 0 ? null : NoteSchema.parse(rows[0]);
}

export async function insertNote(note: Note): Promise<void> {
  const db = await getConnection();
  await db.execute(
    `INSERT INTO notes (${SELECT_NOTE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      note.id,
      note.title,
      note.transcript,
      note.summary_md,
      note.audio_path,
      note.status,
      note.created_at,
      note.updated_at,
      note.segments_json,
      note.professor_speaker,
    ]
  );
}

export type NotePatch = Partial<
  Pick<
    Note,
    | "title"
    | "transcript"
    | "summary_md"
    | "status"
    | "segments_json"
    | "professor_speaker"
  >
>;

export async function updateNoteFields(id: string, patch: NotePatch): Promise<void> {
  const fields = [
    "title", "transcript", "summary_md", "status", "segments_json", "professor_speaker",
  ] as const;
  const entries = fields.flatMap((field) =>
    patch[field] === undefined ? [] : [[field, patch[field]] as const]
  );
  if (entries.length === 0) return;
  const db = await getConnection();
  const assignments = entries.map(([field], index) => `${field} = $${index + 1}`);
  assignments.push(`updated_at = $${entries.length + 1}`);
  const result = await db.execute(
    `UPDATE notes SET ${assignments.join(", ")} WHERE id = $${entries.length + 2}`,
    [...entries.map(([, value]) => value), new Date().toISOString(), id]
  );
  if (result.rowsAffected === 0) throw new Error("The note no longer exists.");
}

export async function deleteNote(id: string): Promise<void> {
  const db = await getConnection();
  await db.execute("DELETE FROM notes WHERE id = $1", [id]);
}

export async function recoverInterruptedNotes(): Promise<void> {
  const db = await getConnection();
  await db.execute(
    `UPDATE notes
     SET status = CASE WHEN transcript = '' THEN 'error' ELSE 'ready' END,
         updated_at = $1
     WHERE status IN ('transcribing', 'summarizing')`,
    [new Date().toISOString()]
  );
}

function readSummaryLanguage(value: string | undefined): SummaryLanguage {
  if (value === "ko" || value === "en") {
    return value;
  }
  return "auto";
}

export async function fetchSettings(): Promise<Settings> {
  const db = await getConnection();
  const rows = await db.select<Array<{ key: string; value: string }>>(
    "SELECT key, value FROM settings"
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return SettingsSchema.parse({
    openaiApiKey: values.get("openai_api_key") ?? "",
    llmBaseUrl: values.get("llm_base_url") ?? "",
    llmModel: values.get("llm_model") ?? "",
    whisperModel: values.get("whisper_model") ?? "medium",
    whisperLanguage: values.get("whisper_language") ?? "ko",
    huggingFaceToken: values.get("huggingface_token") ?? "",
    enableDiarization: values.get("enable_diarization") !== "0",
    enableSummary: values.get("enable_summary") !== "0",
    uiLanguage: values.get("ui_language") === "ko" ? "ko" : "en",
    summaryLanguage: readSummaryLanguage(values.get("summary_language")),
  });
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await getConnection();
  const entries: Array<[string, string]> = [
    ["openai_api_key", settings.openaiApiKey],
    ["llm_base_url", settings.llmBaseUrl],
    ["llm_model", settings.llmModel],
    ["whisper_model", settings.whisperModel],
    ["whisper_language", settings.whisperLanguage],
    ["huggingface_token", settings.huggingFaceToken],
    ["enable_diarization", settings.enableDiarization ? "1" : "0"],
    ["enable_summary", settings.enableSummary ? "1" : "0"],
    ["ui_language", settings.uiLanguage],
    ["summary_language", settings.summaryLanguage],
  ];
  for (const [key, value] of entries) {
    await db.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
      [key, value]
    );
  }
}
