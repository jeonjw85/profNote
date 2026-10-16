import assert from "node:assert/strict";
import test from "node:test";
import { createHookHarness } from "./helpers/hooks.mjs";
import { createLoader } from "./helpers/load-module.mjs";

const note = {
  id: "note-a", title: "Lecture", transcript: "Transcript", summary_md: "",
  audio_path: null, status: "summarizing", created_at: "2026-10-16T00:00:00.000Z",
  updated_at: "2026-10-16T00:00:00.000Z", segments_json: "", professor_speaker: null,
};

function mountEditor(t, initial = note) {
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
  const props = {
    ref, note: initial, onPatch: async patch => { patches.push(patch); },
    onDelete() {}, onRegenerateSummary() {}, regenerating: false, pipelineActive: false,
    processingHint: null, liveTranscript: null, liveSummary: null,
  };
  return { props, patches, ref, render: () => harness.render(() => Editor(props)) };
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
