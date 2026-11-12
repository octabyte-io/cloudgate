import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
const setActive = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  getSession,
  organization: { list, setActive },
}));

const { resolveOrganizationDestination } = await import("./active-organization");

const ok = <T,>(data: T) => Promise.resolve({ data, error: null });

function sessionIn(activeOrganizationId: string | null) {
  getSession.mockReturnValue(ok({ session: { activeOrganizationId } }));
}

afterEach(() => {
  vi.resetAllMocks();
});

/**
 * Where a session that was just created goes.
 *
 * The backend leaves `activeOrganizationId` unset for several memberships with
 * no default, and this is the reader that turns that into the question. Earlier
 * the backend always answered, so `choose` was unreachable from sign-in.
 */
describe("resolveOrganizationDestination", () => {
  it("asks, on /select-organization, when there are several and none is active", async () => {
    sessionIn(null);
    list.mockReturnValue(
      ok([
        { id: "org_a", name: "Alpha" },
        { id: "org_b", name: "Beta" },
      ]),
    );

    const destination = await resolveOrganizationDestination("/projects/p_1");

    expect(destination).toEqual({
      kind: "choose",
      href: "/select-organization?next=%2Fprojects%2Fp_1",
      organizations: [
        { id: "org_a", name: "Alpha" },
        { id: "org_b", name: "Beta" },
      ],
    });
    expect(setActive).not.toHaveBeenCalled();
  });

  it("goes straight on when the session already has an Organization", async () => {
    sessionIn("org_a");

    expect(await resolveOrganizationDestination("/")).toEqual({
      kind: "ready",
      href: "/",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("settles a single membership itself rather than asking", async () => {
    sessionIn(null);
    list.mockReturnValue(ok([{ id: "org_a", name: "Alpha" }]));
    setActive.mockReturnValue(ok({}));

    expect(await resolveOrganizationDestination("/")).toEqual({
      kind: "ready",
      href: "/",
    });
    expect(setActive).toHaveBeenCalledWith({ organizationId: "org_a" });
  });

  it("says there is nothing to choose from when there is none", async () => {
    sessionIn(null);
    list.mockReturnValue(ok([]));

    expect(await resolveOrganizationDestination("/")).toEqual({ kind: "none" });
  });
});
