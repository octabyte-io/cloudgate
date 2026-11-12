import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSession = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useSession,
  useActiveOrganizationId,
}));

const { forgetRecents, recordRecent, useRecents } = await import("./recents");

/**
 * Recents belongs to a person, not to a browser.
 *
 * It was one list per Organization, so a member signing in where the owner had
 * worked was offered the owner's Servers and Applications — resources their own
 * role could not open. Every test takes its own ids because the stores are
 * module-level and cache what they have read.
 */

function signedInAs(userId: string, organizationId: string) {
  useSession.mockReturnValue({
    data: {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    },
    isPending: false,
  });
  useActiveOrganizationId.mockReturnValue({ organizationId, pending: false });
}

function recentsOf(userId: string, organizationId: string) {
  signedInAs(userId, organizationId);
  return renderHook(() => useRecents()).result.current;
}

const SERVER = { id: "srv-1", label: "ui-self", href: "/servers/srv-1" };

beforeEach(() => localStorage.clear());
afterEach(() => {
  useSession.mockReset();
  useActiveOrganizationId.mockReset();
});

describe("recents", () => {
  it("keeps two users of one Organization apart", () => {
    recordRecent({ userId: "owner-a", organizationId: "org-a" }, SERVER);

    expect(recentsOf("owner-a", "org-a")).toEqual([SERVER]);
    expect(recentsOf("member-a", "org-a")).toEqual([]);
  });

  it("keeps one user's two Organizations apart", () => {
    recordRecent({ userId: "owner-b", organizationId: "org-b1" }, SERVER);

    expect(recentsOf("owner-b", "org-b2")).toEqual([]);
  });

  it("never hands a list saved before it had an owner to whoever signs in next", () => {
    // The old key: an Organization and no user. Nothing says whose it is,
    // so it is nobody's — and it is removed, not left for the next build to read.
    localStorage.setItem("cloudgate.recents.org-c", JSON.stringify([SERVER]));

    expect(recentsOf("member-c", "org-c")).toEqual([]);
    expect(localStorage.getItem("cloudgate.recents.org-c")).toBeNull();
  });
});

/**
 * A deleted resource leaves Recents, and takes what hung under it along.
 *
 * The list only ever added, so deleting a Project with an Environment and an
 * Application in it left three dead rows that pushed live ones out of five.
 * Routes are flat — `/applications/<id>` says nothing about its Project — so an
 * entry carries its ancestors' ids, and that is what the subtree is found by.
 */
describe("forgetRecents", () => {
  const PROJECT = { id: "prj-1", label: "ui-main", href: "/projects/prj-1" };
  const ENVIRONMENT = {
    id: "env-1",
    label: "ui-main / production",
    href: "/environments/env-1",
    ancestors: ["prj-1"],
  };
  const APPLICATION = {
    id: "app-1",
    label: "ui-main / production / whoami",
    href: "/applications/app-1",
    ancestors: ["prj-1", "env-1"],
  };
  const OTHER = { id: "prj-2", label: "ui-tags", href: "/projects/prj-2" };

  function seed(userId: string) {
    const owner = { userId, organizationId: "org-d" };
    // Recorded oldest first, so the list reads newest first.
    for (const entry of [SERVER, PROJECT, OTHER, ENVIRONMENT, APPLICATION]) {
      recordRecent(owner, entry);
    }
    return owner;
  }

  it("drops a Project and every entry under it, and keeps the rest in order", () => {
    const owner = seed("owner-d1");

    forgetRecents(owner, ["prj-1"]);

    expect(recentsOf("owner-d1", "org-d").map((each) => each.id)).toEqual([
      "prj-2",
      "srv-1",
    ]);
  });

  it("drops an Environment and its services, and leaves its Project", () => {
    const owner = seed("owner-d2");

    forgetRecents(owner, ["env-1"]);

    expect(recentsOf("owner-d2", "org-d").map((each) => each.id)).toEqual([
      "prj-2",
      "prj-1",
      "srv-1",
    ]);
  });

  it("keeps the list, and writes nothing, when nothing in it was forgotten", () => {
    const owner = seed("owner-d3");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    forgetRecents(owner, ["nothing-here"]);

    // Not written: every subscriber would re-render for an identical list.
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    expect(recentsOf("owner-d3", "org-d")).toHaveLength(5);
  });
});
