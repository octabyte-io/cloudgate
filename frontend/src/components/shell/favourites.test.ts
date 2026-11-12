import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSession = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useSession,
  useActiveOrganizationId,
}));

const { forgetStars, refreshStar, toggleStar, useIsStarred, useStarred } =
  await import("./favourites");

/**
 * A star is one person's bookmark in this browser, not the browser's.
 */

function signedInAs(userId: string, organizationId = "org-1") {
  useSession.mockReturnValue({
    data: { user: { id: userId }, session: { activeOrganizationId: organizationId } },
    isPending: false,
  });
  useActiveOrganizationId.mockReturnValue({ organizationId, pending: false });
}

function starredListOf(userId: string, organizationId = "org-1") {
  signedInAs(userId, organizationId);
  return renderHook(() => useStarred()).result.current;
}

/** A star as the masthead writes it. */
function star(id: string, rest: { label?: string; organizationId?: string; ancestors?: string[] } = {}) {
  return {
    id,
    label: rest.label ?? id,
    href: `/environments/${id}`,
    organizationId: rest.organizationId ?? "org-1",
    ...(rest.ancestors ? { ancestors: rest.ancestors } : {}),
  };
}

function starredFor(userId: string, id: string): boolean {
  signedInAs(userId);
  return renderHook(() => useIsStarred(id)).result.current;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  useSession.mockReset();
  useActiveOrganizationId.mockReset();
});

describe("favourites", () => {
  it("keeps two users' stars apart", () => {
    toggleStar("owner-a", star("env-a"));

    expect(starredFor("owner-a", "env-a")).toBe(true);
    expect(starredFor("member-a", "env-a")).toBe(false);
  });

  it("never hands stars saved before they had an owner to whoever signs in next", () => {
    localStorage.setItem("cloudgate.starred", JSON.stringify(["env-b"]));

    expect(starredFor("member-b", "env-b")).toBe(false);
    expect(localStorage.getItem("cloudgate.starred")).toBeNull();
  });
});

/**
 * The Starred list is the star's reader
 * A star used to
 * be an id and nothing else, which is all "is this one starred" needs and not
 * enough to draw a row: it now carries a label, an href and its Organization.
 */
describe("useStarred", () => {
  it("lists stars newest first, and not one that was unstarred", () => {
    toggleStar("owner-l", star("env-1", { label: "ui-main / production" }));
    toggleStar("owner-l", star("env-2", { label: "ui-main / staging" }));
    toggleStar("owner-l", star("env-3"));
    toggleStar("owner-l", star("env-3"));

    expect(starredListOf("owner-l").map((each) => each.label)).toEqual([
      "ui-main / staging",
      "ui-main / production",
    ]);
  });

  it("shows only the active Organization's stars", () => {
    toggleStar("owner-o", star("env-a", { organizationId: "org-a" }));
    toggleStar("owner-o", star("env-b", { organizationId: "org-b" }));

    expect(starredListOf("owner-o", "org-a").map((each) => each.id)).toEqual(["env-a"]);
    // Still starred, and still listed where it belongs.
    expect(starredListOf("owner-o", "org-b").map((each) => each.id)).toEqual(["env-b"]);
  });

  it("keeps a star saved as a bare id, and lists it once its scope has named it", () => {
    // The old shape: ids only, under the owned key.
    localStorage.setItem("cloudgate.owner-m.starred", JSON.stringify(["env-m"]));

    expect(starredFor("owner-m", "env-m")).toBe(true);
    // Nothing to draw a row from, so no row — not a link labelled with an id.
    expect(starredListOf("owner-m")).toEqual([]);

    refreshStar("owner-m", star("env-m", { label: "ui-main / staging" }));

    expect(starredListOf("owner-m")).toEqual([
      star("env-m", { label: "ui-main / staging" }),
    ]);
  });

  it("renames a star when its scope resolves a new name, and stars nothing new", () => {
    toggleStar("owner-r", star("env-r", { label: "ui-main / stagign" }));

    refreshStar("owner-r", star("env-r", { label: "ui-main / staging" }));
    refreshStar("owner-r", star("env-never-starred"));

    expect(starredListOf("owner-r").map((each) => each.label)).toEqual([
      "ui-main / staging",
    ]);
  });
});

describe("forgetStars", () => {
  it("drops a deleted Project's star and every star under it", () => {
    toggleStar("owner-f", star("prj-1"));
    toggleStar("owner-f", star("env-1", { ancestors: ["prj-1"] }));
    toggleStar("owner-f", star("env-2", { ancestors: ["prj-2"] }));

    forgetStars("owner-f", ["prj-1"]);

    expect(starredListOf("owner-f").map((each) => each.id)).toEqual(["env-2"]);
    expect(starredFor("owner-f", "env-1")).toBe(false);
  });
});
