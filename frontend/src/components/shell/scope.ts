import {
  isDatabaseKind,
  type DatabaseKind,
} from "@/lib/api/endpoints/databases";

/**
 * What scope the operator is in, read off the URL.
 *
 * The rail is a scope, not a menu (e-console.html:8-63): entering a Server, a
 * Project, an Environment or a service *replaces* the whole rail with that
 * resource's own navigation and rewrites the masthead to its identity. Which
 * scope that is has to be derivable from the path alone, with no fetch and no
 * component state — otherwise a deep link to a nested route paints the
 * Organization rail first and then swaps, and the signature reads as a glitch.
 *
 * So this file is pure. Give it a pathname, get the scope. Everything that
 * needs a *name* — the masthead's identity, the "Back to …" pill — hangs off
 * `scope-provider.tsx`, which fetches on top of what this already decided.
 *
 * ## Why the routes are flat
 *
 * `/environments/<id>` and not `/projects/<id>/environments/<id>`. Three
 * reasons, and the first is the one that settles it:
 *
 * 1. **The API is flat.** `GET /environments/:id` and `GET /applications/:id`
 *    take one id and no parent. A URL carrying a parent id the endpoint does not
 *    want is a URL that can disagree with the data it renders.
 * 2. Every id is globally unique (`environmentId`, `applicationId`), so the
 *    parent adds no addressing.
 * 3. The parent chain is data, not routing — and it is data we have to fetch
 *    anyway, because the "Back to …" pill needs the parent's *name*, which no
 *    URL carries. `ApplicationDetail` hands over `environment.project` in the
 *    same response, so the chain costs nothing.
 *
 * ## The one segment that is not an id
 *
 * `/databases/postgres/<id>`. A database's engine is in the URL because
 * `GET /:id` is only answerable once you know *which of the six controllers* to
 * ask (`endpoints/databases.ts`) — and a browser reload has nothing but the URL.
 * That is the opposite of a parent id: it is not addressing that could disagree
 * with the row, it is the row's own type, and the row confirms it.
 */

/** The seven scopes. A service is three of them, because their navigation is. */
export type ScopeKind =
  | "organization"
  | "server"
  | "project"
  | "environment"
  | "application"
  | "database"
  | "compose";

export type ScopeRoute = {
  kind: ScopeKind;
  /** The resource this scope is *of*. `null` only at Organization scope. */
  id: string | null;
  /**
   * Which flavour of the resource, where the resource has flavours and one
   * segment cannot say — the database engine, and nothing else so far.
   */
  variant: DatabaseKind | null;
  /**
   * Which rail item is lit.
   *
   * At a resource scope the rail items **are** the tabs, which is the
   * reference's actual behaviour (e-console.html:2095-2103) — so this is the
   * path segment after the id, and `""` is the first tab. At Organization scope
   * there is no resource, so it is the whole pathname.
   */
  tab: string;
};

/**
 * First segment → the scope entering it opens, and how many segments after it
 * make up the resource's address. Everything else is the Organization.
 */
const RESOURCE_SEGMENT = {
  servers: { kind: "server", depth: 1 },
  projects: { kind: "project", depth: 1 },
  environments: { kind: "environment", depth: 1 },
  applications: { kind: "application", depth: 1 },
  compose: { kind: "compose", depth: 1 },
  /** `/databases/<engine>/<id>` — the engine, then the id. */
  databases: { kind: "database", depth: 2 },
} as const satisfies Record<string, { kind: ScopeKind; depth: 1 | 2 }>;

type ResourceSegment = keyof typeof RESOURCE_SEGMENT;

const ORGANIZATION = (segments: string[]): ScopeRoute => ({
  kind: "organization",
  id: null,
  variant: null,
  tab: `/${segments.join("/")}`,
});

/**
 * `/servers` is Organization scope (it is the fleet list); `/servers/<id>` is
 * Server scope. The id is what makes a scope, which is why the check is on
 * length rather than on the first segment alone.
 *
 * An engine this app does not have falls back to Organization scope rather than
 * opening a database rail over nothing — `/databases/sqlserver/x` is not a
 * database, it is a bad URL, and the route it lands on says so.
 */
export function scopeFromPath(pathname: string): ScopeRoute {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0] as ResourceSegment | undefined;
  const entry = first ? RESOURCE_SEGMENT[first] : undefined;

  if (!entry || segments.length < 1 + entry.depth) return ORGANIZATION(segments);

  if (entry.depth === 2) {
    const variant = segments[1];
    if (!isDatabaseKind(variant)) return ORGANIZATION(segments);
    return {
      kind: entry.kind,
      id: segments[2],
      variant,
      tab: segments.slice(3).join("/"),
    };
  }

  return {
    kind: entry.kind,
    id: segments[1],
    variant: null,
    tab: segments.slice(2).join("/"),
  };
}

/** Where a scope's tabs hang. `null` at Organization scope, which has no root. */
export function scopeRoot(scope: ScopeRoute): string | null {
  if (scope.kind === "organization" || scope.id === null) return null;
  const segment = (Object.keys(RESOURCE_SEGMENT) as ResourceSegment[]).find(
    (key) => RESOURCE_SEGMENT[key].kind === scope.kind,
  );
  const address = scope.variant ? `${scope.variant}/${scope.id}` : scope.id;
  return `/${segment}/${address}`;
}

/** The href a rail item at this scope points at. `""` is the scope's first tab. */
export function tabHref(scope: ScopeRoute, tab: string): string {
  const root = scopeRoot(scope);
  if (root === null) return tab || "/";
  return tab ? `${root}/${tab}` : root;
}

/** The address of one database, for a link that has the engine and the id. */
export function databaseHref(kind: DatabaseKind, databaseId: string): string {
  return `/databases/${kind}/${databaseId}`;
}
