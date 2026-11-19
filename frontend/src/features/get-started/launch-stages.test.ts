import { describe, expect, it } from "vitest";

import { CERTIFICATE_STAGE, launchStages } from "./launch-view";

const labels = (stages: { label: string }[]) => stages.map((s) => s.label);

describe("launchStages", () => {
  it("has three stages for an http:// address, which has no certificate to wait for", () => {
    expect(labels(launchStages({ phase: "running" }, "Ghost"))).toEqual([
      "Preparing Ghost",
      "Starting Ghost",
      "Ghost is running",
    ]);
    expect(
      launchStages({ phase: "running" }, "Ghost").every(
        (stage) => stage.state === "done",
      ),
    ).toBe(true);
  });

  it("waits on the certificate between starting and running for an https:// address", () => {
    const stages = launchStages({ phase: "running" }, "Ghost", "issuing");

    expect(labels(stages)).toEqual([
      "Preparing Ghost",
      "Starting Ghost",
      CERTIFICATE_STAGE,
      "Ghost is running",
    ]);
    expect(stages.map((stage) => stage.state)).toEqual([
      "done",
      "done",
      "now",
      "todo",
    ]);
  });

  it("shows the certificate stage to come while the app is still starting", () => {
    const stages = launchStages({ phase: "starting" }, "Ghost", "reading");

    expect(stages.map((stage) => stage.state)).toEqual([
      "done",
      "now",
      "todo",
      "todo",
    ]);
  });

  it("is done once the certificate is issued, or the wait for it is over", () => {
    for (const certificate of ["issued", "not-issued"] as const) {
      expect(
        launchStages({ phase: "running" }, "Ghost", certificate).map(
          (stage) => stage.state,
        ),
      ).toEqual(["done", "done", "done", "done"]);
    }
  });
});
