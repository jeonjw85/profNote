import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLoader } from "./helpers/load-module.mjs";
import { createDatabase } from "./helpers/sqlite.mjs";

const note = {
  id: "12345678-abcd", title: "Old title", transcript: "Full transcript", summary_md: "Old summary",
  audio_path: null, status: "ready", created_at: "2026-10-16T00:00:00Z",
  updated_at: "2026-10-16T00:00:00Z", segments_json: "", professor_speaker: null,
};

function setup(t, write) {
  const database = createDatabase(t);
  const directory = mkdtempSync(join(tmpdir(), "profnote-markdown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writeMarkdown = async (name, content) => {
    await write?.(name, content);
    const path = join(directory, `${name}.md`);
    writeFileSync(path, content);
    return path;
  };
  const load = createLoader({
    "@tauri-apps/plugin-sql": { default: { load: async () => database } },
    "./audio": { writeMarkdown },
    "./credentials": {},
  });
  return {
    ...load("src/services/db.ts"), ...load("src/services/markdown.ts"),
    read: () => readFileSync(join(directory, "note_12345678.md"), "utf8"),
  };
}

test("markdown reflects the latest edited title and summary", async (t) => {
  const db = setup(t);
  await db.insertNote(note);
  await db.updateNoteFields(note.id, { title: "Edited title", summary_md: "Edited summary" });
  await db.syncNoteMarkdown(note.id);
  assert.equal(db.read(), "# Edited title\n\nEdited summary\n");
});

test("notes without summaries export their transcript", async (t) => {
  const db = setup(t);
  await db.insertNote({ ...note, summary_md: "" });
  await db.syncNoteMarkdown(note.id);
  assert.equal(db.read(), "# Old title\n\nFull transcript\n");
});

test("concurrent markdown writes cannot finish with stale content", async (t) => {
  let release;
  let started;
  const pending = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  let writes = 0;
  const db = setup(t, async () => {
    if (++writes === 1) { started(); await pending; }
  });
  await db.insertNote(note);
  const first = db.syncNoteMarkdown(note.id);
  await writing;
  await db.updateNoteFields(note.id, { summary_md: "Newer summary" });
  const second = db.syncNoteMarkdown(note.id);
  release();
  await Promise.all([first, second]);
  assert.equal(db.read(), "# Old title\n\nNewer summary\n");
});

test("a failed file write is reported and does not poison later saves", async (t) => {
  let fail = true;
  const db = setup(t, async () => { if (fail) throw new Error("disk full"); });
  await db.insertNote(note);
  await assert.rejects(db.syncNoteMarkdown(note.id), /disk full/);
  fail = false;
  await db.syncNoteMarkdown(note.id);
  assert.equal(db.read(), "# Old title\n\nOld summary\n");
});

test("a deleted note is not recreated as a markdown file", async (t) => {
  const db = setup(t);
  await db.syncNoteMarkdown("missing");
  assert.throws(db.read, { code: "ENOENT" });
});
