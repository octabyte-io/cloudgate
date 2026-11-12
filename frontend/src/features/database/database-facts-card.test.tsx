import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ApplicationStatus } from "@/lib/api/endpoints/applications";
import type { Database } from "@/lib/api/endpoints/databases";

import { DatabaseFactsCard } from "./database-facts-card";

afterEach(cleanup);

function row(applicationStatus: ApplicationStatus, replicas = 1) {
  return {
    databaseId: "db-1",
    kind: "postgres",
    name: "ui-pg",
    appName: "postgres-zz6lvz",
    description: null,
    applicationStatus,
    dockerImage: "postgres:18",
    replicas,
    createdAt: "2026-09-17T10:00:00.000Z",
    environmentId: "env-1",
    serverId: null,
    server: null,
    environment: {
      environmentId: "env-1",
      name: "staging",
      project: { projectId: "prj-1", name: "storefront" },
    },
  } as unknown as Database;
}

/** The card's text, with the whitespace the JSX fragments introduce collapsed. */
function read(applicationStatus: ApplicationStatus, replicas?: number) {
  const { container } = render(
    <DatabaseFactsCard
      database={row(applicationStatus, replicas)}
      kind="postgres"
    />,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/**
 * What the Database card says about a database that is not running.
 *
 * **What broke.** Stop scaled the Swarm service to 0 and wrote `idle`, which is
 * the column's own default — so this card described a stopped database and a
 * database that had never been deployed with the same two facts: `Status ○
 * idle` and `Replicas 1`. Neither was a reading of anything: the status was the
 * value the row was created with, and `replicas` is the *configured* count that
 * becomes `Mode.Replicated.Replicas`, which a Stop does not touch. An operator
 * who had just pressed Stop was shown a card claiming one replica.
 *
 * Both halves are pinned here because they failed together and only one of them
 * is a new enum value: a future change that narrowed `stopped` back to `idle`
 * and one that restored the bare `Replicas 1` are different mistakes with the
 * same symptom.
 */
describe("DatabaseFactsCard", () => {
  describe("a stopped database", () => {
    it("names the state in a word a never-deployed database cannot wear", () => {
      const stopped = read("stopped");
      const neverDeployed = read("idle");

      expect(stopped).toContain("stopped");
      expect(neverDeployed).toContain("idle");
      expect(neverDeployed).not.toContain("stopped");
    });

    it("does not claim a running replica", () => {
      expect(read("stopped")).toContain("0 of 1 running");
      expect(read("stopped", 3)).toContain("0 of 3 running");
    });
  });

  describe("a database that is not stopped", () => {
    it("says the replica count is the configured one, not a live reading", () => {
      // The console reads no task list for a database, so the honest form of
      // this fact is the qualifier — `done` means the service converged, not
      // that a task is up.
      expect(read("done")).toContain("1 configured");
      expect(read("idle")).toContain("1 configured");
      expect(read("done")).not.toContain("running");
    });
  });

  /**
   * A deploy whose new image Swarm rolled back ends `error` with the
   * row still holding the image that did not take. The fact is the configured
   * image, and beside `error` a bare tag read as the one in use.
   */
  describe("the Image fact", () => {
    it("does not present the image of a failed deploy as the running one", () => {
      expect(read("error")).toContain("postgres:18 · not confirmed running");
    });

    it("is the bare image when the deploy took", () => {
      expect(read("done")).toContain("postgres:18");
      expect(read("done")).not.toContain("not confirmed");
    });
  });

  // A postgres on RDS Cloudgate stopped reads when AWS starts it again,
  // and after that date that it has; the backend words both.
  it.each([
    ["stopped", "Stopped, AWS starts it again on 2026-10-24"],
    ["started-by-aws", "Started again by AWS"],
  ] as const)(
    "says what AWS does with a %s RDS instance",
    (state, sentence) => {
      const database = {
        ...row("stopped"),
        cloudAccountId: "cloud-1",
        rdsStop: {
          state,
          restartsAt: "2026-10-24T09:00:00.000Z",
          sentence,
          warning: null,
        },
      } as Database;
      const { container } = render(
        <DatabaseFactsCard database={database} kind="postgres" />,
      );
      expect(container.textContent).toContain(`On AWS${sentence}`);
    },
  );

  // Google never starts a stopped Cloud SQL by itself, so it reads
  // "Stopped" with no date.
  it("says a stopped Cloud SQL instance is stopped, with no date", () => {
    const database = {
      ...row("stopped"),
      cloudAccountId: "cloud-1",
      cloudSqlStop: {
        state: "stopped",
        sentence: "Stopped",
        warning:
          "Storage, backups and its private address still cost money. It stays stopped until you start it.",
      },
    } as Database;
    const { container } = render(
      <DatabaseFactsCard database={database} kind="postgres" />,
    );
    expect(container.textContent).toContain("On Google CloudStopped");
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
