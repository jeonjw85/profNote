import assert from "node:assert/strict";
import test from "node:test";
import { createHookHarness } from "./helpers/hooks.mjs";
import { createLoader } from "./helpers/load-module.mjs";
import { createDatabase } from "./helpers/sqlite.mjs";

const note = {
  id: "note-a", title: "A", transcript: "Transcript", summary_md: "Summary",
  audio_path: null, status: "ready", created_at: "2026-10-16T00:00:00Z",
  updated_at: "2026-10-16T00:00:00Z", segments_json: "", professor_speaker: null,
};

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function mountNotes(t) {
  const database = createDatabase(t);
  const harness = createHookHarness();
  t.after(() => harness.cleanup());
  const holds = [];
  const select = database.select;
  database.select = async (...args) => {
    const hold = holds.shift();
    const rows = await select(...args);
    if (hold) {
      hold.started.resolve();
      const error = await hold.result.promise;
      if (error) throw error;
    }
    return rows;
  };
  const load = createLoader({
    react: harness.react,
    "@tauri-apps/plugin-sql": { default: { load: async () => database } },
    "./credentials": {},
    "./audio": { writeMarkdown: async () => "note.md" },
    "../services/audio": { deleteAudio: async () => {} },
  });
  const db = load("src/services/db.ts");
  await db.insertNote(note);
  const { useNotes } = load("src/hooks/useNotes.ts");
  return {
    ...db,
    render: () => harness.render(useNotes),
    holdNextRead() {
      const started = deferred();
      const result = deferred();
      t.after(() => result.resolve());
      holds.push({ started, result });
      return { started: started.promise, release: error => result.resolve(error) };
    },
  };
}

const settle = () => new Promise(setImmediate);

test("an older refresh cannot replace a more recently saved note", async (t) => {
  const notes = await mountNotes(t);
  notes.render();
  await settle();
  await notes.updateNoteFields(note.id, { title: "B" });
  const held = notes.holdNextRead();
  const oldRead = notes.render().refresh();
  await held.started;
  await notes.updateNoteFields(note.id, { title: "A" });
  await notes.render().refresh();
  assert.equal(notes.render().notes[0].title, "A");
  held.release();
  await oldRead;
  assert.equal(notes.render().notes[0].title, "A");
  assert.equal((await notes.fetchNotes())[0].title, "A");
});

test("an older refresh error cannot replace a newer successful result", async (t) => {
  const notes = await mountNotes(t);
  notes.render();
  await settle();
  const held = notes.holdNextRead();
  const oldRead = notes.render().refresh();
  await held.started;
  await notes.updateNoteFields(note.id, { title: "B" });
  await notes.render().refresh();
  held.release(new Error("old request failed"));
  await oldRead;
  const current = notes.render();
  assert.equal(current.notes[0].title, "B");
  assert.equal(current.loadError, null);
});

test("initial loading cannot overwrite a later refresh", async (t) => {
  const notes = await mountNotes(t);
  const held = notes.holdNextRead();
  notes.render();
  await held.started;
  await notes.updateNoteFields(note.id, { title: "B" });
  await notes.render().refresh();
  held.release();
  await settle();
  assert.equal(notes.render().notes[0].title, "B");
});

test("the latest refresh failure still reaches the error state", async (t) => {
  const notes = await mountNotes(t);
  notes.render();
  await settle();
  const held = notes.holdNextRead();
  const reading = notes.render().refresh();
  await held.started;
  held.release(new Error("current request failed"));
  await reading;
  assert.equal(notes.render().loadError, "current request failed");
});
