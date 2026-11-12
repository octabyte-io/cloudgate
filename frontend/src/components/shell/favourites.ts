import { useMemo, useSyncExternalStore } from "react";

import { useActiveOrganizationId, useSession } from "@/lib/auth/client";

import type { Recent } from "./recents";
import type { ScopeContext } from "./scope-provider";
import { visitOf } from "./scope-title";
import {
  createLocalStore,
  ownedKey,
  sweepUnownedKeys,
  type LocalStore,
} from "./local-store";

/**
 * Starred resources (e-console.html:2199-2208), and the Starred list that reads
 * them back — the Organization rail's "Starred" group and the home page's
 * Starred card.
 *
 * There is no favourites endpoint and this does not pretend there is one: a star
 * is a bookmark in this browser. That is worth having on its own — the masthead's
 * star is how you mark the one Environment you are shipping this week — and it is
 * an honest thing to build client-side, unlike a control that posts nowhere.
 *
 * **It has a reader**.
 * A star used to be an id and nothing else, and nothing listed them, so the only
 * place a star could be seen was the header it was clicked on. Removing the
 * toggle was the other way out; a list is what the star was for. An id is enough
 * to answer "is *this* starred" and not enough to draw a row, so a star now
 * carries what a Recents entry does: a label, an href and its ancestors — plus
 * its Organization, below.
 *
 * **One list per user, and not per Organization**
 * It was one list
 * per browser, so whoever signed in next saw the last person's stars. Recents is
 * keyed by Organization because its rows are links that would 404 in another
 * one; stars are *filtered* by Organization instead, on the `organizationId`
 * each one carries, which keeps the same guarantee without a second key and a
 * second migration. Ids are unique across Organizations, so `useIsStarred` needs
 * no filter at all.
 */

/**
 * A star, as the masthead writes it: a Recents row — label, href, ancestors, so
 * a deleted Project takes its Environments' stars with it — plus whose tenant
 * the href belongs to, since the list is filtered by it rather than keyed.
 */
export type Star = Recent & { organizationId: string };

/** The star for a resolved scope. `visitOf` is the one place its row is built. */
export function starOf(
  identity: NonNullable<ScopeContext["identity"]>,
  href: string,
  organizationId: string,
): Star {
  return { ...visitOf(identity, href), organizationId };
}

/**
 * What the store holds: a `Star`, or a **bare id** saved by an older console. A
 * bare id is still starred — the toggle reads it — but has no label to list, so
 * it is not listed until its scope is next opened and `refreshStar` names it.
 * Kept rather than dropped: it is the operator's bookmark, and it costs one
 * visit to become a row, where dropping it would silently unstar it.
 */
type Stored = Star | { id: string };

const stores = new Map<string, LocalStore<Stored[]>>();

function storeFor(userId: string): LocalStore<Stored[]> {
  const key = ownedKey(userId, "starred");
  const existing = stores.get(key);
  if (existing) return existing;

  sweepUnownedKeys();
  const store = createLocalStore<Stored[]>(key, NO_STARS, (value) =>
    Array.isArray(value) && value.every(isStored)
      ? value.map((each) => (typeof each === "string" ? { id: each } : each))
      : null,
  );
  stores.set(key, store);
  return store;
}

/** The shapes we wrote — the value survives deploys, so it is checked on read. */
function isStored(entry: unknown): entry is string | Stored {
  if (typeof entry === "string") return true;
  if (typeof entry !== "object" || entry === null) return false;
  const { id, label, href, organizationId, ancestors } = entry as Record<
    string,
    unknown
  >;
  return (
    typeof id === "string" &&
    (label === undefined || typeof label === "string") &&
    (href === undefined || typeof href === "string") &&
    (organizationId === undefined || typeof organizationId === "string") &&
    (ancestors === undefined ||
      (Array.isArray(ancestors) &&
        ancestors.every((each) => typeof each === "string")))
  );
}

function isStar(entry: Stored): entry is Star {
  return "label" in entry && "href" in entry && "organizationId" in entry;
}

const NO_STARS: Stored[] = [];
/** A stable reference, or `useSyncExternalStore` loops on the server snapshot. */
const EMPTY = () => NO_STARS;

/** The signed-in user's id, or `null` while the session loads. */
export function useStarOwner(): string | null {
  return useSession().data?.user.id ?? null;
}

/** Nothing to subscribe to, and nothing that will ever change it. */
const NEVER = () => () => {};

export function useIsStarred(id: string | null): boolean {
  const userId = useStarOwner();
  const store = userId === null ? null : storeFor(userId);

  return useSyncExternalStore(
    store?.subscribe ?? NEVER,
    () =>
      store !== null && id !== null && store.get().some((each) => each.id === id),
    () => false,
  );
}

/**
 * This user's stars in the active Organization, newest first. Empty on the
 * server and while the session loads, as Recents is.
 */
export function useStarred(): Star[] {
  const userId = useStarOwner();
  const { organizationId } = useActiveOrganizationId();
  const store = userId === null ? null : storeFor(userId);
  const all = useSyncExternalStore(
    store?.subscribe ?? NEVER,
    store?.get ?? EMPTY,
    EMPTY,
  );

  return useMemo(
    () =>
      all.filter(
        (each): each is Star =>
          isStar(each) && each.organizationId === organizationId,
      ),
    [all, organizationId],
  );
}

/** Star it at the front of the list, or unstar it. */
export function toggleStar(userId: string, star: Star) {
  const store = storeFor(userId);
  const current = store.get();
  store.set(
    current.some((each) => each.id === star.id)
      ? current.filter((each) => each.id !== star.id)
      : [star, ...current],
  );
}

/**
 * Bring an existing star up to date with its scope's resolved identity — a
 * rename, a parent's name arriving after the star was clicked, or a bare id
 * from an older console getting the label it never had. Called by `ScopeProvider`
 * on every identity change, so it stars nothing and writes nothing unless the
 * entry is there and differs.
 */
export function refreshStar(userId: string, star: Star) {
  const store = storeFor(userId);
  const current = store.get();
  const at = current.findIndex((each) => each.id === star.id);
  if (at === -1 || sameStar(current[at], star)) return;
  store.set(current.map((each, index) => (index === at ? star : each)));
}

/**
 * Take stars whose resource is gone out of the list, with everything under
 * them. Reached through `useForgetVisited`, so every delete this console makes
 * and every scope that answers 404 unstars what Recents forgets — a
 * deleted Environment is not left as a Starred link to a not-found page.
 */
export function forgetStars(userId: string, ids: string[]) {
  const gone = new Set(ids);
  const store = storeFor(userId);
  const current = store.get();
  const kept = current.filter(
    (each) =>
      !gone.has(each.id) &&
      !(isStar(each) && (each.ancestors ?? []).some((id) => gone.has(id))),
  );
  if (kept.length !== current.length) store.set(kept);
}

function sameStar(stored: Stored, star: Star): boolean {
  if (!isStar(stored)) return false;
  const left = stored.ancestors ?? [];
  const right = star.ancestors ?? [];
  return (
    stored.label === star.label &&
    stored.href === star.href &&
    stored.organizationId === star.organizationId &&
    left.length === right.length &&
    left.every((id, i) => id === right[i])
  );
}
