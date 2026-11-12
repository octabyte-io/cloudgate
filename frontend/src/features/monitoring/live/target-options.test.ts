import { describe, expect, it } from "vitest";

import { HOST, liveTargetCopy, serviceOf } from "./target-options";

/**
 * The live card says three things about what it is showing — a heading, the line
 * under it and the Network tile's caption — and once
 * all three were constants describing the host, whatever the picker was on. Two
 * of them were therefore wrong on a container target (`This host` over a
 * container's figures) and the third was wrong on the host target, which is the
 * card's default ("since this container started" over counters that run from
 * boot).
 *
 * That is copy, and copy is exactly what a type cannot hold, so the three are one
 * return value and this is the test that they move together. The strings are
 * asserted by what they must and must not claim rather than quoted whole: a test
 * that pins every word turns a wording change into a failure and teaches whoever
 * hits it to update the expectation without reading it.
 */
describe("liveTargetCopy", () => {
  it("describes the machine for the host target and dates its counters from boot", () => {
    const copy = liveTargetCopy(HOST);

    expect(copy.title).toBe("This host");
    expect(copy.sub).toContain("The machine Cloudgate runs on");
    expect(copy.networkDetail).toContain("total since boot");
    // The finding itself: there is no container on this path at all.
    expect(copy.networkDetail).not.toContain("container");
    expect(copy.title).not.toContain("container");
  });

  it("says a host's samples are stored as well, once it is collecting", () => {
    expect(liveTargetCopy(HOST, true).sub).toContain("stored on an interval");
    expect(liveTargetCopy(HOST, false).sub).not.toContain("stored");
  });

  it("names the container in all three places for a container target", () => {
    const copy = liveTargetCopy("app-t64tnx.1.ihmnf9wytekqp9q8g6dor0a60", true);

    expect(copy.title).toBe("app-t64tnx");
    expect(copy.sub).toContain("app-t64tnx.1.ihmnf9wytekqp9q8g6dor0a60");
    expect(copy.networkDetail).toContain("since this container started");
    // A container's figures are never the machine's, whatever the host is doing.
    expect(copy.title).not.toBe("This host");
    expect(copy.sub).not.toContain("stored on an interval");
  });

  it("points the stream hint at where each target's figures come from", () => {
    // The fourth site, moved in here because it was the same branch written a
    // second way in `LiveReadings`: a refusal on the host target is a `/proc`
    // problem, and on a container it is a container that went away.
    expect(liveTargetCopy(HOST).streamHint).toContain("/proc/stat");
    expect(liveTargetCopy("app-t64tnx.1.ihmn").streamHint).toContain(
      "the container stopped",
    );
    expect(liveTargetCopy(HOST).streamHint).not.toBe(
      liveTargetCopy("app-t64tnx.1.ihmn").streamHint,
    );
  });

  it("leaves the host's own storage claim off a container subtitle", () => {
    // `collecting` is the host's history being kept; whether *this* container is
    // sampled is the include list's answer, given underneath by ContainerHistory.
    expect(liveTargetCopy("mongo-1yk5mn.1.abc", true).sub).toBe(
      liveTargetCopy("mongo-1yk5mn.1.abc", false).sub,
    );
  });
});

describe("serviceOf", () => {
  it("drops a Swarm task's replica index and task id", () => {
    expect(serviceOf("redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09")).toBe(
      "redis-12sp3x",
    );
  });

  it("returns a name that has no task suffix unchanged", () => {
    expect(serviceOf("ui-minio")).toBe("ui-minio");
  });
});
