import type { IconName } from "@/lib/design/icons";
import {
  isTabScope,
  scopeTabEntries,
  visibleTabEntries,
  type TabEntry,
  type TabSubject,
} from "@/lib/shell/tab-registry";

import { scopeRoot, type ScopeKind, type ScopeRoute } from "./scope";

/**
 * The whole navigation model (e-console.html:1994-2050).
 *
 * **At a resource scope the rail items *are* the tabs**, which is the reference's
 * actual behaviour (e-console.html:2095-2103) — so those tables are not written
 * here. They are `src/lib/shell/tab-registry.ts`, where the same declaration
 * that names a tab also names the panel that fills it. One line per screen, and
 * a rail row cannot exist without a panel or a panel without a row.
 *
 * What stays here is **Organization scope**, which has pages rather than tabs,
 * and the questions the rail and the masthead ask about *any* scope: which table,
 * which row is lit, what "Back to …" goes back to.
 *
 * Four departures from the prototype's tables, each forced by something real:
 *
 * - **Cloud accounts, Provision, Terraform runs and Managed runtime are gone.**
 *   They have no backend at all (`00-INDEX.md`, locked decision 1), and the rule
 *   is no rail entry rather than a disabled one. That empties the prototype's
 *   "Servers" group of everything but Fleet, so Servers is a plain item now: a
 *   group with one child is not a group.
 * - **The Environment's "Runtime" tab is gone** — it read `environment.runtime`,
 *   which the prototype itself marked as proposed and the schema does not have.
 * - **Templates is new.** The prototype has no row for it and the backend has a
 *   whole `templates` module; F17 builds the screen.
 * - **Requests is new too** (F14). Same shape of reason as Templates: the
 *   prototype has no such screen and the backend has the whole access-log
 *   analytics surface. The row is argued where it sits, below.
 * - **A service is three scopes, not one.** `SVC_NAV` covered applications,
 *   databases and Compose stacks alike; ours are three tables, because a managed
 *   database has neither a Deployment list nor a domain and pretending otherwise
 *   is a rail row that leads nowhere (`tabs/database.ts`).
 */

export type NavItem = {
  kind: "item";
  icon: IconName;
  label: string;
  /** Relative to the scope — `""` is the scope's first tab. Absolute at org scope. */
  tab: string;
  /** A quiet marker on the right. Never a status; a status belongs in the page. */
  tag?: string;
};

export type NavGroup = {
  kind: "group";
  icon: IconName;
  label: string;
  /** Identity for the open/closed state, which outlives a re-render. */
  id: string;
  /** A group may also be a destination of its own. The chevron stays separate. */
  tab?: string;
  /** Where the children come from — live data, resolved by the rail. */
  source: "projects" | "recents" | "starred";
};

export type NavEntry =
  | NavItem
  | NavGroup
  /** A quiet heading over the rows beneath it. Sentence case, never shouted. */
  | { kind: "label"; label: string }
  /** The rule that separates settings from the work (e-console.html:340). */
  | { kind: "rule" };

const ORGANIZATION_NAV: NavEntry[] = [
  { kind: "item", icon: "home", label: "Organization home", tab: "/" },
  {
    kind: "group",
    icon: "clock",
    label: "Recents",
    id: "recents",
    source: "recents",
  },
  // Beside Recents because it is the same kind of list — this browser's, per
  // person — and the star in every resource header is what fills it.
  {
    kind: "group",
    icon: "star",
    label: "Starred",
    id: "starred",
    source: "starred",
  },
  { kind: "item", icon: "hdd", label: "Servers", tab: "/servers" },
  { kind: "label", label: "Observe" },
  { kind: "item", icon: "rocket", label: "Deployments", tab: "/deployments" },
  { kind: "item", icon: "activity", label: "Monitoring", tab: "/monitoring" },
  // **Requests is F14's one row, and the fifth departure from the prototype.**
  // The reference has no request-analytics screen at all — it renders a
  // "Requests, all services" chart in three asides and nothing behind them —
  // while the backend has `POST /monitoring/requests/logs`, `/stats` and the
  // Traefik access-log switch, which is a screen's worth of real data. It sits
  // under Observe beside the other two because it answers the same question at a
  // different layer: Monitoring is what the hosts are doing, this is what the
  // internet asked them for.
  //
  // Offered to every reader, the Hosted instance's customers included: it reads
  // each Server's own access log, not only the platform host's.
  { kind: "item", icon: "globe", label: "Requests", tab: "/requests" },
  { kind: "label", label: "Build" },
  {
    kind: "group",
    icon: "folder",
    label: "Projects",
    id: "projects",
    tab: "/projects",
    source: "projects",
  },
  { kind: "item", icon: "book", label: "Templates", tab: "/templates" },
  { kind: "rule" },
  // F16 renamed this from "Organization settings". The surface below it now
  // holds the signed-in person's account and the whole instance's platform
  // controls as well as the Organization's, so the old label was true of four of
  // its twelve sections. `⌘K`'s `go:` pages are read off this table, so the
  // palette follows for free.
  { kind: "item", icon: "cog", label: "Settings", tab: "/settings" },
];

