import { usePathname } from "next/navigation";
import { createContext, use, useEffect, useMemo } from "react";

import { useBrandingOrDefault } from "@/lib/api/use-branding";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { usePermission } from "@/lib/auth/use-permission";
import { brandName } from "@/lib/branding/branding";
import type { Mark, StatusKey } from "@/lib/design/status";
import type { TabSubject } from "@/lib/shell/tab-registry";

import { refreshStar, starOf } from "./favourites";
import type { NavEntry } from "./nav";
import { resolveScope } from "./resolve-scope";
import { useScopeQueries } from "./use-scope-queries";
import { recordRecent, useForgetVisited, useRecentsOwner } from "./recents";
import { scopeFromPath, scopeRoot, type ScopeRoute } from "./scope";
import { ScopeDocumentTitle, scopeDocumentTitle, visitOf } from "./scope-title";

/**
 * The scope, and everything the masthead and the rail need to render it.
 *
 * **This is the seam.** The rail and the masthead read this and nothing else, so
 * a later phase changes what they show by changing a nav table or the identity
 * below — never by editing `scope-rail.tsx`.
 *
 * The *shape* of the scope comes from the URL and is available on the first
 * render (`scope.ts`). Only the **names** are fetched, which is what stops a
 * deep link from flashing the Organization rail: the right rail is already
 * there, and the identity fills in.
 */

/** A badge beside the resource's name. Data, so the colour stays in one place. */
export type ScopeBadge =
  | { kind: "status"; status: StatusKey }
  /** A mark that is not one of `STATUS`'s — a Server's reach. */
  | { kind: "mark"; mark: Mark }
  | { kind: "chip"; label: string };

export type ScopeSibling = { id: string; name: string; href: string };

/**
 * One resource above this one, outermost first — the "ui-main / production /" in
 * front of a service's name, each segment a link to that scope's root.
 * The ids are also what Recents forgets a subtree by, since the routes
 * are flat and an href never says what it hangs under.
 */
export type ScopeParent = { id: string; name: string; href: string };

export type ScopeContext = {
  scope: ScopeRoute;
  nav: NavEntry[];
  /**
   * What the row says about which tabs it has, when it is a row whose tabs
   * differ — so a visit to a tab it lacks can say why.
   */
  subject?: TabSubject;
  /**
   * `null` at Organization scope, which has no resource identity up top.
   * `parents` is absent at a top-level scope and while a parent's name loads.
   */
  identity: { id: string; name: string; parents?: ScopeParent[] } | null;
  badges: ScopeBadge[];
  /** Still resolving the name. The rail is already correct; the words are not. */
  pending: boolean;
  /**
   * The URL names a resource that is not there — a 404 on the identity, and
   * nothing else (`use-scope-queries.ts`). The page renders a not-found screen;
   * the masthead has no name to show and does not invent one.
   */
  missing: boolean;
  /** The "Back to …" pill. `null` at Organization scope. */
  exit: { label: string; href: string } | null;
  /**
   * There *will* be a pill, but its label is a parent's name we have not fetched
   * yet. The rail holds the row's height so a deep link into an Environment or an
   * Application does not shift every item below it down by 44px once the name
   * lands — the rail itself is right from the first frame, and this is what stops
   * the one part of it that is late from moving the rest.
   */
  exitPending: boolean;
  /**
   * The masthead's switcher to sibling resources. `null` where there is nothing
   * to switch between, and the control is **absent rather than empty** wherever
   * that is so.
   *
   * Still `null` at service scope — Application, database, Compose — but the reason
   * has moved to this side. Every service is on `GET /environments/:id`, so
   * the siblings can now be named; what is missing is that `resolve-scope.ts`
   * would have to fetch the parent Environment at a scope that currently costs one
   * request. A decision, not a wall.
   */
  siblings: { label: string; items: ScopeSibling[] } | null;
};

const ScopeCtx = createContext<ScopeContext | null>(null);

export function useScope(): ScopeContext {
  const value = use(ScopeCtx);
  if (!value) throw new Error("useScope must be used inside <ScopeProvider>");
  return value;
}

/**
 * {@link useScope}, or `null` outside a `<ScopeProvider>` — for a control that
 * only makes sense inside a scope and should vanish rather than throw where
 * there is none (a panel rendered on its own in a test), such as Open a shell.
 */
export function useOptionalScope(): ScopeContext | null {
  return use(ScopeCtx);
}

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const value = useScopeValue();
  const owner = useRecentsOwner();
  const userId = owner?.userId ?? null;
  const organizationId = owner?.organizationId ?? null;
  const forgetVisited = useForgetVisited();

  // Recents is written here rather than at every call site that navigates, so a
  // pasted URL counts the same as a click. `recordRecent` no-ops when this
  // resource is already at the front, which is what makes it safe to run on
  // every identity change.
  //
  // It hangs off `identity` rather than off the URL, which is what keeps a
  // 404 out of the list: a resource nobody could name was never visited.
  const { identity, scope, missing } = value;
  //
  // The same resolved identity keeps a star's row current: a rename, a
  // parent's name that arrived after the click, or a star saved as a bare id
  // before stars had a list. `refreshStar` writes only for a starred id.
  useEffect(() => {
    const root = scopeRoot(scope);
    if (userId && organizationId && identity && scope.id && root) {
      recordRecent({ userId, organizationId }, visitOf(identity, root));
      refreshStar(userId, starOf(identity, root, organizationId));
    }
  }, [identity, scope, userId, organizationId]);

  // And a resource that *was* visited and has since gone — deleted in another
  // tab, by someone else, or through the API — leaves the list the first time
  // its scope answers 404. `missing` is a 404 and nothing else
  // (`use-scope-queries.ts`), so a backend that is down or a 403 drops nothing.
  useEffect(() => {
    if (missing && scope.id) forgetVisited([scope.id]);
  }, [missing, scope, forgetVisited]);

  // The instance's name ends the title, as the layout's template does.
  const product = brandName(useBrandingOrDefault());
  const title = scopeDocumentTitle(value, product);

  return (
    <ScopeCtx.Provider value={value}>
      {title ? <ScopeDocumentTitle title={title} /> : null}
      {children}
    </ScopeCtx.Provider>
  );
}

function useScopeValue(): ScopeContext {
  const pathname = usePathname();
  const scope = useMemo(() => scopeFromPath(pathname), [pathname]);
  const { organizationId } = useActiveOrganizationId();
  const q = useScopeQueries(scope, organizationId);
  // The Shell tab takes service:update. Fails open while the role is
  // read, like every gate built on this hook: the tab is there until the role
  // is known not to carry the action.
  const shellAllowed = usePermission({ service: ["update"] }).allowed;
  // An Application's Logs tab takes service:read, and fails open the same way.
  const logsAllowed = usePermission({ service: ["read"] }).allowed;

  // `resolveScope` is pure, so this memo is only about identity: every consumer
  // of the context re-renders when this object changes, and it must not change
  // because a query re-reported the same rows. `q` is memoized on those rows by
  // `useScopeQueries`, which is the hook that knows which of its fields matter.
  return useMemo(
    () => resolveScope(scope, q, { shellAllowed, logsAllowed }),
    [scope, q, shellAllowed, logsAllowed],
  );
}
