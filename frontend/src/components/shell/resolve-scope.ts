import { COMPOSE_TYPE_LABEL } from "@/lib/api/endpoints/compose";
import { DATABASE_LABEL } from "@/lib/api/endpoints/databases";
import { serverMark } from "@/lib/design/server-mark";

import { scopeExit, scopeNav } from "./nav";
import { scopeRoot, type ScopeRoute } from "./scope";
import type { ScopeContext, ScopeParent, ScopeSibling } from "./scope-provider";
import type { ScopeQueries } from "./use-scope-queries";

/**
 * Fetched rows → what the masthead and the rail render.
 *
 * A pure function, one branch per scope, so the answer for each scope can be read
 * in one place — and so `scope-provider.tsx` is only the context and the wiring.
 * Adding a badge or changing an identity is a change here and nowhere else.
 */
export function resolveScope(
  scope: ScopeRoute,
  q: ScopeQueries,
  caller: CallerFacts = {},
): ScopeContext {
  const context = resolveFound(scope, q, caller);
  // A scope that answered 404 has no tabs to offer: every one of them
  // leads to the same not-found screen, so the rail keeps only its way out
  // ("Back to …") rather than a full tab list with Settings lit over nothing.
  return q.missing ? { ...context, nav: [] } : context;
}

/**
 * What the caller may do, where it decides a service's tabs: whether
 * their role holds `service:update`, which the Shell tab takes, and
 * `service:read`, which an Application's Logs tab takes. Absent reads as
 * allowed, the direction `usePermission` fails in.
 */
export type CallerFacts = { shellAllowed?: boolean; logsAllowed?: boolean };

