import assert from "node:assert/strict";
import test from "node:test";
import { createLoader } from "./helpers/load-module.mjs";
import { createDatabase } from "./helpers/sqlite.mjs";

const note = {
  id: "lecture", title: "Old title", transcript: "Lecture transcript", summary_md: "",
  audio_path: null, status: "summarizing", created_at: "2026-10-16T00:00:00Z",
  updated_at: "2026-10-16T00:00:00Z", segments_json: "", professor_speaker: null,
};

function setup(t) {
  const database = createDatabase(t);
  const load = createLoader({ "@tauri-apps/plugin-sql": { default: { load: async () => database } } });
  return { database, ...load("src/services/db.ts") };
}

test("concurrent title and summary saves preserve both changes", async (t) => {
  const db = setup(t);
  await db.insertNote(note);
  await Promise.all([
    db.updateNoteFields(note.id, { summary_md: "New summary", status: "ready" }),
    db.updateNoteFields(note.id, { title: "New title" }),
  ]);
  const [saved] = await db.fetchNotes();
  assert.equal(saved.title, "New title");
  assert.equal(saved.summary_md, "New summary");
  assert.equal(saved.status, "ready");
});

test("patch updates preserve unrelated fields and allow null speaker", async (t) => {
  const db = setup(t);
  await db.insertNote({ ...note, professor_speaker: "speaker_0" });
  await db.updateNoteFields(note.id, { title: "Quote's title", professor_speaker: null });
  const [saved] = await db.fetchNotes();
  assert.equal(saved.title, "Quote's title");
  assert.equal(saved.professor_speaker, null);
  assert.equal(saved.transcript, "Lecture transcript");
});

test("updating a missing note reports an error", async (t) => {
  const db = setup(t);
  await assert.rejects(db.updateNoteFields("missing", { title: "No note" }));
});
