import { useCallback, useSyncExternalStore } from "react";

import { useActiveOrganizationId, useSession } from "@/lib/auth/client";

import { forgetStars } from "./favourites";
import {
  createLocalStore,
  ownedKey,
  sweepUnownedKeys,
  type LocalStore,
} from "./local-store";

/**
 * The Organization rail's "Recents" group (e-console.html:2053-2059), and the
 * home page's recents column.
 *
 * Real routes into real resources, which is the only version worth building: the
 * reference's own comment says so, and a Recents list of pages you could reach
 * in one click anyway is furniture.
 *
 * Recorded by `ScopeProvider` the moment a resource scope resolves its name, so
 * anything that navigates — the rail, the palette, a table row, a pasted URL —
 * lands here without knowing this file exists.
 *
 * **One list per Organization.** Every href in it is a tenant-scoped route, so a
 * shared list would offer the previous Organization's Environments to whoever
 * switched — rows that 404, in the one place someone trusts to be where they just
 * were. The same reasoning `keys.ts` applies to the query cache, applied to the
 * browser's own copy.
 *
 * **And one per user within it**
 * The same
 * reasoning applies to a change of person, and the list used to ignore it: a
 * member signing in where the owner had worked was offered the owner's Servers
 * and Applications, including ones their role could not open. Keyed rather than
 * cleared on sign-out, because a session that expires, or a tab that is simply
 * closed, never signs out. The old unowned keys are dropped by `sweepUnownedKeys`.
 */

/** Whose list: the signed-in user, in their active Organization. */
export type RecentsOwner = { userId: string; organizationId: string };

export type Recent = {
  /** Stable identity, so revisiting moves an entry rather than duplicating it. */
  id: string;
  label: string;
  href: string;
  /**
   * The ids of the resources this one hangs under, outermost first — an
   * Application's Project and Environment. What `forgetRecents` finds a deleted
   * Project's subtree by, since a flat href does not say. Absent on a
   * top-level resource, and on an entry written before ancestors were kept.
   */
  ancestors?: string[];
};

/** Five. A sixth pushes the Projects group below the fold on a laptop. */
const LIMIT = 5;

/**
 * One store per user and Organization, made on demand and kept — a store holds
 * subscribers and a parsed cache, so rebuilding it per render would drop both.
 */
const stores = new Map<string, LocalStore<Recent[]>>();

function storeFor({
  userId,
  organizationId,
}: RecentsOwner): LocalStore<Recent[]> {
  const key = ownedKey(userId, `recents.${organizationId}`);
  const existing = stores.get(key);
  if (existing) return existing;

  sweepUnownedKeys();
  const store = createLocalStore<Recent[]>(
    key,
    NO_RECENTS,
    (value) =>
      Array.isArray(value) && value.every(isRecent)
        ? value.slice(0, LIMIT)
        : null,
  );
  stores.set(key, store);
  return store;
}

/** The shape we wrote. The value survives deploys, so it is checked on read. */
function isRecent(entry: unknown): entry is Recent {
  if (typeof entry !== "object" || entry === null) return false;
  const { id, label, href, ancestors } = entry as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof label === "string" &&
    typeof href === "string" &&
    (ancestors === undefined ||
      (Array.isArray(ancestors) &&
        ancestors.every((each) => typeof each === "string")))
  );
}

const NO_RECENTS: Recent[] = [];
/** A stable reference, or `useSyncExternalStore` loops on the server snapshot. */
const EMPTY = () => NO_RECENTS;

/**
 * This user's recents in this Organization. Empty on the server and while the
 * session loads, which is correct rather than merely safe: there is nobody and
 * no Organization to have recents *in* yet.
 */
export function useRecents(): Recent[] {
  const owner = useRecentsOwner();
  const store = owner === null ? null : storeFor(owner);

  return useSyncExternalStore(
    store?.subscribe ?? NEVER,
    store?.get ?? EMPTY,
    EMPTY,
  );
}

/** Nothing to subscribe to, and nothing that will ever change it. */
const NEVER = () => () => {};

/** The signed-in user and their active Organization, `null` until both load. */
export function useRecentsOwner(): RecentsOwner | null {
  const userId = useSession().data?.user.id ?? null;
  const { organizationId } = useActiveOrganizationId();
  return userId === null || organizationId === null
    ? null
    : { userId, organizationId };
}

/**
 * Move a resource to the front of its owner's list. A no-op when it is already
 * there, so the caller can hand this the current scope on every render pass
 * without writing.
 */
export function recordRecent(owner: RecentsOwner, entry: Recent) {
  const store = storeFor(owner);
  const current = store.get();
  const first = current[0];
  if (
    first &&
    first.id === entry.id &&
    first.label === entry.label &&
    sameIds(first.ancestors, entry.ancestors)
  ) {
    return;
  }

  store.set(
    [entry, ...current.filter((each) => each.id !== entry.id)].slice(0, LIMIT),
  );
}

/**
 * Take resources that are gone out of their owner's list, with everything that
 * hangs under them.
 *
 * The list used to only add, so a deleted Project, its Environment and its
 * Application stayed as three dead rows that pushed live ones out of five — and
 * a deleted-then-recreated name showed twice. Two callers, both through
 * `useForgetVisited`, for two ways of finding out: a delete this console made (the delete mutations), and a scope
 * that answers **404** when opened (`ScopeProvider`), which covers a delete made
 * anywhere else. Only a 404 — a read that failed for any other reason says
 * nothing about whether the row exists, and dropping it would lose a live entry
 * to a blip.
 *
 * Does not write when nothing matched, so it is safe to call on every render
 * of a not-found scope.
 */
export function forgetRecents(owner: RecentsOwner, ids: string[]) {
  const gone = new Set(ids);
  const store = storeFor(owner);
  const current = store.get();
  const kept = current.filter(
    (each) =>
      !gone.has(each.id) && !(each.ancestors ?? []).some((id) => gone.has(id)),
  );
  if (kept.length !== current.length) store.set(kept);
}

/**
 * Forget resources that are gone from both of this browser's lists — Recents
 * (`forgetRecents`) and Starred (`forgetStars`) — for the signed-in user. A
 * delete mutation's `onSuccess`, and `ScopeProvider` on a 404. A no-op until
 * the session has loaded.
 *
 * **Both lists, in one call**.
 * This was `useForgetRecents` until stars had a list: a deleted Environment left
 * in it would be a link to a not-found page, and every place that learns of a
 * delete already called this — so the Starred list hears of one here, rather
 * than at six mutation sites that would each have to remember.
 */
export function useForgetVisited(): (ids: string[]) => void {
  const owner = useRecentsOwner();
  const userId = owner?.userId ?? null;
  const organizationId = owner?.organizationId ?? null;
  return useCallback(
    (ids: string[]) => {
      if (userId !== null && organizationId !== null) {
        forgetRecents({ userId, organizationId }, ids);
        forgetStars(userId, ids);
      }
    },
    [userId, organizationId],
  );
}

function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length && left.every((id, i) => id === right[i])
  );
}
