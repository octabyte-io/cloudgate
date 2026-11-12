import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DockerStatsSample } from "@/lib/realtime/gateways";

import { LiveReadings } from "./live-readings";
import { HOST, liveTargetCopy } from "./target-options";

/**
 * The one thing on this card that a type cannot protect: **the words under a
 * figure have to describe the target the figure came from**.
 *
 * The Network tile's caption was a constant reading "in / out, since this
 * container started", shared by both targets. For a container it is right —
 * `docker stats` NetIO is cumulative from the container's start. For the host it
 * is not: the gateway takes `hostStats.collect()` instead, and the pair is
 * `/proc/net/dev` rx/tx summed across every NIC, running from boot. Measured on
 * a box, that was 29 days of traffic captioned as one container's lifetime,
 * against a container that was four weeks younger than the counters.
 *
 * Both samples are written out field by field rather than built from a shared
 * factory with overrides, on `container-targets.test.ts`' argument: a wrong
 * expectation must not be able to agree with the code. The host one carries a
 * `disk` series and the container one does not, which is the difference the
 * gateway itself makes between them.
 */

const HOST_SAMPLE: DockerStatsSample = {
  cpu: { value: "4.20%", time: "2026-09-15T18:00:00.000Z" },
  memory: {
    value: { used: "1.42GiB", total: "3.73GiB" },
    time: "2026-09-15T18:00:00.000Z",
  },
  disk: {
    value: {
      diskTotal: 78,
      diskUsedPercentage: 31,
      diskUsage: 24,
      diskFree: 54,
    },
    time: "2026-09-15T18:00:00.000Z",
  },
  network: {
    // MiB, as `HostStatsService` labels the host's pair.
    value: { inputMb: "38899.10MiB", outputMb: "25837.02MiB" },
    time: "2026-09-15T18:00:00.000Z",
  },
  block: {
    value: { readMb: "1.2GB", writeMb: "812MB" },
    time: "2026-09-15T18:00:00.000Z",
  },
};

const CONTAINER_SAMPLE: DockerStatsSample = {
  cpu: { value: "0.04%", time: "2026-09-15T18:00:00.000Z" },
  memory: {
    value: { used: "64.7MiB", total: "3.73GiB" },
    time: "2026-09-15T18:00:00.000Z",
  },
  // A container has no disk series; the gateway never populates one.
  disk: null,
  network: {
    value: { inputMb: "124kB", outputMb: "98.1kB" },
    time: "2026-09-15T18:00:00.000Z",
  },
  block: {
    value: { readMb: "49.2kB", writeMb: "12.3kB" },
    time: "2026-09-15T18:00:00.000Z",
  },
};

/**
 * The card's own copy for that target, not copy written here: `LiveCard` calls
 * `liveTargetCopy` once and passes the result down, so a test that hand-fed the
 * caption would be asserting its own string.
 */
function drawn(sample: DockerStatsSample, target: string) {
  render(
    <LiveReadings
      sample={sample}
      status="open"
      closeReason={null}
      closeCode={null}
      ended={false}
      unmeasured={false}
      copy={liveTargetCopy(target)}
      thresholds={null}
    />,
  );
  return document.body.textContent ?? "";
}

afterEach(cleanup);

describe("LiveReadings", () => {
  it("captions the host's Network pair as totals since boot, naming no container", () => {
    const text = drawn(HOST_SAMPLE, HOST);

    expect(text).toContain("37.99 GiB / 25.23 GiB");
    expect(text).toContain("total since boot, not a rate");
    // The whole finding: this reading has nothing to do with a container's
    // lifetime, so the word must not appear anywhere the caption can be read.
    expect(text).not.toContain("container");
  });

  it("keeps the container caption for a container target, where it is true", () => {
    const text = drawn(CONTAINER_SAMPLE, "app-t64tnx.1.ihmnf9wytekqp9q8g6dor0a60");

    expect(text).toContain("121.09 KiB / 95.80 KiB");
    expect(text).toContain("in / out, since this container started");
    expect(text).not.toContain("since boot");
  });

  it("gives the two targets different Network captions", () => {
    const host = drawn(HOST_SAMPLE, HOST);
    cleanup();
    const container = drawn(CONTAINER_SAMPLE, "app-t64tnx.1.ihmn");

    expect(host).not.toBe(container);
    expect(host.includes("since this container started")).toBe(false);
    expect(container.includes("total since boot")).toBe(false);
  });

  /**
   * One byte formatter across the card. Before it, the host read
   * "1.42GiB of 3.73GiB" with no space, Network in MB, and Disk "54 GB free of
   * 78" with no unit on the total and a bare "%" beside the figure.
   */
  it("prints every size in one unit system, with a unit on both sides of a pair", () => {
    const text = drawn(HOST_SAMPLE, HOST);

    expect(text).toContain("1.42 GiB of 3.73 GiB");
    expect(text).toContain("54.00 GiB free of 78.00 GiB");
    expect(text).toContain("% used");
    // Block IO arrived in docker's SI units and is converted, not relabelled.
    expect(text).toContain("1.12 GiB / 774.38 MiB");
    // No SI unit and no unit glued to its number survives anywhere.
    expect(text).not.toMatch(/\d(GiB|MiB|KiB|GB|MB|kB)/);
    expect(text).not.toMatch(/ (GB|MB|kB)\b/);
  });
});