/** A tab, as a rail row. The `ruleAbove` flag becomes the rule before it. */
function navFromTabs(tabs: readonly TabEntry[]): NavEntry[] {
  return tabs.flatMap((entry) => [
    ...(entry.ruleAbove ? [{ kind: "rule" } as const] : []),
    {
      kind: "item" as const,
      icon: entry.icon,
      label: entry.label,
      tab: entry.slug,
    },
  ]);
}

/**
 * Which table the rail renders. The only reason `scopeFromPath` exists.
 *
 * `subject` is the scope's own row, when it has been read: an AI model's
 * tabs are not a plain Application's (`TabEntry.absentBecause`).
 */
export function scopeNav(scope: ScopeRoute, subject?: TabSubject): NavEntry[] {
  if (scope.kind === "organization") return ORGANIZATION_NAV;
  return isTabScope(scope.kind)
    ? navFromTabs(visibleTabEntries(scope.kind, subject))
    : [];
}

/** Every page Organization scope offers, for ⌘K's `go:` rows. */
export function organizationNav(): NavEntry[] {
  return ORGANIZATION_NAV;
}

/**
 * Every tab a scope really has, so an invented one 404s instead of rendering an
 * empty shell.
 */
export function scopeTabs(kind: ScopeKind): string[] {
  return isTabScope(kind)
    ? scopeTabEntries(kind).map((entry) => entry.slug)
    : [];
}

/**
 * The screen a tab names — its `<h1>`, its icon and its document title. `null`
 * for a tab this scope does not have, which is how a route 404s instead of
 * rendering an empty shell.
 *
 * Organization scope answers from its own table, because its rows are pages
 * rather than tabs and their `tab` is an absolute path.
 */
export function tabScreen(
  kind: ScopeKind,
  tab: string,
): { label: string; icon: IconName } | null {
  if (isTabScope(kind)) {
    const entry = scopeTabEntries(kind).find((each) => each.slug === tab);
    return entry ? { label: entry.label, icon: entry.icon } : null;
  }
  for (const entry of ORGANIZATION_NAV) {
    if (entry.kind !== "item" && entry.kind !== "group") continue;
    if (entry.tab === tab) return { label: entry.label, icon: entry.icon };
  }
  return null;
}

/**
 * Where leaving this scope goes back to — the "Back to …" pill, rendered only
 * off Organization scope (e-console.html:2104-2110).
 *
 * A Server goes back to the fleet and a Project to the Projects list, both of
 * which are fixed pages. An Environment goes back to *its* Project, and each of
 * the three service scopes to *its* Environment — so those need a name and an id
 * that only the fetched identity has, which is why this takes them rather than
 * working them out.
 */
export function scopeExit(
  scope: ScopeRoute,
  parent: { label: string; href: string } | null,
): { label: string; href: string } | null {
  if (scope.kind === "server")
    return { label: "Back to Servers", href: "/servers" };
  if (scope.kind === "project")
    return { label: "Back to Projects", href: "/projects" };
  if (scope.kind === "organization") return null;
  return parent
    ? { label: `Back to ${parent.label}`, href: parent.href }
    : null;
}

/**
 * Whether a rail row is the one lit. At a resource scope the comparison is on
 * the tab; at Organization scope the row's `tab` *is* an absolute href, and a
 * section's rows stay lit for the pages under them (`/servers/…` keeps Servers
 * lit only at the list, since a Server has its own scope — but `/settings/…`
 * does not, and would).
 */
export function isCurrent(
  scope: ScopeRoute,
  entry: NavItem | NavGroup,
): boolean {
  if (entry.tab === undefined) return false;
  if (scope.kind !== "organization") return entry.tab === scope.tab;
  if (entry.tab === "/") return scope.tab === "/";
  return scope.tab === entry.tab || scope.tab.startsWith(`${entry.tab}/`);
}

/** The absolute href for a row, at whatever scope it belongs to. */
export function entryHref(scope: ScopeRoute, tab: string): string {
  const root = scopeRoot(scope);
  return root === null ? tab : tab ? `${root}/${tab}` : root;
}
