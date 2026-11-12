import dynamic from "next/dynamic";
import { createElement, type ComponentType } from "react";

import { TabPending } from "@/components/console/tab-pending";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";
import type { IconName } from "@/lib/design/icons";

import { APPLICATION_TABS } from "./tabs/application";
import { COMPOSE_TABS } from "./tabs/compose";
import { DATABASE_TABS } from "./tabs/database";
import { ENVIRONMENT_TABS } from "./tabs/environment";
import { PROJECT_TABS } from "./tabs/project";
import { SERVER_TABS } from "./tabs/server";

/**
 * Every tab of every resource scope, as data.
 *
 * **This is the seam the six Wave 4 sessions build against.** A scope's tabs are
 * declared once — slug, label, icon, and the panel that fills it — and the
 * things that used to be written three times each fall out of the one
 * declaration: the rail row (`nav.ts` reads these tables), the route (a tab that
 * is not declared 404s), the document title, the `<h1>` the panel renders, and
 * ⌘K's page list.
 *
 * The contract, in three lines:
 *
 * 1. **A phase owns its panel files and nothing else.** `panel` points at
 *    `src/features/<scope>/panels/<slug>.tsx`, and a Wave 4 phase replaces the
 *    contents of its own files. It never edits this file, `nav.ts`, or a route.
 * 2. **A genuinely new tab is one line here**, in the table for its scope, plus
 *    the panel file it names. Say so in the phase's own notes, because that line
 *    is the one thing in this file two sessions could collide on.
 * 3. **Panels are lazy.** Six tabs of a scope are six chunks, and opening a
 *    Server does not download its terminal.
 *
 * F07 ships every panel as a `TabPlaceholder`, so every tab of every scope
 * renders — which is what makes the whole route tree clickable before a single
 * feature exists.
 */

/** What a panel is handed. Everything it needs to fetch and to title itself. */
export type PanelProps = {
  /** The resource this scope is of, from the URL. */
  id: string;
  /**
   * The database engine — `postgres`, `redis` — at database scope, and `null`
   * everywhere else. Only a database panel reads it, and it needs it for every
   * request it makes: `GET /:id` is answerable only per engine.
   */
  kind: DatabaseKind | null;
  /** This tab's own name and mark, so the panel's `<h1>` cannot drift from the
   *  rail row that led here. */
  label: string;
  icon: IconName;
};

export type PanelComponent = ComponentType<PanelProps>;

/**
 * What a scope's own row says about which tabs it has. Structural, so a
 * scope's read satisfies it as it is: an Application's `aiModel` facet is what
 * makes it an **AI model**, whose tabs differ; its `cloudPlace` makes it a
 * Service in a Cloud account, which has a Runtime log tab; its
 * `sourceType` says whether there is a branch to preview or a source to patch.
 */
export type TabSubject = {
  aiModel?: object | null;
  cloudPlace?: object | null;
  sourceType?: string | null;
  /** A database's Cloud account: set, it runs no container. */
  cloudAccountId?: string | null;
  /**
   * Whether the caller's role holds `service:update`, which a shell takes.
   * `false` only when the role is known *not* to — `usePermission`
   * fails open, so a role still being read keeps the Shell tab.
   */
  shellAllowed?: boolean;
  /**
   * Whether the caller's role holds `service:read`, which a Runtime log
   * takes. `false` only when the role is known *not* to, as `shellAllowed`.
   */
  logsAllowed?: boolean;
  /** An Application's kind in Project config terms: a `cron` has no Logs tab. */
  configKind?: string | null;
};

export type TabEntry = {
  /** Relative to the scope. `""` is the scope's first tab — its root URL. */
  slug: string;
  label: string;
  icon: IconName;
  /**
   * A hairline above this row in the rail (e-console.html:340). Settings and
   * Advanced sit apart from the work; nothing else uses it.
   */
  ruleAbove?: true;
  /**
   * Why this row's resource has no such tab, or `null` when it has it.
   * Omitted is always there.
   *
   * It drives the rail and what the panel renders, **never the 404**: the
   * route answers from the slug alone, before any row is read
   * (`undeclared-tab.test.ts`), so a hidden tab is still a declared one and a
   * visit to it renders an `Outcome` (`scope-panel.tsx`) carrying this
   * sentence.
   *
   * **A reason rather than a yes or no**: it was a `visible`
   * predicate, and the one page a visit to any hidden tab rendered explained
   * the AI-model case — so `/logs` on an Application on a Server was told
   * about Model tabs. Each tab now says why it is absent for *this* row, and
   * a tab hidden for a new reason cannot be added without its sentence.
   */
  absentBecause?: (subject: TabSubject) => string | null;
  panel: PanelComponent;
};

/**
 * A tab's panel, lazily.
 *
 * `next/dynamic` rather than a bare `React.lazy` because it brings its own
 * Suspense boundary and, in a Client Component, its own code split — the panel
 * still prerenders, so a deep link into a tab is server-rendered rather than
 * blank until hydration (`02-guides/lazy-loading.md`).
 */
export function panel(
  load: () => Promise<{ default: PanelComponent }>,
): PanelComponent {
  return dynamic(load, { loading: () => createElement(TabPending) });
}

/** The six scopes that have tabs. Organization scope has pages, not tabs. */
export const TAB_REGISTRY = {
  server: SERVER_TABS,
  project: PROJECT_TABS,
  environment: ENVIRONMENT_TABS,
  application: APPLICATION_TABS,
  database: DATABASE_TABS,
  compose: COMPOSE_TABS,
} as const satisfies Record<string, readonly TabEntry[]>;

export type TabScopeKind = keyof typeof TAB_REGISTRY;

export function isTabScope(kind: string): kind is TabScopeKind {
  return kind in TAB_REGISTRY;
}

export function scopeTabEntries(kind: TabScopeKind): readonly TabEntry[] {
  return TAB_REGISTRY[kind];
}

/**
 * The tabs this row has, in order. A row still loading reads as having no
 * facet, which is what nearly every row is — so a plain one's rail never
 * shifts when it lands.
 */
export function visibleTabEntries(
  kind: TabScopeKind,
  subject: TabSubject | undefined,
): readonly TabEntry[] {
  return TAB_REGISTRY[kind].filter((entry) => !absentReason(entry, subject));
}

/** Why `entry` is not among this row's tabs, or `null` when it is. */
export function absentReason(
  entry: TabEntry,
  subject: TabSubject | undefined,
): string | null {
  return entry.absentBecause?.(subject ?? {}) ?? null;
}

/**
 * The tab a slug names, or `null` for one this scope does not have — which is
 * how a URL the rail never offered 404s instead of rendering an empty shell.
 */
export function tabEntry(kind: TabScopeKind, slug: string): TabEntry | null {
  return TAB_REGISTRY[kind].find((entry) => entry.slug === slug) ?? null;
}
