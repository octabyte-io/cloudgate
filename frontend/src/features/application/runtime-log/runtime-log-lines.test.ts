import { describe, expect, it } from "vitest";

import type { RuntimeLogLine } from "@/lib/api/endpoints/applications";

import {
  RUNTIME_LOG_LOOKBACK_MS,
  mergeRuntimeLines,
  toRuntimeLogLines,
  unreadSpan,
  withUnreadSpan,
} from "./runtime-log-lines";

const line = (
  id: string,
  at: number,
  task = "task-a",
  message = id,
): RuntimeLogLine => ({
  id,
  at,
  task,
  message,
});

/** The lines the log tab holds, across polls that overlap. */
describe("mergeRuntimeLines", () => {
  it("keeps a line read twice once", () => {
    const merged = mergeRuntimeLines(
      { lines: [line("1", 10), line("2", 20)], dropped: 0 },
      [line("2", 20), line("3", 30)],
    );
    expect(merged.lines.map((each) => each.id)).toEqual(["1", "2", "3"]);
  });

  it("puts a line CloudWatch took in late in its place by time", () => {
    const merged = mergeRuntimeLines(
      { lines: [line("1", 10, "task-a"), line("3", 30, "task-a")], dropped: 0 },
      [line("2", 20, "task-b")],
    );
    expect(merged.lines.map((each) => each.id)).toEqual(["1", "2", "3"]);
  });

  it("holds at most the cap, counting what fell off the front", () => {
    const merged = mergeRuntimeLines(
      { lines: [line("1", 10), line("2", 20)], dropped: 4 },
      [line("3", 30), line("4", 40)],
      3,
    );
    expect(merged.lines.map((each) => each.id)).toEqual(["2", "3", "4"]);
    expect(merged.dropped).toBe(5);
  });
});

describe("toRuntimeLogLines", () => {
  it("names each line's task by the start of its id, beside the time", () => {
    const at = new Date(2026, 9, 17, 9, 5, 7).getTime();
    expect(
      toRuntimeLogLines([
        line("1", at, "0a1b2c3d4e5f60718293a4b5c6d7e8f9", "GET / 200"),
      ]),
    ).toEqual([{ ts: "09:05:07", text: "[0a1b2c3d] GET / 200" }]);
  });

  it("names a Cloud Run line's copy and revision and marks what wrote it", () => {
    const at = new Date(2026, 9, 17, 9, 5, 7).getTime();
    expect(
      toRuntimeLogLines([
        {
          ...line("1", at, "0069f1e2d3c4b5a6aaaa", "slow query"),
          revision: "cloudgate-plb3nv2t74e6-00002-xyz",
          source: "stderr",
        },
        {
          ...line("2", at, "", "Ready condition status changed"),
          revision: null,
          source: "cloud-run",
        },
      ]),
    ).toEqual([
      { ts: "09:05:07", text: "[0069f1e2 00002-xyz] stderr: slow query" },
      { ts: "09:05:07", text: "Cloud Run: Ready condition status changed" },
    ]);
  });
});

/** A docked log paused past the backend's lookback: what it could not read. */
describe("unreadSpan", () => {
  const ten = new Date(2026, 9, 17, 10, 0, 0).getTime();
  const hour = RUNTIME_LOG_LOOKBACK_MS;

  it("is nothing while the pause was within the lookback", () => {
    expect(unreadSpan(ten, ten + hour)).toBeNull();
    expect(unreadSpan(ten, ten + 5 * 60_000)).toBeNull();
  });

  it("is nothing before the first read has given a cursor", () => {
    expect(unreadSpan(undefined, ten + 3 * hour)).toBeNull();
  });

  it("runs from the cursor to where the backend's lookback now starts", () => {
    expect(unreadSpan(ten, ten + 2 * hour)).toEqual({
      from: ten,
      to: ten + hour,
    });
  });
});

describe("withUnreadSpan", () => {
  const ten = new Date(2026, 9, 17, 10, 0, 0).getTime();
  const eleven = ten + RUNTIME_LOG_LOOKBACK_MS;

  it("leaves one marked line naming the span, after what was held", () => {
    const held = withUnreadSpan(
      { lines: [line("1", ten - 1_000)], dropped: 0 },
      { from: ten, to: eleven },
    );
    expect(toRuntimeLogLines(held.lines)).toEqual([
      expect.objectContaining({ text: "[task-a] 1" }),
      { text: "Lines between 10:00 and 11:00 were not read.", tone: "warn" },
    ]);
  });

  it("sits before the lines read after it, from the start of the lookback", () => {
    const gapped = withUnreadSpan(
      { lines: [line("1", ten)], dropped: 0 },
      { from: ten, to: eleven },
    );
    const held = mergeRuntimeLines(gapped, [
      line("2", eleven),
      line("3", eleven + 1),
    ]);
    expect(toRuntimeLogLines(held.lines).map((each) => each.text)).toEqual([
      "[task-a] 1",
      "Lines between 10:00 and 11:00 were not read.",
      "[task-a] 2",
      "[task-a] 3",
    ]);
  });

  it("counts against the cap like any other line", () => {
    const held = withUnreadSpan(
      { lines: [line("1", ten - 2), line("2", ten - 1)], dropped: 0 },
      { from: ten, to: eleven },
      2,
    );
    expect(held.lines).toHaveLength(2);
    expect(held.dropped).toBe(1);
  });
});
