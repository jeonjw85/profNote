import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLoader } from "./helpers/load-module.mjs";
import { createDatabase } from "./helpers/sqlite.mjs";

const settings = {
  openaiApiKey: "dummy-api-key", llmBaseUrl: "", llmModel: "", whisperModel: "medium",
  whisperLanguage: "ko", huggingFaceToken: "dummy-hf-token", enableDiarization: true,
  enableSummary: true, uiLanguage: "ko", summaryLanguage: "auto",
};

function setup(t, initial = null) {
  const database = createDatabase(t, { secureDelete: false });
  const secure = { value: initial, failRead: false, failWrite: false, ignoreWrite: false };
  const load = createLoader({
    "@tauri-apps/plugin-sql": { default: { load: async () => database } },
    "@tauri-apps/api/core": { invoke: async (command, payload) => {
      if (command === "get_credentials") {
        if (secure.failRead) throw new Error("credential storage unavailable");
        return secure.value;
      }
      if (command === "save_credentials") {
        if (secure.failWrite) throw new Error("credential storage denied");
        if (!secure.ignoreWrite) secure.value = { ...payload.credentials };
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    } },
  });
  const legacy = () => database.query("SELECT value FROM settings WHERE key IN ('openai_api_key', 'huggingface_token')");
  const addLegacy = () => {
    database.query("INSERT INTO settings VALUES ($1, $2)", ["openai_api_key", "legacy-api-key"]);
    database.query("INSERT INTO settings VALUES ($1, $2)", ["huggingface_token", "legacy-hf-token"]);
  };
  return { database, secure, legacy, addLegacy, ...load("src/services/db.ts") };
}

test("settings save puts credentials only in secure storage", async (t) => {
  const db = setup(t);
  await db.saveSettings(settings);
  assert.deepEqual(db.secure.value, { openaiApiKey: "dummy-api-key", huggingFaceToken: "dummy-hf-token" });
  assert.deepEqual(db.legacy(), []);
  assert.equal((await db.fetchSettings()).openaiApiKey, "dummy-api-key");
});

test("legacy credentials migrate before plaintext rows are removed", async (t) => {
  const db = setup(t);
  db.addLegacy();
  const loaded = await db.fetchSettings();
  assert.deepEqual(db.secure.value, { openaiApiKey: "legacy-api-key", huggingFaceToken: "legacy-hf-token" });
  assert.equal(loaded.huggingFaceToken, "legacy-hf-token");
  assert.deepEqual(db.legacy(), []);
});

test("failed migration leaves legacy credentials recoverable", async (t) => {
  const db = setup(t);
  db.addLegacy();
  db.secure.failWrite = true;
  await assert.rejects(db.fetchSettings(), /denied/);
  assert.equal(db.legacy().length, 2);
  assert.equal(db.secure.value, null);
});

test("migration verifies the secure write before deleting plaintext", async (t) => {
  const db = setup(t);
  db.addLegacy();
  db.secure.ignoreWrite = true;
  await assert.rejects(db.fetchSettings(), /verif/i);
  assert.equal(db.legacy().length, 2);
});

test("an existing secure entry wins over stale legacy credentials", async (t) => {
  const db = setup(t, { openaiApiKey: "new-key", huggingFaceToken: "" });
  db.addLegacy();
  const loaded = await db.fetchSettings();
  assert.equal(loaded.openaiApiKey, "new-key");
  assert.equal(loaded.huggingFaceToken, "");
  assert.deepEqual(db.legacy(), []);
});

test("secure storage errors never fall back to plaintext", async (t) => {
  const db = setup(t);
  db.secure.failWrite = true;
  await assert.rejects(db.saveSettings(settings), /denied/);
  assert.deepEqual(db.legacy(), []);
  db.addLegacy();
  db.secure.failRead = true;
  await assert.rejects(db.fetchSettings(), /unavailable/);
  assert.equal(db.legacy().length, 2);
});

test("clearing credentials removes their values without reviving legacy data", async (t) => {
  const db = setup(t, { openaiApiKey: "old-key", huggingFaceToken: "old-token" });
  db.addLegacy();
  await db.saveSettings({ ...settings, openaiApiKey: "", huggingFaceToken: "" });
  assert.deepEqual(db.secure.value, { openaiApiKey: "", huggingFaceToken: "" });
  assert.deepEqual(db.legacy(), []);
});

test("malformed secure responses do not discard recoverable legacy credentials", async (t) => {
  const db = setup(t, { openaiApiKey: "dummy-api-key" });
  db.addLegacy();
  await assert.rejects(db.fetchSettings());
  assert.equal(db.legacy().length, 2);
});

test("settings save verifies storage before changing nonsecret settings", async (t) => {
  const db = setup(t, { openaiApiKey: "old-key", huggingFaceToken: "old-token" });
  db.secure.ignoreWrite = true;
  await assert.rejects(db.saveSettings(settings), /verif/i);
  assert.deepEqual(db.database.query("SELECT key FROM settings"), []);
});

test("migration scrubs credential bytes despite connection-local secure-delete settings", async (t) => {
  const db = setup(t);
  db.addLegacy();
  assert.equal(readFileSync(db.database.path).includes(Buffer.from("legacy-api-key")), true);
  await db.fetchSettings();
  const bytes = readFileSync(db.database.path);
  assert.equal(bytes.includes(Buffer.from("legacy-api-key")), false);
  assert.equal(bytes.includes(Buffer.from("legacy-hf-token")), false);
});

test("interrupted credential scrubbing is retried after plaintext rows are gone", async (t) => {
  const db = setup(t);
  db.addLegacy();
  const execute = db.database.execute;
  let fail = true;
  db.database.execute = async (sql, params) => {
    if (sql === "VACUUM" && fail) throw new Error("database locked during cleanup");
    return execute(sql, params);
  };
  await assert.rejects(db.fetchSettings(), /locked/);
  assert.deepEqual(db.legacy(), []);
  fail = false;
  await db.fetchSettings();
  assert.equal(readFileSync(db.database.path).includes(Buffer.from("legacy-api-key")), false);
  assert.deepEqual(db.database.query("SELECT key FROM settings WHERE key = 'credential_cleanup_pending'"), []);
});
