interface NoteSelectionCallbacks {
  flush: () => Promise<void>;
  select: (id: string) => void;
  reportError: (error: unknown) => void;
  setBusy: (busy: boolean) => void;
}

export function createNoteSelector() {
  let request = 0;
  return async (id: string, { flush, select, reportError, setBusy }: NoteSelectionCallbacks) => {
    const current = ++request;
    setBusy(true);
    try {
      await flush();
      if (current === request) select(id);
    } catch (caught) {
      if (current === request) reportError(caught);
    } finally {
      if (current === request) setBusy(false);
    }
  };
}
