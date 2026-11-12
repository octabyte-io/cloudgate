import { useCallback, useState } from "react";

/**
 * An edit in progress over a value that keeps arriving from the server.
 *
 * Three editors in this phase have the same problem: a file, an environment
 * blob and a port list are all fetched, then typed into, then saved, and the
 * fetch happens again afterwards (and on every window focus). The obvious
 * `useEffect(() => setDraft(fetched), [fetched])` is wrong twice over — it
 * throws away what somebody has typed the moment a background refetch lands, and
 * this codebase's eslint config bans setting state from an effect for exactly
 * that class of bug.
 *
 * So the draft **remembers what it was a draft of**. While `base` matches what
 * the server last said, the typed text wins; the moment the server says
 * something different the draft is stale by definition and the new value shows
 * through. No effect, no race, and "somebody else changed this file underneath
 * you" resolves in the only direction that cannot lose the file.
 */
export function useDraft(server: string) {
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(
    null,
  );

  const value = draft !== null && draft.base === server ? draft.text : server;

  const set = useCallback(
    (text: string) => setDraft({ base: server, text }),
    [server],
  );

  const reset = useCallback(() => setDraft(null), []);

  return { value, set, reset, dirty: value !== server };
}
