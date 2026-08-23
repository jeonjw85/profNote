import type { Locale } from "../i18n/context";
import type { SpeakerSegment, TranscriptSegment } from "../types";

const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const SPEAKER_MATCH_TOLERANCE_MS = 1500;

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function speakerAt(
  speakers: SpeakerSegment[],
  positionMs: number
): SpeakerSegment | null {
  let closest: SpeakerSegment | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const segment of speakers) {
    if (segment.startMs <= positionMs && positionMs < segment.endMs) {
      return segment;
    }
    const distance = Math.min(
      Math.abs(positionMs - segment.startMs),
      Math.abs(positionMs - segment.endMs)
    );
    if (distance < closestDistance) {
      closest = segment;
      closestDistance = distance;
    }
  }
  return closestDistance <= SPEAKER_MATCH_TOLERANCE_MS ? closest : null;
}

export interface SpeakerSummary {
  speaker: string;
  durationMs: number;
}

export function summarizeSpeakers(speakers: SpeakerSegment[]): SpeakerSummary[] {
  const totals = new Map<string, number>();
  for (const segment of speakers) {
    const duration = Math.max(0, segment.endMs - segment.startMs);
    totals.set(segment.speaker, (totals.get(segment.speaker) ?? 0) + duration);
  }
  return [...totals.entries()]
    .map(([speaker, durationMs]) => ({ speaker, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);
}

export function pickProfessorSpeaker(speakers: SpeakerSegment[]): string | null {
  return summarizeSpeakers(speakers)[0]?.speaker ?? null;
}

export function buildTranscriptText(
  segments: TranscriptSegment[],
  speakers: SpeakerSegment[],
  professorSpeaker: string | null
): string {
  const filterByProfessor = speakers.length >= 2 && professorSpeaker !== null;
  const visible = filterByProfessor
    ? segments.filter((segment) => {
        const midpoint = Math.floor((segment.startMs + segment.endMs) / 2);
        return speakerAt(speakers, midpoint)?.speaker === professorSpeaker;
      })
    : segments;
  return visible
    .map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.text}`)
    .join("\n\n");
}

export function renderMarkdownDocument(title: string, summary: string): string {
  return `# ${title}\n\n${summary}\n`;
}

export function defaultNoteTitle(date: Date, locale: Locale): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (locale === "en") {
    const month = EN_MONTHS[date.getMonth()] ?? "Jan";
    return `Lecture ${month} ${date.getDate()}, ${time}`;
  }
  return `${date.getMonth() + 1}월 ${date.getDate()}일 강의 ${time}`;
}
