import assert from "node:assert/strict";
import test from "node:test";
import { createHookHarness } from "./helpers/hooks.mjs";
import { createLoader } from "./helpers/load-module.mjs";
import { createDatabase } from "./helpers/sqlite.mjs";

function find(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function mountApp(t) {
  const database = createDatabase(t);
  let harness = createHookHarness();
  const react = new Proxy({}, { get: (_, name) => harness.react[name] });
  const secure = { error: new Error("credential storage locked"), pending: null, reads: 0 };
  const credentials = { openaiApiKey: "dummy-api-key", huggingFaceToken: "dummy-hf-token" };
  const noop = () => {};
  const noopAsync = async () => {};
  const resource = { status: "ready" };
  const translate = key => key;
  const load = createLoader({
    react,
    "@tauri-apps/api/webview": { getCurrentWebview: () => ({ onDragDropEvent: async () => noop }) },
    "@tauri-apps/plugin-sql": { default: { load: async () => database } },
    "@tauri-apps/api/core": { invoke: async command => {
      assert.equal(command, "get_credentials");
      secure.reads++;
      if (secure.error) throw secure.error;
      if (secure.pending) return secure.pending;
      return credentials;
    } },
    "./App.module.css": { default: {} },
    "./components/Editor": { Editor: noop },
    "./components/NoteList": { NoteList: noop },
    "./components/RecordBar": { RecordBar: noop },
    "./components/SettingsModal": { SettingsModal: noop },
    "./components/Toast": { Toast: noop },
    "./hooks/useNotes": { useNotes: () => ({ notes: [], selectedId: null, setSelectedId: noop, refresh: noopAsync, patchNote: noopAsync, removeNote: noopAsync, loadError: null }) },
    "./hooks/usePipeline": { usePipeline: () => ({ pipeline: null, preview: null, failure: null, warning: null, run: noopAsync }) },
    "./hooks/useRecorder": { useRecorder: () => ({ status: "idle", elapsedMs: 0, error: null }) },
    "./hooks/useResources": { useResources: () => ({ models: { medium: resource }, ffmpeg: resource, diarizer: resource, busy: false, active: null }) },
    "./hooks/useAppUpdate": { useAppUpdate: () => ({ state: { status: "idle" } }) },
    "./hooks/useTickingNow": { useTickingNow: () => Date.now() },
    "./i18n": { I18nProvider: noop },
    "./i18n/context": { useI18n: () => ({ t: translate }) },
    "./services/audio": {},
  });
  const { default: App } = load("src/App.tsx");
  const AppBody = harness.render(() => App()).props.children.type;
  harness.cleanup();
  harness = createHookHarness();
  t.after(() => harness.cleanup());
  let settings = null;
  const setSettings = next => { settings = next; };
  return {
    database, secure, credentials,
    get settings() { return settings; },
    render: () => harness.render(() => AppBody({ settings, setSettings })),
  };
}

const settle = () => new Promise(setImmediate);
const retryButton = tree => find(tree, element => element.type === "button" && element.props.children === "app.retry");
const settingsButton = tree => find(tree, element => element.props?.["aria-label"] === "app.settings");

test("startup can retry after the credential store is unlocked", async (t) => {
  const app = mountApp(t);
  app.render();
  await settle();
  const failed = app.render();
  assert.equal(app.settings, null);
  const retry = retryButton(failed);
  assert.ok(retry, "startup failure should offer a retry action");
  app.secure.error = null;
  retry.props.onClick();
  app.render();
  await settle();
  const ready = app.render();
  assert.ok(settingsButton(ready), "retry should restore access to the app");
  assert.equal(app.settings.openaiApiKey, "dummy-api-key");
  assert.equal(app.secure.reads, 2);
  assert.equal(find(ready, element => element.props?.role === "alert"), null);
});

test("a failed retry shows the new error and allows another retry without fallback", async (t) => {
  const app = mountApp(t);
  app.render();
  await settle();
  let retry = retryButton(app.render());
  assert.ok(retry, "startup failure should offer a retry action");
  app.secure.error = new Error("credential storage access denied");
  retry.props.onClick();
  app.render();
  await settle();
  const failed = app.render();
  assert.equal(find(failed, element => element.props?.role === "alert").props.children, "credential storage access denied");
  assert.equal(app.settings, null);
  retry = retryButton(failed);
  assert.equal(retry.props.disabled, false);
  app.secure.error = null;
  retry.props.onClick();
  app.render();
  await settle();
  assert.ok(settingsButton(app.render()));
  assert.equal(app.secure.reads, 3);
});

test("retry stays disabled while a settings read is pending", async (t) => {
  const app = mountApp(t);
  app.render();
  await settle();
  const retry = retryButton(app.render());
  assert.ok(retry, "startup failure should offer a retry action");
  let release;
  app.secure.pending = new Promise(resolve => { release = resolve; });
  app.secure.error = null;
  t.after(() => release(app.credentials));
  retry.props.onClick();
  retry.props.onClick();
  let pending = app.render();
  await settle();
  assert.equal(app.secure.reads, 2);
  assert.equal(retryButton(pending).props.disabled, true);
  retryButton(pending).props.onClick();
  pending = app.render();
  await settle();
  assert.equal(app.secure.reads, 2);
  assert.equal(app.settings, null);
  assert.equal(find(pending, element => element.props?.role === "alert"), null);
  release(app.credentials);
  await settle();
  assert.ok(settingsButton(app.render()));
});

test("retry resumes an interrupted plaintext credential cleanup", async (t) => {
  const app = mountApp(t);
  app.secure.error = null;
  app.database.query("INSERT INTO settings VALUES ($1, $2)", ["openai_api_key", "dummy-legacy-key"]);
  const execute = app.database.execute;
  let fail = true;
  app.database.execute = async (sql, params) => {
    if (sql === "VACUUM" && fail) throw new Error("credential cleanup busy");
    return execute(sql, params);
  };
  app.render();
  await settle();
  const retry = retryButton(app.render());
  assert.ok(retry, "cleanup failure should offer a retry action");
  assert.equal(app.settings, null);
  assert.equal(app.database.query("SELECT key FROM settings WHERE key = 'credential_cleanup_pending'").length, 1);
  fail = false;
  retry.props.onClick();
  app.render();
  await settle();
  assert.ok(settingsButton(app.render()));
  assert.equal(app.settings.openaiApiKey, "dummy-api-key");
  assert.deepEqual(app.database.query("SELECT key FROM settings WHERE key IN ('openai_api_key', 'credential_cleanup_pending')"), []);
});
