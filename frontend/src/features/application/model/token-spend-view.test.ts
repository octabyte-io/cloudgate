import { describe, expect, it } from "vitest";

import type { SpendFigures, TokenSpend } from "@/lib/api/endpoints/token-spend";

import {
  breakdownRows,
  dayLabel,
  spendDays,
  spendWindow,
  SPEND_RANGES,
} from "./token-spend-view";

const figures = (
  prompt: [number, number],
  completion: [number, number],
  calls: Partial<SpendFigures["calls"]> = {},
): SpendFigures => ({
  promptTokens: { reported: prompt[0], estimated: prompt[1] },
  completionTokens: { reported: completion[0], estimated: completion[1] },
  calls: { ok: 0, runtimeError: 0, clientAborted: 0, refused: 0, ...calls },
});

describe("spendWindow", () => {
  // Late in the UTC day, so a local-time reading would already be tomorrow
  // east of Greenwich: the window is in UTC days, as the route counts them.
  const now = new Date("2026-10-16T23:30:00.000Z");

  it("offers the four ranges, in order", () => {
    expect(SPEND_RANGES.map((range) => range.value)).toEqual([
      "7d",
      "30d",
      "90d",
      "all",
    ]);
  });

  it("asks for the last N UTC days, today included", () => {
    expect(spendWindow("7d", now)).toEqual({
      from: "2026-10-10",
      to: "2026-10-16",
    });
    expect(spendWindow("30d", now)).toEqual({
      from: "2026-09-17",
      to: "2026-10-16",
    });
    expect(spendWindow("90d", now)).toEqual({
      from: "2026-07-19",
      to: "2026-10-16",
    });
  });

  it("leaves 'all' to the route, which starts it on the day the AI model was created", () => {
    expect(spendWindow("all", now)).toEqual({});
  });
});

describe("spendDays", () => {
  it("sums prompt and completion, keeping reported and estimated apart", () => {
    const days = spendDays([
      { day: "2026-10-15", ...figures([100, 0], [40, 0]) },
      { day: "2026-10-16", ...figures([10, 5], [0, 20]) },
    ]);
    expect(days).toEqual([
      { day: "2026-10-15", reported: 140, estimated: 0 },
      { day: "2026-10-16", reported: 10, estimated: 25 },
    ]);
  });
});

describe("breakdownRows", () => {
  const spend = {
    breakdown: [
      {
        agentId: "u1",
        agentUserId: "u1",
        agentName: "chat-bot",
        model: "smollm2:135m",
        ...figures([10, 0], [10, 0], { ok: 2 }),
      },
      {
        agentId: "u2",
        agentUserId: null,
        agentName: "old-bot",
        model: "smollm2:135m",
        ...figures([100, 50], [0, 0], { ok: 1, refused: 3 }),
      },
    ],
  } as Pick<TokenSpend, "breakdown">;

  it("lists the biggest spender first, a removed Agent marked as removed", () => {
    expect(breakdownRows(spend.breakdown)).toEqual([
      {
        id: "u2/smollm2:135m",
        agentName: "old-bot",
        removed: true,
        model: "smollm2:135m",
        reported: 100,
        estimated: 50,
        calls: { ok: 1, runtimeError: 0, clientAborted: 0, refused: 3 },
      },
      {
        id: "u1/smollm2:135m",
        agentName: "chat-bot",
        removed: false,
        model: "smollm2:135m",
        reported: 20,
        estimated: 0,
        calls: { ok: 2, runtimeError: 0, clientAborted: 0, refused: 0 },
      },
    ]);
  });
});

describe("dayLabel", () => {
  it("reads a UTC day without shifting it into the viewer's zone", () => {
    expect(dayLabel("2026-10-01")).toBe("Oct 1");
  });
});

