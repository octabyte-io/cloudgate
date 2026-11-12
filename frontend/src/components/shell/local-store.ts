/**
 * A small JSON value in `localStorage`, shaped for `useSyncExternalStore`.
 *
 * Two things in the shell are genuinely the browser's business and not the
 * backend's: which resources this operator has starred, and which ones they were
 * just looking at. Neither has an endpoint, and neither should invent one — a
 * star is a bookmark in *this* browser, and saying so honestly is better than
 * filing an issue for a feature nobody asked the backend for. Both are one
 * *person's*, though, keyed through `ownedKey` below, so a browser two people
 * sign in to keeps them apart.
 *
 * `getSnapshot` has to return a referentially stable value or React re-renders
 * forever, which is why the parsed value is cached rather than re-read per call.
 * Every `localStorage` access is wrapped: it throws outright in some private
 * browsing modes, and a bookmark list is not worth taking the console down for.
 */
export type LocalStore<T> = {
  subscribe: (listener: () => void) => () => void;
  get: () => T;
  set: (next: T) => void;
};

export function createLocalStore<T>(
  key: string,
  empty: T,
  /** Reject anything that is not the shape we wrote — the value survives deploys. */
  revive: (value: unknown) => T | null,
): LocalStore<T> {
  const listeners = new Set<() => void>();
  let cache = empty;
  let loaded = false;

  function get(): T {
    if (!loaded) {
      loaded = true;
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw === null ? null : revive(JSON.parse(raw));
        if (parsed !== null) cache = parsed;
      } catch {
        // Unreadable, unparseable or a shape from an older build. Start empty.
      }
    }
    return cache;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get,
    set(next) {
      get();
      cache = next;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Still this tab's preference, just not the next one's.
      }
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The keys Recents and stars were written under before they had an owner.
 * `cloudgate.recents.<organizationId>` and `cloudgate.starred`, with no user in
 * either. Both now live under `ownedKey`'s user prefix, and
 * `sweepUnownedKeys` removes them.
 *
 * **Deleted, not adopted.** Nothing in them says whose they were, and the first
 * person to sign in after the upgrade is exactly who must not inherit them — a
 * member handed the owner's Servers is the defect. Losing one browser's
 * bookmarks once is the price of that, and deleting rather than ignoring is so
 * the old list is not still sitting in the browser for whoever looks.
 */
function isUnowned(key: string): boolean {
  return key === "cloudgate.starred" || key.startsWith("cloudgate.recents.");
}

/** A key that belongs to one signed-in user, e.g. `cloudgate.<userId>.starred`. */
export function ownedKey(userId: string, name: string): string {
  return `cloudgate.${userId}.${name}`;
}

/**
 * Deletes the unowned keys. Called by each owned store when it is first made —
 * never on a render — and on every such make rather than once per page, because
 * a tab still running the previous build can write an old key after any "once"
 * has passed.
 */
export function sweepUnownedKeys(): void {
  try {
    const unowned: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && isUnowned(key)) unowned.push(key);
    }
    for (const key of unowned) localStorage.removeItem(key);
  } catch {
    // Storage unreadable — then there is nothing in it to leak either.
  }
}
