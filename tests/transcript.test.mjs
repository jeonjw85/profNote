import assert from "node:assert/strict";
import test from "node:test";
import { createLoader } from "./helpers/load-module.mjs";

const { buildTranscriptText } = createLoader()("src/services/transcript.ts");
const segment = [{ startMs: 0, endMs: 18000, text: "Professor explains a concept" }];

test("professor turns on either side of a student question retain the segment", () => {
  const speakers = [
    { startMs: 0, endMs: 8000, speaker: "professor" },
    { startMs: 8000, endMs: 10000, speaker: "student" },
    { startMs: 10000, endMs: 18000, speaker: "professor" },
  ];
  assert.equal(buildTranscriptText(segment, speakers, "professor"), "[00:00] Professor explains a concept");
});

test("a brief professor turn at the midpoint cannot retain a student-dominated segment", () => {
  const speakers = [
    { startMs: 0, endMs: 8000, speaker: "student" },
    { startMs: 8000, endMs: 10000, speaker: "professor" },
    { startMs: 10000, endMs: 18000, speaker: "student" },
  ];
  assert.equal(buildTranscriptText(segment, speakers, "professor"), "");
});

test("tied professor overlap is retained instead of discarding uncertain speech", () => {
  const speakers = [
    { startMs: 0, endMs: 9000, speaker: "professor" },
    { startMs: 9000, endMs: 18000, speaker: "student" },
  ];
  assert.equal(buildTranscriptText(segment, speakers, "professor"), "[00:00] Professor explains a concept");
});

test("unassigned speech is preserved when diarization has a large gap", () => {
  const speakers = [
    { startMs: 30000, endMs: 35000, speaker: "professor" },
    { startMs: 35000, endMs: 40000, speaker: "student" },
  ];
  assert.equal(buildTranscriptText(segment, speakers, "professor"), "[00:00] Professor explains a concept");
});

test("disabling professor selection preserves all transcript segments", () => {
  const speakers = [
    { startMs: 0, endMs: 9000, speaker: "professor" },
    { startMs: 9000, endMs: 18000, speaker: "student" },
  ];
  assert.equal(buildTranscriptText(segment, speakers, null), "[00:00] Professor explains a concept");
  assert.equal(buildTranscriptText(segment, [], "professor"), "[00:00] Professor explains a concept");
});
