import { describe, expect, it } from "vitest";

import { momentRestoreSteps } from "./moment-restore-steps";

/**
 * The lines `buildMomentRestoreScript` writes into the run's log, in its own
 * words (`backend/src/volume-backups/volume-backup-commands.ts`), with the
 * lock and the restore body's own lines between them as they arrive.
 */
const REMOVED = [
  "Volume lock acquired: alpha-files",
  "Volume lock acquired: zeta-db",
  "Step started: Remove containers",
  " Container wiki-db-1  Removed",
  "Step done: Remove containers",
];

const states = (steps: ReturnType<typeof momentRestoreSteps>) =>
  steps.map((step) => `${step.name}: ${step.state}`);

describe("momentRestoreSteps", () => {
  it("lists Remove containers, each volume in name order, then Start, all waiting", () => {
    expect(
      states(
        momentRestoreSteps({
          composeType: "docker-compose",
          volumes: ["zeta-db", "alpha-files"],
          lines: [],
          outcome: "running",
        }),
      ),
    ).toEqual([
      "Remove containers: waiting",
      "Restore alpha-files: waiting",
      "Restore zeta-db: waiting",
      "Start: waiting",
    ]);
  });

  it("names the first step Stop on a swarm stack", () => {
    const [first] = momentRestoreSteps({
      composeType: "stack",
      volumes: ["alpha-files"],
      lines: [],
      outcome: "running",
    });

    expect(first.name).toBe("Stop");
  });

  it("marks the steps the log has finished done, and the one it is in running", () => {
    expect(
      states(
        momentRestoreSteps({
          composeType: "docker-compose",
          volumes: ["alpha-files", "zeta-db"],
          lines: [
            ...REMOVED,
            "Step started: Restore alpha-files",
            "Downloading backup from S3...",
          ],
          outcome: "running",
        }),
      ),
    ).toEqual([
      "Remove containers: done",
      "Restore alpha-files: running",
      "Restore zeta-db: waiting",
      "Start: waiting",
    ]);
  });

  it("marks the step a failed restore stopped at failed, and what came after it not run", () => {
    expect(
      states(
        momentRestoreSteps({
          composeType: "docker-compose",
          volumes: ["alpha-files", "zeta-db"],
          lines: [
            ...REMOVED,
            "Step started: Restore alpha-files",
            "Step done: Restore alpha-files",
            "Step started: Restore zeta-db",
            "❌ Volume restore aborted - the archive would not extract",
            "❌ Moment restore stopped at Restore zeta-db",
          ],
          outcome: "failed",
        }),
      ),
    ).toEqual([
      "Remove containers: done",
      "Restore alpha-files: done",
      "Restore zeta-db: failed",
      "Start: not run",
    ]);
  });

  it("marks nothing failed when the restore failed before its first step", () => {
    expect(
      states(
        momentRestoreSteps({
          composeType: "docker-compose",
          volumes: ["alpha-files"],
          lines: ["Volume lock busy: alpha-files"],
          outcome: "failed",
        }),
      ),
    ).toEqual([
      "Remove containers: not run",
      "Restore alpha-files: not run",
      "Start: not run",
    ]);
  });

  it("marks every step done once the restore has succeeded, whatever lines arrived", () => {
    expect(
      states(
        momentRestoreSteps({
          composeType: "docker-compose",
          volumes: ["alpha-files"],
          lines: REMOVED,
          outcome: "done",
        }),
      ),
    ).toEqual([
      "Remove containers: done",
      "Restore alpha-files: done",
      "Start: done",
    ]);
  });

  it("reads a step's line wherever the log puts it in the line", () => {
    const [first] = momentRestoreSteps({
      composeType: "docker-compose",
      volumes: ["alpha-files"],
      lines: ["2026-11-26T03:00:01Z Step started: Remove containers"],
      outcome: "running",
    });

    expect(first.state).toBe("running");
  });
});
