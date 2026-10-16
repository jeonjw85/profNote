import assert from "node:assert/strict";
import test from "node:test";
import { createHookHarness } from "./helpers/hooks.mjs";
import { createLoader } from "./helpers/load-module.mjs";

const started = { startedAtMs: Date.now(), sampleRate: 48000, channels: 1 };
const stopped = { wavPath: "recordings/test.wav", durationMs: 1000 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mountRecorder(t, audio) {
  const harness = createHookHarness();
  t.after(() => harness.cleanup());
  const translate = (message) => message;
  const load = createLoader({
    react: harness.react,
    "../i18n/context": { useI18n: () => ({ t: translate }) },
    "../services/audio": audio,
  });
  const { useRecorder } = load("src/hooks/useRecorder.ts");
  const captures = [];
  const onCaptured = (capture) => captures.push(capture);
  return {
    captures,
    render: () => harness.render(() => useRecorder(onCaptured)),
  };
}

test("failure before start resolves waits for start then stops without producing capture", async (t) => {
  const start = deferred();
  let onEvent;
  let stopCalls = 0;
  const hook = mountRecorder(t, {
    startRecording(callback) { onEvent = callback; return start.promise; },
    async stopRecording() { stopCalls++; return stopped; },
  });
  const starting = hook.render().start();
  assert.equal(typeof onEvent, "function");
  onEvent({ type: "error", message: "disk full; partial PCM kept at recordings/test.pcm" });
  assert.equal(stopCalls, 0);
  start.resolve(started);
  await starting;
  assert.equal(stopCalls, 1);
  assert.equal(hook.render().status, "idle");
  assert.match(hook.render().error, /disk full/);
  assert.deepEqual(hook.captures, []);
});

test("failure during recording stops once, keeps first error, and rejects successful capture", async (t) => {
  const stop = deferred();
  let onEvent;
  let stopCalls = 0;
  const hook = mountRecorder(t, {
    async startRecording(callback) { onEvent = callback; return started; },
    stopRecording() { stopCalls++; return stop.promise; },
  });
  await hook.render().start();
  onEvent({ type: "error", message: "disk full" });
  onEvent({ type: "error", message: "duplicate stream error" });
  assert.equal(stopCalls, 1);
  stop.resolve(stopped);
  await new Promise(setImmediate);
  assert.equal(hook.render().status, "idle");
  assert.equal(hook.render().error, "disk full");
  assert.deepEqual(hook.captures, []);
});

test("failure during manual stop never enters pipeline or gets overwritten by stop rejection", async (t) => {
  const stop = deferred();
  let onEvent;
  const hook = mountRecorder(t, {
    async startRecording(callback) { onEvent = callback; return started; },
    stopRecording() { return stop.promise; },
  });
  await hook.render().start();
  const stopping = hook.render().stop();
  onEvent({ type: "error", message: "final flush failed; partial PCM kept" });
  stop.reject(new Error("secondary stop error"));
  await stopping;
  assert.equal(hook.render().status, "idle");
  assert.equal(hook.render().error, "final flush failed; partial PCM kept");
  assert.deepEqual(hook.captures, []);
});

test("normal recording still reaches pipeline exactly once", async (t) => {
  const hook = mountRecorder(t, {
    async startRecording() { return started; },
    async stopRecording() { return stopped; },
  });
  await hook.render().start();
  await hook.render().stop();
  assert.equal(hook.render().status, "idle");
  assert.equal(hook.render().error, null);
  assert.deepEqual(hook.captures, [stopped]);
});

test("old recording events do not stop a new recording", async (t) => {
  const listeners = [];
  let stopCalls = 0;
  const hook = mountRecorder(t, {
    async startRecording(callback) { listeners.push(callback); return started; },
    async stopRecording() { stopCalls++; return stopped; },
  });
  await hook.render().start();
  await hook.render().stop();
  await hook.render().start();
  listeners[0]({ type: "error", message: "stale error" });
  assert.equal(hook.render().status, "recording");
  assert.equal(hook.render().error, null);
  assert.equal(stopCalls, 1);
  await hook.render().stop();
});

test("start failure keeps recorder idle with a visible error and allows retry", async (t) => {
  let attempts = 0;
  const hook = mountRecorder(t, {
    async startRecording() {
      if (attempts++ === 0) throw new Error("cannot create recording file");
      return started;
    },
    async stopRecording() { return stopped; },
  });
  await hook.render().start();
  assert.equal(hook.render().status, "idle");
  assert.equal(hook.render().error, "cannot create recording file");
  await hook.render().start();
  assert.equal(hook.render().status, "recording");
  assert.equal(hook.render().error, null);
  await hook.render().stop();
});

function loadAudio(invoke) {
  class Channel { onmessage = () => {}; }
  const load = createLoader({
    "@tauri-apps/api/core": { Channel, invoke, convertFileSrc: (path) => path },
  });
  return load("src/services/audio.ts");
}

test("start IPC supplies channel that validates and only reports first error", async () => {
  let channel;
  const service = loadAudio(async (command, arguments_) => {
    assert.equal(command, "start_recording");
    channel = arguments_?.onEvent;
    return started;
  });
  const events = [];
  await service.startRecording((event) => events.push(event));
  assert.ok(channel);
  channel.onmessage({ type: "error", message: "disk full" });
  channel.onmessage({ type: "error", message: "second error" });
  assert.deepEqual(events, [{ type: "error", message: "disk full" }]);
});

test("invalid recording IPC event becomes a visible failure instead of throwing", async () => {
  let channel;
  const service = loadAudio(async (_command, arguments_) => {
    channel = arguments_?.onEvent;
    return started;
  });
  const events = [];
  await service.startRecording((event) => events.push(event));
  assert.ok(channel);
  assert.doesNotThrow(() => channel.onmessage({ type: "error", message: 23 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].message, /Invalid recording event/);
});
