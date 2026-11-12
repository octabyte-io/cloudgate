import { describe, expect, it, vi } from "vitest";

import type { DeploymentFeedPage } from "@/lib/api/endpoints/deployments";

import { readFeedWindow, recentServiceIds } from "./use-feed";

/**
 * The walk is the whole of what the feed
 * replaced: the feed used to be one request per service in Recents, and is now
 * pages of `GET /deployments` until the screen's widest window is covered. It has
 * three stopping conditions and they are three different facts, so each is pinned.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-19T12:00:00.000Z");

/** A page of `n` rows, each an hour older than the last. */
function page(from: number, count: number, nextCursor: string | null) {
  return {
    rows: Array.from({ length: count }, (_, index) => ({
      deploymentId: `dep-${from + index}`,
      createdAt: new Date(NOW - (from + index) * HOUR).toISOString(),
    })),
    nextCursor,
  } as unknown as DeploymentFeedPage;
}

describe("readFeedWindow", () => {
  it("stops on the last page, and asks for one page when that is all there is", async () => {
    const read = vi.fn(async () => page(0, 3, null));

    const window = await readFeedWindow(read, NOW - 24 * HOUR);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(undefined);
    expect(window.rows).toHaveLength(3);
    expect(window.truncated).toBe(false);
  });

  /**
   * Rows arrive newest first, so the first row older than the horizon means every
   * row behind it is older too — the cursor is not followed past the window even
   * when the route offers a next page.
   */
  it("stops at the horizon rather than walking the whole history", async () => {
    const pages = [page(0, 3, "cursor-1"), page(3, 3, "cursor-2")];
    const read = vi.fn(async (cursor: string | undefined) =>
      cursor === undefined ? pages[0] : pages[1],
    );

    const window = await readFeedWindow(read, NOW - 4.5 * HOUR);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(2, "cursor-1");
    expect(window.rows).toHaveLength(6);
    expect(window.truncated).toBe(false);
  });

  /**
   * An instance busy enough to fill ten pages inside the window gets a bounded
   * read and a sentence saying so, rather than a page that walks until the
   * backend runs out of rows.
   */
  it("stops at the page cap and says the window is not covered", async () => {
    const read = vi.fn(async () => page(0, 2, "always-more"));

    const window = await readFeedWindow(read, NOW - 24 * HOUR);

    expect(read).toHaveBeenCalledTimes(10);
    expect(window.rows).toHaveLength(20);
    expect(window.truncated).toBe(true);
  });

  it("keeps the order the route answered in, across pages", async () => {
    const pages = [page(0, 2, "cursor-1"), page(2, 2, null)];
    const read = vi.fn(async (cursor: string | undefined) =>
      cursor === undefined ? pages[0] : pages[1],
    );

    const window = await readFeedWindow(read, NOW - 24 * HOUR);

    expect(window.rows.map((row) => row.deploymentId)).toEqual([
      "dep-0",
      "dep-1",
      "dep-2",
      "dep-3",
    ]);
  });
});

describe("recentServiceIds", () => {
  it("takes the two deployable kinds and nothing else", () => {
    expect(
      recentServiceIds([
        "/applications/app-1",
        "/compose/cmp-1",
        "/databases/postgres/pg-1",
        "/environments/env-1",
        "/servers/srv-1",
        "",
      ]),
    ).toEqual(["app-1", "cmp-1"]);
  });

  it("does not take a service's tab for the service", () => {
    expect(recentServiceIds(["/applications/app-1/deployments"])).toEqual([]);
  });
});
