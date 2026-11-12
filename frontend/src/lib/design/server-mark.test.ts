import { describe, expect, it } from "vitest";

import { reachCounts, reachSummary, serverMark } from "./server-mark";

/**
 * A Server's pill is the last reach attempt, not `serverStatus` drawn as
 * health. The case the ticket was filed about is the first one — a self-hosted
 * Server whose billing flag is `active` for ever, at an address that never
 * answered, which wore a green "active" pill everywhere.
 */
const server = (fields: {
  reachCheckedAt?: string | null;
  reachOk?: boolean | null;
  serverStatus?: "active" | "inactive";
  maintenanceSince?: string | null;
}) => ({
  reachCheckedAt: null,
  reachOk: null,
  serverStatus: "active" as const,
  maintenanceSince: null,
  ...fields,
});

const AT = "2026-11-03T18:00:00.000Z";

describe("serverMark", () => {
  it("is not green for an active Server that was never reached", () => {
    const mark = serverMark(
      server({ reachCheckedAt: AT, reachOk: false, serverStatus: "active" }),
    );
    expect(mark.tone).toBe("bad");
    expect(mark.label).toBe("not reachable");
  });

  it("says not checked, in a neutral tone, before any attempt", () => {
    const mark = serverMark(server({}));
    expect(mark.tone).toBe("mute");
    expect(mark.label).toBe("not checked");
  });

  it("is green only once Cloudgate reached it", () => {
    expect(serverMark(server({ reachCheckedAt: AT, reachOk: true }))).toMatchObject({
      tone: "ok",
      label: "reachable",
    });
  });

  it("never draws the billing flag's 'active' at all", () => {
    for (const fields of [
      {},
      { reachCheckedAt: AT, reachOk: true },
      { reachCheckedAt: AT, reachOk: false },
    ]) {
      expect(serverMark(server(fields)).label).not.toBe("active");
    }
  });

  it("shows inactive, which only Cloudgate Cloud writes, over the reach", () => {
    expect(
      serverMark(
        server({ reachCheckedAt: AT, reachOk: true, serverStatus: "inactive" }),
      ).label,
    ).toBe("inactive");
  });

  it("reads in maintenance while a Server is in maintenance, over the reach", () => {
    for (const reach of [
      {},
      { reachCheckedAt: AT, reachOk: true },
      { reachCheckedAt: AT, reachOk: false },
    ]) {
      expect(
        serverMark(server({ ...reach, maintenanceSince: AT })).label,
      ).toBe("in maintenance");
    }
  });

  it("draws in maintenance as a warning, with a glyph that is not held's", () => {
    expect(serverMark(server({ maintenanceSince: AT }))).toEqual({
      glyph: "⊘",
      tone: "warn",
      label: "in maintenance",
    });
  });
});

describe("reachCounts and reachSummary", () => {
  it("count each outcome and leave out the empty ones", () => {
    const counts = reachCounts([
      server({ reachCheckedAt: AT, reachOk: true }),
      server({ reachCheckedAt: AT, reachOk: false }),
      server({ reachCheckedAt: AT, reachOk: true }),
    ]);
    expect(counts).toEqual({ reachable: 2, unreachable: 1, unchecked: 0 });
    expect(reachSummary(counts)).toBe("2 reachable · 1 not reachable");
  });

  it("say so when there are none", () => {
    expect(reachSummary(reachCounts([]))).toBe("none yet");
  });
});
