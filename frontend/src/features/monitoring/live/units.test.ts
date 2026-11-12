import { describe, expect, it } from "vitest";

import type { DockerStatsSample } from "@/lib/realtime/gateways";

import {
  formatBytes,
  isUnmeasured,
  memoryPercent,
  percent,
  readingBytes,
} from "./units";

/**
 * These three were lines inside `live-card.tsx` until the card was split, and each
 * one encodes a defect that was found by driving the socket rather than reading it.
 * They are pinned here because the card that used to prove them by being looked at
 * is now four files, and none of them is where the arithmetic lives.
 */

describe("percent", () => {
  it("reads docker's printed percentage", () => {
    expect(percent("0.15%")).toBe(0.15);
    expect(percent("100%")).toBe(100);
  });

  it("is null for a series the frame did not carry", () => {
    expect(percent(undefined)).toBeNull();
    expect(percent("")).toBeNull();
    expect(percent("n/a")).toBeNull();
  });
});

describe("memoryPercent", () => {
  /**
   * The whole reason both sides are converted to bytes: `docker stats` prints
   * whichever unit fits each side, so a container using 8MiB of a 7.6GiB host
   * prints two different units on one line. Dividing them as printed gives a bar
   * 1024 times too long.
   */
  it("converts mixed units before dividing", () => {
    const value = memoryPercent({ used: "8.316MiB", total: "7.653GiB" });
    expect(value).toBeCloseTo(0.106, 2);
  });

  it("does not go over 100 when a container is over its limit", () => {
    expect(memoryPercent({ used: "2GiB", total: "1GiB" })).toBe(100);
  });

  it("is null for a unit that is not docker's, and for a zero total", () => {
    expect(memoryPercent({ used: "1PiB", total: "2PiB" })).toBeNull();
    expect(memoryPercent({ used: "0B", total: "0B" })).toBeNull();
  });
});

describe("isUnmeasured", () => {
  it("is true for the frame a non-Linux platform host sends", () => {
    // `parseServerStats` defaults every field to 0 rather than failing, so this is
    // a well-formed frame reporting a machine with no memory fitted.
    expect(
      isUnmeasured(
        sampleWith({
          memory: { used: "0B", total: "0B" },
          disk: { diskTotal: 0, diskUsedPercentage: 0, diskUsage: 0, diskFree: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("is true for a host with no disk series at all", () => {
    expect(isUnmeasured(sampleWith({ memory: { used: "0B", total: "0B" } }))).toBe(
      true,
    );
  });

  /** The rule that keeps a genuinely idle container out of this branch. */
  it("is false for an idle container that has memory fitted", () => {
    expect(
      isUnmeasured(
        sampleWith({
          cpu: "0.00%",
          memory: { used: "0B", total: "7.653GiB" },
        }),
      ),
    ).toBe(false);
  });
});

/** One frame, with only the series a case cares about. */
function sampleWith(parts: {
  cpu?: string;
  memory?: { used: string; total: string };
  disk?: {
    diskTotal: number;
    diskUsedPercentage: number;
    diskUsage: number;
    diskFree: number;
  };
}): DockerStatsSample {
  const at = (value: unknown) => ({ value, time: "2026-08-11T00:00:00.000Z" });
  return {
    cpu: parts.cpu === undefined ? null : at(parts.cpu),
    memory: parts.memory === undefined ? null : at(parts.memory),
    disk: parts.disk === undefined ? null : at(parts.disk),
    network: null,
    block: null,
  } as DockerStatsSample;
}

describe("formatBytes and readingBytes", () => {
  it("print IEC units with a space and two decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(13.03 * 1024 ** 3)).toBe("13.03 GiB");
  });

  it("re-read docker's SI and IEC strings into the same units", () => {
    expect(readingBytes("13.03GiB")).toBe("13.03 GiB");
    expect(readingBytes("1.2GB")).toBe("1.12 GiB");
    expect(readingBytes("0B")).toBe("0 B");
  });

  it("leave a string in a unit it does not know as it came", () => {
    expect(readingBytes("n/a")).toBe("n/a");
  });
});
