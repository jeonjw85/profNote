import { writeMarkdown } from "./audio";
import { fetchNote } from "./db";
import { renderMarkdownDocument } from "./transcript";

const pendingWrites = new Map<string, Promise<void>>();

export async function syncNoteMarkdown(id: string): Promise<void> {
  const previous = pendingWrites.get(id) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const note = await fetchNote(id);
    if (note === null) return;
    await writeMarkdown(
      `note_${id.slice(0, 8)}`,
      renderMarkdownDocument(note.title, note.summary_md || note.transcript),
    );
  });
  pendingWrites.set(id, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(id) === write) pendingWrites.delete(id);
  }
}
