import assert from "node:assert/strict";
import test from "node:test";
import { createLoader } from "./helpers/load-module.mjs";

const load = createLoader();
const { createNoteSelector } = load("src/services/selection.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("note selection waits until pending edits are saved", async () => {
  const save = deferred();
  const selected = [];
  const busy = [];
  const select = createNoteSelector();
  const pending = select("next", { flush: () => save.promise, select: id => selected.push(id), reportError: assert.fail, setBusy: value => busy.push(value) });
  assert.deepEqual(selected, []);
  assert.deepEqual(busy, [true]);
  save.resolve();
  await pending;
  assert.deepEqual(selected, ["next"]);
  assert.deepEqual(busy, [true, false]);
});

test("failed save prevents navigation and reports the error", async () => {
  const failure = new Error("disk unavailable");
  const selected = [];
  const errors = [];
  const busy = [];
  const select = createNoteSelector();
  await select("next", { flush: async () => { throw failure; }, select: id => selected.push(id), reportError: error => errors.push(error), setBusy: value => busy.push(value) });
  assert.deepEqual(selected, []);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(busy, [true, false]);
});

test("an older selection cannot override a more recent request", async () => {
  const first = deferred();
  const second = deferred();
  const saves = [first, second];
  const selected = [];
  const busy = [];
  const select = createNoteSelector();
  const callbacks = { flush: () => saves.shift().promise, select: id => selected.push(id), reportError: assert.fail, setBusy: value => busy.push(value) };
  const oldRequest = select("old", callbacks);
  const newRequest = select("new", callbacks);
  second.resolve();
  await newRequest;
  first.resolve();
  await oldRequest;
  assert.deepEqual(selected, ["new"]);
  assert.deepEqual(busy, [true, true, false]);
});
