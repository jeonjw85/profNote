import assert from "node:assert/strict";
import test from "node:test";
import { createHookHarness } from "./helpers/hooks.mjs";
import { createLoader } from "./helpers/load-module.mjs";

const note = {
  id: "note-a", title: "Lecture", transcript: "Transcript", summary_md: "",
  audio_path: null, status: "summarizing", created_at: "2026-10-16T00:00:00.000Z",
  updated_at: "2026-10-16T00:00:00.000Z", segments_json: "", professor_speaker: null,
};

function mountEditor(t, initial = note, { save = async () => {}, refresh = true } = {}) {
  const harness = createHookHarness();
  t.after(() => harness.cleanup());
  const load = createLoader({
    react: harness.react,
    "react-markdown": { default: () => null },
    "remark-gfm": { default: () => null },
    "./Editor.module.css": { default: {} },
    "../i18n/context": { useI18n: () => ({ t: key => key }) },
    "../services/audio": { audioSrc: value => value },
  });
  const { Editor } = load("src/components/Editor.tsx");
  const ref = { current: null };
  const patches = [];
  let persisted = initial;
  const props = {
    ref, note: initial, onPatch: async patch => {
      patches.push({ ...patch });
      await save(patch);
      persisted = { ...persisted, ...patch };
      if (refresh) {
        props.note = persisted;
        render();
      }
    },
    onDelete() {}, onRegenerateSummary() {}, regenerating: false, pipelineActive: false,
    processingHint: null, liveTranscript: null, liveSummary: null,
  };
  const render = () => harness.render(() => Editor(props));
  return { props, patches, ref, render, get persisted() { return persisted; } };
}

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

test("same-timestamp background summary is never autosaved back to an empty value", async (t) => {
  const editor = mountEditor(t);
  editor.render();
  editor.props.note = { ...note, summary_md: "Generated summary", status: "ready" };
  editor.render();
  await editor.ref.current.flush();
  assert.deepEqual(editor.patches, []);
});

test("a dirty title survives a same-timestamp summary update without overwriting the summary", async (t) => {
  const editor = mountEditor(t);
  const tree = editor.render();
  find(tree, element => element.props?.["aria-label"] === "editor.aria.title")
    .props.onChange({ target: { value: "Edited title" } });
  editor.render();
  editor.props.note = { ...note, summary_md: "Generated summary", status: "ready" };
  editor.render();
  await editor.ref.current.flush();
  assert.deepEqual(editor.patches, [{ title: "Edited title" }]);
});

test("genuine local summary edits are preserved across background updates", async (t) => {
  const editor = mountEditor(t, { ...note, summary_md: "Original summary" });
  const tree = editor.render();
  find(tree, element => element.type === "button" && element.props?.children === "editor.edit")
    .props.onClick();
  const editing = editor.render();
  find(editing, element => element.type === "textarea").props.onChange({ target: { value: "My edited summary" } });
  editor.render();
  editor.props.note = { ...note, summary_md: "Background summary" };
  editor.render();
  await editor.ref.current.flush();
  assert.deepEqual(editor.patches, [{ summary_md: "My edited summary" }]);
});

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function editField(editor, field, value) {
  let tree = editor.render();
  if (field !== "title") {
    find(tree, element => element.type === "button" && element.props?.children === `editor.tab.${field === "summary_md" ? "summary" : "transcript"}`)
      .props.onClick();
    tree = editor.render();
    const edit = find(tree, element => element.type === "button" && element.props?.children === "editor.edit");
    if (edit) {
      edit.props.onClick();
      tree = editor.render();
    }
  }
  const input = find(tree, element => field === "title"
    ? element.props?.["aria-label"] === "editor.aria.title"
    : element.type === "textarea");
  input.props.onChange({ target: { value } });
  editor.render();
}

for (const field of ["title", "summary_md", "transcript"]) {
  test(`${field} reverted during autosave is not overwritten by the older save`, async (t) => {
    const gate = deferred();
    const started = deferred();
    let writes = 0;
    const editor = mountEditor(t, { ...note, [field]: "A" }, { save: async () => {
      if (++writes === 1) {
        started.resolve();
        await gate.promise;
      }
    } });
    t.after(() => gate.resolve());
    editField(editor, field, "B");
    await started.promise;
    editField(editor, field, "A");
    gate.resolve();
    await new Promise(setImmediate);
    const input = find(editor.render(), element => field === "title"
      ? element.props?.["aria-label"] === "editor.aria.title"
      : element.type === "textarea");
    assert.equal(input.props.value, "A");
    await editor.ref.current.flush();
    assert.equal(editor.persisted[field], "A");
    assert.deepEqual(editor.patches, [{ [field]: "B" }, { [field]: "A" }]);
  });
}

test("flush saves input typed while its first save is in flight", async (t) => {
  const gate = deferred();
  const started = deferred();
  let writes = 0;
  const editor = mountEditor(t, note, { save: async () => {
    if (++writes === 1) {
      started.resolve();
      await gate.promise;
    }
  } });
  t.after(() => gate.resolve());
  editField(editor, "title", "B");
  const flushing = editor.ref.current.flush();
  await started.promise;
  editField(editor, "title", "C");
  gate.resolve();
  await flushing;
  assert.equal(editor.persisted.title, "C");
  assert.deepEqual(editor.patches, [{ title: "B" }, { title: "C" }]);
});

test("a waiting flush reads the latest input instead of its earlier render", async (t) => {
  const gate = deferred();
  const started = deferred();
  let writes = 0;
  const editor = mountEditor(t, note, { save: async () => {
    if (++writes === 1) {
      started.resolve();
      await gate.promise;
    }
  } });
  t.after(() => gate.resolve());
  editField(editor, "title", "B");
  const first = editor.ref.current.flush();
  await started.promise;
  editField(editor, "title", "C");
  const waiting = editor.ref.current.flush();
  editField(editor, "title", "D");
  gate.resolve();
  await Promise.all([first, waiting]);
  assert.equal(editor.persisted.title, "D");
  assert.equal(editor.patches.some(patch => patch.title === "C"), false);
});

test("flush preserves a revert even before refreshed props arrive", async (t) => {
  const gate = deferred();
  const started = deferred();
  let writes = 0;
  const editor = mountEditor(t, { ...note, title: "A" }, { refresh: false, save: async () => {
    if (++writes === 1) {
      started.resolve();
      await gate.promise;
    }
  } });
  t.after(() => gate.resolve());
  editField(editor, "title", "B");
  const flushing = editor.ref.current.flush();
  await started.promise;
  editField(editor, "title", "A");
  gate.resolve();
  await flushing;
  assert.equal(editor.persisted.title, "A");
  assert.deepEqual(editor.patches, [{ title: "B" }, { title: "A" }]);
});
