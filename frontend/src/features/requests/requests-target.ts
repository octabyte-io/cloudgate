import { useSyncExternalStore } from "react";

import {
  createLocalStore,
  ownedKey,
  type LocalStore,
} from "@/components/shell/local-store";
import type { RequestsTargets } from "@/lib/api/endpoints/monitoring";

/**
 * Which Access log the Requests page reads, and remembering it.
 *
 * The page is addressed by `?server=`, so a shared link opens the same view;
 * with no address it opens on the Server this person last looked at, kept in
 * their own browser. The remembered one falls back to
 * the first Server by name when the picker no longer lists it — never to an
 * empty "pick a Server" page. **An address does not**: a shared link naming a
 * Server the picker does not list gets the usual "not found or not
 * permitted", the same for one deleted and one this person may not read, so
 * the link reveals nothing and does not quietly open another Server's log
 * under it (user story 25).
 */

/** The picker value for the platform host, which has no Server id. */
export const PLATFORM_HOST = "platform-host";

/** What the address names when the picker does not list it: no read, and the usual refusal. */
export const UNLISTED = { unlisted: true } as const;

/**
 * The entry to read: `wanted` (the address) when the picker lists it, else
 * {@link UNLISTED}; with no address, `lastViewed` when the picker lists it;
 * else the first Server by name; else the platform host when it is the only
 * entry; else null — nothing to read.
 */
export function chooseTarget(
  targets: RequestsTargets,
  wanted: string | null,
  lastViewed: string | null,
): string | typeof UNLISTED | null {
  const listed = (value: string | null) =>
    value !== null &&
    (value === PLATFORM_HOST
      ? targets.platformHost
      : targets.servers.some((entry) => entry.serverId === value));
  if (wanted !== null) return listed(wanted) ? wanted : UNLISTED;
  if (listed(lastViewed)) return lastViewed;
  const first = [...targets.servers].sort((a, b) =>
    a.name.localeCompare(b.name),
  )[0];
  if (first) return first.serverId;
  return targets.platformHost ? PLATFORM_HOST : null;
}

const stores = new Map<string, LocalStore<string | null>>();

function storeFor(key: string): LocalStore<string | null> {
  let store = stores.get(key);
  if (!store) {
    store = createLocalStore<string | null>(key, null, (value) =>
      typeof value === "string" ? value : null,
    );
    stores.set(key, store);
  }
  return store;
}

const NO_STORE: LocalStore<string | null> = {
  subscribe: () => () => {},
  get: () => null,
  set: () => {},
};

/** The last-viewed entry, per person and per Organization, in this browser. */
export function useLastViewedTarget(
  userId: string | null,
  organizationId: string | null,
) {
  const store =
    userId === null || organizationId === null
      ? NO_STORE
      : storeFor(ownedKey(userId, `requests-server.${organizationId}`));
  const value = useSyncExternalStore(store.subscribe, store.get, () => null);
  return { value, remember: (target: string) => store.set(target) };
}
