import { describe, expect, it } from "vitest";

import { setupProgress, setupStepStates } from "./setup-progress";

describe("setupProgress", () => {
  it("is on no step, with nothing to show, before any output", () => {
    expect(setupProgress([])).toEqual({
      step: null,
      total: 8,
      waitingForSsh: false,
      latest: null,
    });
  });

  it("is on the step of the newest numbered header, with the newest line after it", () => {
    const progress = setupProgress([
      "Running as root",
      "1. Installing required packages",
      "Required packages are installed ✅",
      "2. Installing Docker",
      "# Executing docker install script, commit: 6d9743e",
    ]);
    expect(progress.step).toBe(2);
    expect(progress.latest).toBe(
      "# Executing docker install script, commit: 6d9743e",
    );
  });

  it("reads each line of a chunk that holds several", () => {
    const progress = setupProgress([
      "3. Setting up Docker Swarm\nSwarm initialized ✅\n4. Setting up Network\n",
    ]);
    expect(progress.step).toBe(4);
    expect(progress.latest).toBe("Swarm initialized ✅");
  });

  it("strips terminal colour codes before reading a line", () => {
    expect(
      setupProgress(["\u001b[32m5. Setting up Directories\u001b[0m"]).step,
    ).toBe(5);
  });

  it("is waiting for SSH only until the machine answers", () => {
    const waiting = ["Waiting for the machine to accept SSH…"];
    expect(setupProgress(waiting).waitingForSsh).toBe(true);
    expect(setupProgress([...waiting, "Running as root"]).waitingForSsh).toBe(
      false,
    );
    expect(
      setupProgress([...waiting, "1. Installing required packages"])
        .waitingForSsh,
    ).toBe(false);
  });

  it("does not take the run's outcome line for progress", () => {
    const progress = setupProgress([
      "8. Setting up boot recovery",
      "Boot recovery installed ✅",
      "",
      "✅ Setup finished.",
    ]);
    expect(progress.step).toBe(8);
    expect(progress.latest).toBe("Boot recovery installed ✅");
  });

  it("finds no step in a custom command's output, only its newest line", () => {
    const progress = setupProgress(["apt-get update", "Reading package lists"]);
    expect(progress.step).toBeNull();
    expect(progress.latest).toBe("Reading package lists");
  });
});

describe("setupStepStates", () => {
  it("marks the steps before the current one done and the rest to do", () => {
    expect(setupStepStates(3).map((step) => step.state)).toEqual([
      "done",
      "done",
      "now",
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("marks every step done once the run has finished", () => {
    expect(
      setupStepStates(8, true).every((step) => step.state === "done"),
    ).toBe(true);
  });
});
