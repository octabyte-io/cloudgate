import { describe, expect, it } from "vitest";

import type {
  DeploymentFeedRow,
  DeploymentOwnerType,
} from "@/lib/api/endpoints/deployments";

import { ownedByOneOf, ownerCell, ownerNoun, projectsIn } from "./feed-rows";

/**
 * The organization-wide feed carries rows the by-service feed could never
 * produce — a cron entry's run, a volume backup, a database backup, and a
 * host-level schedule that belongs to no Environment at all
 * Every one of
 * those reaches this table, so every one of them is pinned here.
 */

function row(
  over: Partial<DeploymentFeedRow> & {
    owner?: { type: DeploymentOwnerType; id: string; name: string };
  } = {},
): DeploymentFeedRow {
  return {
    deploymentId: "dep-1",
    title: "Deployment",
    description: null,
    status: "done",
    logPath: "/etc/cloudgate/logs/api/dep-1.log",
    applicationId: null,
    composeId: null,
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: "2026-08-19T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    owner: { type: "application", id: "app-1", name: "api" },
    project: { projectId: "prj-1", name: "Storefront" },
    environment: { environmentId: "env-1", name: "production" },
    ...over,
  };
}

describe("ownerCell", () => {
  it("sends a build to the service's own Deployments tab", () => {
    expect(ownerCell(row())).toEqual({
      label: "api",
      href: "/applications/app-1/deployments",
      path: "Storefront / production",
    });

    expect(
      ownerCell(row({ owner: { type: "compose", id: "cmp-1", name: "stack" } })),
    ).toEqual({
      label: "stack",
      href: "/compose/cmp-1/deployments",
      path: "Storefront / production",
    });
  });

  it("marks a Cron service's run as a run, under the Cron service", () => {
    expect(
      ownerCell(
        row({
          owner: { type: "application", id: "app-1", name: "report" },
          cronRun: {
            job: "report-run-abcd1234",
            image: "report:latest",
            startedBy: { kind: "member", userId: "u-1", name: "Ida Rhodes" },
          },
        }),
      ),
    ).toEqual({
      label: "report",
      href: "/applications/app-1/deployments",
      path: "Run · Storefront / production",
    });
    expect(ownerCell(row({ cronRun: null }))?.path).toBe(
      "Storefront / production",
    );
  });

  /**
   * The three run kinds are the rows the old feed could not reach at all: it
   * walked services, and these hang off a cron entry or a backup. The sub-line
   * has to say which kind it was, or a Postgres instance appearing in a
   * Deployments feed is unexplained.
   */
  it("names the run and links where it ran, for the three kinds that are not builds", () => {
    expect(
      ownerCell(row({ owner: { type: "schedule", id: "sch-1", name: "nightly" } })),
    ).toEqual({
      label: "nightly",
      href: "/environments/env-1",
      path: "Scheduled run · Storefront / production",
    });

    expect(
      ownerCell(
        row({ owner: { type: "volumeBackup", id: "vb-1", name: "uploads" } }),
      )?.path,
    ).toBe("Volume backup · Storefront / production");

    expect(
      ownerCell(row({ owner: { type: "backup", id: "bk-1", name: "orders" } }))
        ?.path,
    ).toBe("Database backup · Storefront / production");
  });

  /**
   * A Server or Cloudgate-host schedule is scoped into the feed by its own
   * organization id, owns no service, and so has no Environment and no address.
   * The table prints "Unknown" rather than a link somewhere else — but it still
   * says what kind of run it was, which used to go down with the link
   * and is the only
   * thing on this row that can explain it.
   */
  it("names the kind of run, with no label and no link, for a run that belongs to no Environment", () => {
    expect(
      ownerCell(
        row({
          owner: { type: "schedule", id: "sch-2", name: "prune images" },
          project: null,
          environment: null,
        }),
      ),
    ).toEqual({ path: "Scheduled run" });
  });

  /**
   * A build keeps its link and loses only the place: "Deployment · Storefront /
   * production" would be noise, so a build's sub-line is the place alone, and a
   * build with no place has no sub-line rather than an empty one.
   */
  it("links a build with no Environment, and gives it no sub-line", () => {
    expect(ownerCell(row({ project: null, environment: null }))).toEqual({
      label: "api",
      href: "/applications/app-1/deployments",
      path: undefined,
    });
  });
});

describe("ownerNoun", () => {
  it("names what the log dialog is looking at", () => {
    expect(ownerNoun(row())).toBe("Application");
    expect(
      ownerNoun(row({ owner: { type: "compose", id: "c", name: "s" } })),
    ).toBe("stack");
    expect(
      ownerNoun(row({ owner: { type: "backup", id: "b", name: "orders" } })),
    ).toBe("service");
  });
});

describe("ownedByOneOf", () => {
  it("matches a build of a service this session opened", () => {
    expect(ownedByOneOf(row(), ["app-1"])).toBe(true);
    expect(ownedByOneOf(row(), ["app-2"])).toBe(false);
  });

  /**
   * The filter narrows to services, and a run's owner id is a cron entry's or a
   * backup's — never the service's. So a scheduled run against an opened service
   * is not "one of the services you have opened", and saying otherwise would need
   * a service id the feed does not carry.
   */
  it("never matches a run, whose owner is not a service", () => {
    expect(
      ownedByOneOf(
        row({ owner: { type: "schedule", id: "app-1", name: "nightly" } }),
        ["app-1"],
      ),
    ).toBe(false);
  });
});

describe("projectsIn", () => {
  it("lists each Project once, by name, and skips rows that have none", () => {
    const rows = [
      row({ deploymentId: "a" }),
      row({ deploymentId: "b" }),
      row({
        deploymentId: "c",
        project: { projectId: "prj-2", name: "Analytics" },
      }),
      row({ deploymentId: "d", project: null, environment: null }),
    ];

    expect(projectsIn(rows)).toEqual([
      { id: "prj-2", name: "Analytics" },
      { id: "prj-1", name: "Storefront" },
    ]);
  });
});
