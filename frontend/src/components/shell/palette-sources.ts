import { useQueries, useQuery } from "@tanstack/react-query";

import { environmentsApi } from "@/lib/api/endpoints/environments";
import { projectsApi } from "@/lib/api/endpoints/projects";
import { serversApi } from "@/lib/api/endpoints/servers";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import type { IconName } from "@/lib/design/icons";

import { organizationNav } from "./nav";

/**
 * What ⌘K searches (e-console.html:2306-2400).
 *
 * Every row here comes from an endpoint, which is the whole reason the typed
 * prefixes are worth building: the palette can never offer something that is not
 * really there. Nothing is hand-written except the prefix list itself, and even
 * `go:`'s pages are read off the Organization nav table — so a phase that adds a
 * screen makes it findable by adding one row to `nav.ts`.
 *
 * ## Two of the reference's prefixes are missing, and why
 *
 * The prototype had `svc:` and `dep:`. **Neither can be answered
 * organization-wide.** An *Environment* names everything deployed in it —
 * `applications`,
 * `compose` and all six database controllers are still `findOne`-only, so that read
 * is the only list there is — but ⌘K searches the whole Organization, and reaching
 * every service means one request per Environment. Deployments are a second
 * fan-out on top: they are listable only by an owner id, which is what that first
 * one would produce. A prefix that matches nothing is worse than one that is not
 * offered, and a prefix that costs the fleet is worse than both. `run:` and `acct:`
 * belonged to the unbuilt provisioning work and are out for good.
 */

export type PaletteKind = "proj" | "env" | "srv" | "go";

export type PaletteResult = {
  kind: PaletteKind;
  icon: IconName;
  name: string;
  /** The line that tells two same-named things apart. Never decoration. */
  hint: string;
  href: string;
};

/**
 * Everything the palette says about a kind, in one row per prefix: the tip, and
 * the words an empty result uses.
 */
export const PREFIXES: {
  prefix: PaletteKind;
  icon: IconName;
  description: string;
  /** "No Server matches …". */
  noun: string;
  /** "Servers could not be loaded …". */
  plural: string;
  /** Said only when the source answered, and answered with nothing. */
  noneYet: string;
}[] = [
  {
    prefix: "proj",
    icon: "folder",
    description: "Search Projects",
    noun: "Project",
    plural: "Projects",
    noneYet: "No Projects yet. Create one under Projects.",
  },
  {
    prefix: "env",
    icon: "list",
    description: "Search Environments",
    noun: "Environment",
    plural: "Environments",
    noneYet: "No Environments yet. Create one inside a Project.",
  },
  {
    prefix: "srv",
    icon: "hdd",
    description: "Search Servers",
    noun: "Server",
    plural: "Servers",
    noneYet: "No Servers yet. Add one under Servers.",
  },
  {
    prefix: "go",
    icon: "search",
    description: "Jump to a page",
    noun: "page",
    plural: "Pages",
    // Unreachable while the Organization nav table has any page in it.
    noneYet: "No pages to jump to.",
  },
];

/** Every Organization-scope destination, from the one table that defines them. */
function pages(): PaletteResult[] {
  return organizationNav().flatMap((entry) =>
    (entry.kind === "item" || entry.kind === "group") && entry.tab !== undefined
      ? [
          {
            kind: "go" as const,
            icon: entry.icon,
            name: entry.label,
            hint: "page",
            href: entry.tab,
          },
        ]
      : [],
  );
}

/**
 * Fetched only while the palette is open, and cached after that — so the first
 * ⌘K of a session costs requests and every later one costs none.
 */
export function usePaletteSources(open: boolean): {
  results: PaletteResult[];
  pending: boolean;
  /**
   * The kinds whose rows could not be read — a refused or failed request.
   * Their absence from `results` says nothing about whether any exist, so an
   * empty result must not say "none yet" for them: a role without
   * `server: ['read']` gets a 403 here on an instance full of Servers.
   */
  unavailable: PaletteKind[];
} {
  const { organizationId } = useActiveOrganizationId();
  const enabled = open && organizationId !== null;

  const servers = useQuery({
    queryKey: keys.servers.list(organizationId),
    queryFn: () => serversApi.list(),
    enabled,
  });

  const projects = useQuery({
    queryKey: keys.projects.list(organizationId),
    queryFn: () => projectsApi.list(),
    enabled,
  });

  // Environments are listed per Project — `GET /environments` takes a
  // `projectId` and there is no org-wide route — so this is one request per
  // Project, fanned out rather than chained.
  const rows = projects.data ?? [];
  const environments = useQueries({
    queries: rows.map((project) => ({
      queryKey: keys.environments.byProject(organizationId, project.projectId),
      queryFn: () => environmentsApi.listByProject(project.projectId),
      enabled,
    })),
    combine: (results) => ({
      byProject: results.map((result) => result.data ?? []),
      pending: results.some((result) => result.isPending),
      failed: results.some((result) => result.isError),
    }),
  });

  const results: PaletteResult[] = [
    ...rows.map(
      (project): PaletteResult => ({
        kind: "proj",
        icon: "folder",
        name: project.name,
        hint: project.description || "Project",
        href: `/projects/${project.projectId}`,
      }),
    ),
    ...environments.byProject.flatMap((list, index) =>
      list.map(
        (environment): PaletteResult => ({
          kind: "env",
          icon: "list",
          // The Project in front, because "production" on its own names nothing.
          name: `${rows[index]?.name ?? ""} / ${environment.name}`,
          hint: "Environment",
          href: `/environments/${environment.environmentId}`,
        }),
      ),
    ),
    ...(servers.data ?? []).map(
      (server): PaletteResult => ({
        kind: "srv",
        icon: "hdd",
        name: server.name,
        hint: `${server.ipAddress} · ${server.serverType} server`,
        href: `/servers/${server.serverId}`,
      }),
    ),
    ...pages(),
  ];

  // Environments hang off the Project list, so a Project list that failed is
  // an Environment list nobody could ask for.
  const unavailable: PaletteKind[] = [
    ...(projects.isError ? (["proj", "env"] as const) : []),
    ...(!projects.isError && environments.failed ? (["env"] as const) : []),
    ...(servers.isError ? (["srv"] as const) : []),
  ];

  return {
    results,
    pending: servers.isPending || projects.isPending || environments.pending,
    unavailable,
  };
}

/** How many rows the list will show. Past this, typing is faster than scrolling. */
const LIMIT = 40;

export type PaletteQuery = {
  /** The prefix that was typed, if it was one we know. */
  kind: PaletteKind | null;
  /** What is left after the prefix. */
  term: string;
  results: PaletteResult[];
};

export function filterPalette(
  all: PaletteResult[],
  query: string,
): PaletteQuery {
  const match = /^([a-z]+):\s*(.*)$/i.exec(query);
  const typed = match?.[1].toLowerCase();
  const kind =
    PREFIXES.find((each) => each.prefix === typed)?.prefix ?? null;
  const term = (kind ? (match?.[2] ?? "") : query).trim().toLowerCase();

  return {
    kind,
    term,
    results: all
      .filter((row) => (kind === null || row.kind === kind))
      .filter(
        (row) =>
          term === "" ||
          `${row.name} ${row.hint}`.toLowerCase().includes(term),
      )
      .slice(0, LIMIT),
  };
}
