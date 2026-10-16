import assert from "node:assert/strict";
import test from "node:test";
import { createHookHarness } from "./helpers/hooks.mjs";
import { createLoader } from "./helpers/load-module.mjs";
import { createDatabase } from "./helpers/sqlite.mjs";

function setup(t, { exportFails = false, transcribeFails = false } = {}) {
  const database = createDatabase(t);
  const harness = createHookHarness();
  t.after(() => harness.cleanup());
  const documents = [];
  const translate = (key, values) => values?.reason ? `${key}: ${values.reason}` : key;
  const load = createLoader({
    react: harness.react,
    "@tauri-apps/plugin-sql": { default: { load: async () => database } },
    "./credentials": {},
    "../i18n/context": { useI18n: () => ({ t: translate }) },
    "../services/audio": { transcribeAudio: async () => {
      if (transcribeFails) throw new Error("transcription failed");
      return { segments: [{ startMs: 0, endMs: 1000, text: "Lecture transcript" }], text: "Lecture transcript", language: "en" };
    } },
    "./audio": { writeMarkdown: async (filename, content) => {
      if (exportFails) throw new Error("export disk full");
      documents.push({ filename, content });
    } },
    "../services/openai": { summarizeTranscript: async () => { throw new Error("summary stream ended early"); } },
  });
  const { usePipeline } = load("src/hooks/usePipeline.ts");
  const options = {
    settings: { uiLanguage: "en", whisperModel: "medium", whisperLanguage: "en", enableDiarization: false,
      enableSummary: true, openaiApiKey: "dummy-api-key", llmBaseUrl: "", llmModel: "", summaryLanguage: "en" },
    onNotesChanged: async () => {}, onNoteCreated() {},
  };
  return {
    documents, ...load("src/services/db.ts"),
    render: () => harness.render(() => usePipeline(options)),
  };
}

test("summary failure still exports the saved transcript as markdown", async (t) => {
  const pipeline = setup(t);
  await pipeline.render().run({ wavPath: "lecture.wav", durationMs: 1000 }, "Lecture test");
  const [saved] = await pipeline.fetchNotes();
  assert.equal(saved.transcript, "[00:00] Lecture transcript");
  assert.equal(saved.status, "ready");
  assert.equal(pipeline.documents.length, 1);
  assert.equal(pipeline.documents[0].content, "# Lecture test\n\n[00:00] Lecture transcript\n");
  assert.equal(pipeline.render().failure, "summary stream ended early");
});

test("failed fallback export reports a warning without hiding the summary error", async (t) => {
  const pipeline = setup(t, { exportFails: true });
  await pipeline.render().run({ wavPath: "lecture.wav", durationMs: 1000 }, "Lecture test");
  const state = pipeline.render();
  assert.equal(state.failure, "summary stream ended early");
  assert.match(state.warning, /export disk full/);
  assert.equal((await pipeline.fetchNotes())[0].status, "ready");
});

test("failed transcription does not export an empty note", async (t) => {
  const pipeline = setup(t, { transcribeFails: true });
  await pipeline.render().run({ wavPath: "lecture.wav", durationMs: 1000 }, "Lecture test");
  assert.deepEqual(pipeline.documents, []);
  assert.equal((await pipeline.fetchNotes())[0].status, "error");
});
