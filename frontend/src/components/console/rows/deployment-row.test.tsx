import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Deployment } from "@/lib/api/endpoints/deployments";

import { DeploymentTable, runStatusMark } from "./deployment-row";

afterEach(cleanup);

function deployment(over: Partial<Deployment>): Deployment {
  return {
    deploymentId: "dep-1",
    title: "Plan applied",
    description: null,
    status: "done",
    logPath: "/etc/cloudgate/logs/report/dep-1.log",
    applicationId: "app-1",
    composeId: null,
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: "2026-10-17T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

const RUN = {
  job: "report-run-abcd1234",
  image: "report:latest",
  startedBy: { kind: "member" as const, userId: "u-1", name: "Ida Rhodes" },
};

/** A Cron service's run beside its builds, in one table. */
describe("DeploymentTable, for a Cron service's runs", () => {
  it("marks a run as a run, and says succeeded or failed where a build says done or error", () => {
    const { container } = render(
      <DeploymentTable
        deployments={[
          deployment({ deploymentId: "b", title: "Plan applied" }),
          deployment({
            deploymentId: "r1",
            title: "Run now",
            cronRun: RUN,
            createdAt: "2026-10-17T10:01:00.000Z",
          }),
          deployment({
            deploymentId: "r2",
            title: "Run now",
            status: "error",
            cronRun: RUN,
            createdAt: "2026-10-17T10:02:00.000Z",
          }),
        ]}
      />,
    );
    const rows = [...container.querySelectorAll("tbody tr")].map((row) =>
      (row.textContent ?? "").replace(/\s+/g, " "),
    );

    expect(rows).toHaveLength(3);
    const [failed, succeeded, build] = rows;
    expect(failed).toContain("Run nowRun");
    expect(failed).toContain("failed");
    expect(succeeded).toContain("succeeded");
    expect(build).not.toContain("Run");
    expect(build).toContain("done");
  });

  it("words only the two ends of a run differently", () => {
    expect(runStatusMark("done").label).toBe("succeeded");
    expect(runStatusMark("error").label).toBe("failed");
    expect(runStatusMark("running").label).toBe("running");
  });

  it("reads a run its Cron service's Stop ended as stopped, not cancelled", () => {
    expect(runStatusMark("cancelled", { stopped: true }).label).toBe("stopped");
    expect(runStatusMark("cancelled", {}).label).toBe(
      runStatusMark("cancelled").label,
    );
  });
});
