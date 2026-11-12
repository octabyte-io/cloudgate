import { describe, expect, it } from "vitest";

import {
  bytesToMemory,
  coresToNanoCpus,
  durationToNanos,
  memoryToBytes,
  nanoCpusToCores,
  nanosToSeconds,
} from "./units";

/**
 * The console's units against the Docker Engine's. Expected values are
 * the Engine's own definitions written out: 1e9 nano-CPUs per core, 1024² bytes
 * per MB (what `docker run --memory 512m` means), 1e9 nanoseconds per second.
 */
describe("coresToNanoCpus", () => {
  it("reads cores, so 1 is one core and not one nano-CPU", () => {
    expect(coresToNanoCpus("1")).toBe(1_000_000_000);
    expect(coresToNanoCpus("0.5")).toBe(500_000_000);
    expect(coresToNanoCpus(" 2.25 ")).toBe(2_250_000_000);
  });

  it("is null for an empty field and NaN for words", () => {
    expect(coresToNanoCpus("")).toBeNull();
    expect(coresToNanoCpus("1 core")).toBeNaN();
    expect(coresToNanoCpus("-1")).toBeNaN();
  });
});

describe("nanoCpusToCores", () => {
  it("writes the stored value back exactly", () => {
    expect(nanoCpusToCores("1500000000")).toBe("1.5");
    expect(nanoCpusToCores("1")).toBe("0.000000001");
    expect(nanoCpusToCores(null)).toBe("");
  });
});

describe("memoryToBytes", () => {
  it("takes a bare number as MB, and MB or GB with or without a space", () => {
    expect(memoryToBytes("512")).toBe(536_870_912);
    expect(memoryToBytes("512MB")).toBe(536_870_912);
    expect(memoryToBytes("1.5 GB")).toBe(1_610_612_736);
    expect(memoryToBytes("2g")).toBe(2_147_483_648);
    expect(memoryToBytes("100 B")).toBe(100);
  });

  it("is null for an empty field and NaN for an unknown unit", () => {
    expect(memoryToBytes("")).toBeNull();
    expect(memoryToBytes("512 parsecs")).toBeNaN();
    expect(memoryToBytes("lots")).toBeNaN();
  });
});

describe("bytesToMemory", () => {
  it("shows the largest unit that holds the value exactly", () => {
    expect(bytesToMemory("536870912")).toBe("512 MB");
    expect(bytesToMemory("2147483648")).toBe("2 GB");
    expect(bytesToMemory("1610612736")).toBe("1536 MB");
  });

  it("never rounds a value set through the API, so a save leaves it alone", () => {
    expect(bytesToMemory("1000000001")).toBe("1000000001 B");
    expect(memoryToBytes(bytesToMemory("1000000001"))).toBe(1_000_000_001);
  });
});

describe("durationToNanos", () => {
  it("takes seconds, or a number with its own unit", () => {
    expect(durationToNanos("30")).toBe(30_000_000_000);
    expect(durationToNanos("1.5s")).toBe(1_500_000_000);
    expect(durationToNanos("500ms")).toBe(500_000_000);
    expect(durationToNanos("2m")).toBe(120_000_000_000);
  });

  it("is null for an empty field and NaN for words", () => {
    expect(durationToNanos("")).toBeNull();
    expect(durationToNanos("soon")).toBeNaN();
  });
});

describe("nanosToSeconds", () => {
  it("writes nanoseconds as seconds, exactly", () => {
    expect(nanosToSeconds(30_000_000_000)).toBe("30");
    expect(nanosToSeconds(1_500_000)).toBe("0.0015");
    expect(nanosToSeconds(undefined)).toBe("");
  });
});
