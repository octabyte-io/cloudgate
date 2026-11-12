import type { DeploymentOwner } from "@/components/console/rows/deployment-row";
import type {
  DeploymentFeedRow,
  DeploymentOwnerType,
} from "@/lib/api/endpoints/deployments";

/**
 * What a feed row is *about*, in the words and links the table shows.
 *
 * Pure, and in its own file, because this is where the organization-wide feed
 * differs from every per-service list the console had before it
 * a row can be a
 * service's own build, a cron entry's run, a volume backup or a database backup,
 * and three of those five are not services. A screen that assumed "the owner is
 * the Application" is what the by-service feed could afford to assume.
 */

/** What ran, when the row is not a service's own build. */
const RUN_KIND: Record<DeploymentOwnerType, string | null> = {
  application: null,
  compose: null,
  schedule: "Scheduled run",
  volumeBackup: "Volume backup",
  backup: "Database backup",
  environmentNetwork: "Environment network",
  postgres: "Cloud run",
  mysql: "Cloud run",
  bucket: "Cloud run",
  redis: "Cloud run",
};

/** "Storefront / production", or null for a run that owns no service. */
export function whereItRan(row: DeploymentFeedRow): string | null {
  if (!row.project || !row.environment) return null;
  return `${row.project.name} / ${row.environment.name}`;
}

/**
 * The Service column: what to call the row's owner, where to follow it, and the
 * quieter line under it.
 *
 * The sub-line carries **both** facts a mixed feed needs — what kind of run this
 * was, when it was not a build, and where it happened. A build gets only the
 * place, because "Deployment · Storefront / production" would be noise.
 *
 * **No link for the one row with no address**, and no label either: a Server or
 * Cloudgate-host schedule belongs to the Organization directly, so the feed
 * carries no Environment for it and there is no screen to link to. The table
 * prints "Unknown" there rather than a link that goes somewhere else — the run
 * itself, its status and its log are still on the row.
 *
 * That row still gets its sub-line. Returning `null` outright took the *kind* of
 * run down with the link
 * — "Scheduled
 * run", already computed one line above — and it is the one row on this feed
 * with nothing else to infer it from, since every other row can be read off its
 * Environment.
 */
export function ownerCell(row: DeploymentFeedRow): DeploymentOwner | null {
  // A Cron service's run hangs off the Cron service, as its builds do, and
  // is told from them by its mark.
  const kind = row.cronRun ? "Run" : RUN_KIND[row.owner.type];
  const where = whereItRan(row);
  const path = [kind, where].filter(Boolean).join(" · ") || undefined;

  if (row.owner.type === "application") {
    return {
      label: row.owner.name,
      href: `/applications/${row.owner.id}/deployments`,
      path,
    };
  }
  if (row.owner.type === "compose") {
    return {
      label: row.owner.name,
      href: `/compose/${row.owner.id}/deployments`,
      path,
    };
  }
  // A run resolves to a service to be scoped and named, but the feed carries
  // only the owner's id — so the Environment it ran in is the nearest thing this
  // row can address, and it is also where its service is listed.
  if (row.environment) {
    return {
      label: row.owner.name,
      href: `/environments/${row.environment.environmentId}`,
      path,
    };
  }
  // Nothing to address, but `path` here is the run kind on its own — `whereItRan`
  // is null — so the cell is a dash *with* a sub-line rather than a dash alone.
  // The `null` is what the type asks for rather than a case that reaches
  // it: every owner type still live at this line has a `RUN_KIND`, and the two
  // that do not returned above.
  return path ? { path } : null;
}

/**
 * What the log dialog calls the thing, for the one sentence that names it.
 *
 * Only reached for a row with no description of its own, which in practice
 * means a build: every run the backend records writes one (`run-recorder`).
 */
export function ownerNoun(row: DeploymentFeedRow): string {
  if (row.owner.type === "compose") return "stack";
  if (row.owner.type === "application") return "Application";
  if (row.owner.type === "environmentNetwork") return "Environment network";
  return "service";
}

/** Whether a row belongs to one of the services this session has opened. */
export function ownedByOneOf(
  row: DeploymentFeedRow,
  serviceIds: readonly string[],
): boolean {
  if (row.owner.type !== "application" && row.owner.type !== "compose") {
    return false;
  }
  return serviceIds.includes(row.owner.id);
}

/**
 * The Projects these rows came from, for the filter — by name, deduplicated.
 *
 * Taken from the rows rather than from `GET /projects` on purpose: a Project
 * with nothing deployed in it is a filter that can only ever empty the table.
 */
export function projectsIn(
  rows: readonly DeploymentFeedRow[],
): { id: string; name: string }[] {
  const found = new Map<string, string>();
  for (const row of rows) {
    if (row.project) found.set(row.project.projectId, row.project.name);
  }
  return [...found]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