function resolveFound(
  scope: ScopeRoute,
  q: ScopeQueries,
  caller: CallerFacts,
): ScopeContext {
  const nav = scopeNav(scope);
  const base = {
    scope,
    nav,
    pending: false,
    badges: [],
    siblings: null,
    exitPending: false,
    // A URL naming a resource that is not there. The rail and the masthead go
    // quiet rather than describing something that does not exist, and the page
    // renders the not-found screen (`scope-panel.tsx`).
    //
    // It also ends `exitPending` in every branch below, which is a defect found
    // by driving a bad id: the rail *holds* the "Back to …" row while a parent's
    // name loads, so that a deep link does not shift the tabs down by 44px when
    // it lands — and a name that is never coming left an empty pill sitting there
    // for good. Nothing is pending once we know there is nothing to name.
    missing: q.missing,
  };

  if (scope.kind === "server") {
    const row = q.server.data;
    return {
      ...base,
      pending: q.server.isPending,
      identity: row ? { id: row.serverId, name: row.name } : null,
      badges: row
        ? [
            { kind: "mark", mark: serverMark(row) },
            { kind: "chip", label: `${row.serverType} server` },
          ]
        : [],
      exit: scopeExit(scope, null),
      siblings: siblingsOf("Servers", q.servers.data, (each) => ({
        id: each.serverId,
        name: each.name,
        href: `/servers/${each.serverId}`,
      })),
    };
  }

  if (scope.kind === "project") {
    const row = q.project.data;
    return {
      ...base,
      pending: q.project.isPending,
      identity: row ? { id: row.projectId, name: row.name } : null,
      badges: [{ kind: "chip", label: "project" }],
      exit: scopeExit(scope, null),
      siblings: siblingsOf("Projects", q.projects.data, (each) => ({
        id: each.projectId,
        name: each.name,
        href: `/projects/${each.projectId}`,
      })),
    };
  }

  if (scope.kind === "environment") {
    const row = q.environment.data;
    const parent = q.environmentParent.data;
    return {
      ...base,
      pending: q.environment.isPending,
      identity: row
        ? {
            id: row.environmentId,
            name: row.name,
            parents: parent
              ? [
                  {
                    id: parent.projectId,
                    name: parent.name,
                    href: rootOf("project", parent.projectId),
                  },
                ]
              : undefined,
          }
        : null,
      badges: [{ kind: "chip", label: "environment" }],
      exit: scopeExit(
        scope,
        parent
          ? { label: parent.name, href: `/projects/${parent.projectId}` }
          : null,
      ),
      exitPending: !q.missing && parent === undefined,
      siblings: siblingsOf(
        parent ? `Environments in ${parent.name}` : "Environments",
        q.environments.data,
        (each) => ({
          id: each.environmentId,
          name: each.name,
          href: `/environments/${each.environmentId}`,
        }),
      ),
    };
  }

  if (scope.kind === "application") {
    const row = q.application.data;
    // Which tabs it has depends on what it is, and the Shell
    // tab on who is asking.
    const subject = { ...row, ...caller };
    return {
      ...base,
      nav: scopeNav(scope, subject),
      subject,
      pending: q.application.isPending,
      identity: row
        ? {
            id: row.applicationId,
            name: row.name,
            parents: serviceParents(row.environment),
          }
        : null,
      badges: row ? [{ kind: "status", status: row.applicationStatus }] : [],
      exit: scopeExit(
        scope,
        row
          ? {
              label: row.environment.name,
              href: `/environments/${row.environment.environmentId}`,
            }
          : null,
      ),
      exitPending: !q.missing && row === undefined,
    };
  }

  // The two other services. Both carry the same joined `environment.project` an
  // Application does, so both cost one request — and both wear a chip naming
  // what they *are*, because "storefront-db" beside a status pill does not say
  // whether it is a Postgres or a Redis, and the engine is the first thing an
  // operator needs to know.
  if (scope.kind === "database") {
    const row = q.database.data;
    // The Shell tab: absent in a Cloud account and for a role without
    // service:update.
    const subject = { cloudAccountId: row?.cloudAccountId ?? null, ...caller };
    return {
      ...base,
      nav: scopeNav(scope, subject),
      subject,
      pending: q.database.isPending,
      identity: row
        ? {
            id: row.databaseId,
            name: row.name,
            parents: serviceParents(row.environment),
          }
        : null,
      badges: row
        ? [
            { kind: "status", status: row.applicationStatus },
            { kind: "chip", label: DATABASE_LABEL[row.kind] },
          ]
        : [],
      exit: scopeExit(
        scope,
        row
          ? {
              label: row.environment.name,
              href: `/environments/${row.environment.environmentId}`,
            }
          : null,
      ),
      exitPending: !q.missing && row === undefined,
    };
  }

  if (scope.kind === "compose") {
    const row = q.compose.data;
    // The Shell tab: absent for a role without service:update.
    const subject = { ...caller };
    return {
      ...base,
      nav: scopeNav(scope, subject),
      subject,
      pending: q.compose.isPending,
      identity: row
        ? {
            id: row.composeId,
            name: row.name,
            parents: serviceParents(row.environment),
          }
        : null,
      badges: row
        ? [
            { kind: "status", status: row.composeStatus },
            { kind: "chip", label: COMPOSE_TYPE_LABEL[row.composeType] },
          ]
        : [],
      exit: scopeExit(
        scope,
        row
          ? {
              label: row.environment.name,
              href: `/environments/${row.environment.environmentId}`,
            }
          : null,
      ),
      exitPending: !q.missing && row === undefined,
    };
  }

  return { ...base, identity: null, exit: null };
}

/**
 * A service's Project and Environment, outermost first.
 *
 * **The Project too, not only the Environment**. The header read
 * `production / storefront`, and two Projects that each have a `production` gave
 * two headers — and two Recents rows — that could not be told apart. Every
 * service's `findOne` already joins `environment.project`, so naming it costs
 * nothing.
 */
function serviceParents(environment: {
  environmentId: string;
  name: string;
  project: { projectId: string; name: string };
}): ScopeParent[] {
  return [
    {
      id: environment.project.projectId,
      name: environment.project.name,
      href: rootOf("project", environment.project.projectId),
    },
    {
      id: environment.environmentId,
      name: environment.name,
      href: rootOf("environment", environment.environmentId),
    },
  ];
}

/** A parent's scope root, from `scope.ts` rather than spelled again here. */
function rootOf(kind: "project" | "environment", id: string): string {
  return scopeRoot({ kind, id, variant: null, tab: "" }) ?? "/";
}

/** A switcher with one entry is not a switcher — it is the resource you are on. */
function siblingsOf<T>(
  label: string,
  rows: T[] | undefined,
  toSibling: (row: T) => ScopeSibling,
): { label: string; items: ScopeSibling[] } | null {
  if (!rows || rows.length < 2) return null;
  return { label, items: rows.map(toSibling) };
}
