import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getInvitation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", () => ({
  useSession: () => ({
    data: { user: { email: "member@example.test" } },
    isPending: false,
  }),
  organization: { getInvitation, acceptInvitation: vi.fn() },
}));

const endSession = vi.hoisted(() => vi.fn());

// The seam under `useSignOut`, so the real hook decides where signing out goes
// and the test reads the destination it handed on.
vi.mock("@/lib/auth/end-session", () => ({ endSession }));

const { AcceptInvitation } = await import("./accept-invitation");

/**
 * **A closed invitation says which way it closed**.
 *
 * better-auth's `getInvitation` reads pending rows only, so accepted, declined,
 * withdrawn and expired all come back as one 400 `INVITATION_NOT_FOUND` — and the
 * page used to name all three at once, because it asked nothing else. The
 * backend's `GET /organizations/invitations/:id/state` tells them apart, scoped
 * to the recipient, and the page now asks it whenever the first read refuses.
 *
 * `fetch` is the boundary for that second read, so the route itself is pinned.
 */

const fetchSpy = vi.fn();

function answer(status: number, body: unknown) {
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function state(code: string) {
  answer(200, { id: "inv_1", code, status: null, expiresAt: null });
}

beforeEach(() => {
  fetchSpy.mockReset();
  endSession.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchSpy);
  getInvitation.mockResolvedValue({
    data: null,
    error: { status: 400, code: "INVITATION_NOT_FOUND" },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AcceptInvitation invitationId="inv_1" />
    </QueryClientProvider>,
  );
}

/** The sentence every closed invitation used to share. */
const ALL_THREE = /already been used, or it was withdrawn, or it has expired/;

const HEADINGS: Record<string, string> = {
  INVITATION_ALREADY_ACCEPTED: "You already accepted this invitation",
  INVITATION_EXPIRED: "This invitation has expired",
  INVITATION_REJECTED: "You declined this invitation",
  INVITATION_WITHDRAWN: "This invitation was withdrawn",
  INVITATION_NOT_FOUND: "This invitation no longer exists",
};

describe("AcceptInvitation, once the invitation is closed", () => {
  it.each(Object.entries(HEADINGS))(
    "%s reads as its own state",
    async (code, heading) => {
      state(code);
      renderPage();

      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeTruthy();
      expect(document.body.textContent).not.toMatch(ALL_THREE);

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toMatch(/\/organizations\/invitations\/inv_1\/state$/);
    },
  );

  it("gives each state a sentence of its own", async () => {
    const bodies = new Set<string>();
    for (const code of Object.keys(HEADINGS)) {
      state(code);
      renderPage();
      await screen.findByRole("heading", { name: HEADINGS[code] });
      bodies.add(document.body.textContent ?? "");
      cleanup();
    }
    expect(bodies.size).toBe(Object.keys(HEADINGS).length);
  });

  it("offers the console on an accepted one", async () => {
    state("INVITATION_ALREADY_ACCEPTED");
    renderPage();
    const way = await screen.findByText("Open the console");
    expect(way.closest("a")?.getAttribute("href")).toBeTruthy();
  });

  it("says the invitation is someone else's when the state route says so", async () => {
    answer(403, {
      statusCode: 403,
      message: "You are not the recipient of the invitation",
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    });
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "This invitation was sent to someone else",
      }),
    ).toBeTruthy();
  });

  it("does not guess when the state cannot be read", async () => {
    answer(500, { statusCode: 500, message: "Internal server error" });
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "This invitation cannot be used",
      }),
    ).toBeTruthy();
    for (const heading of Object.values(HEADINGS)) {
      expect(screen.queryByRole("heading", { name: heading })).toBeNull();
    }
  });

  it("does not ask the state route about an invitation that is open", async () => {
    getInvitation.mockResolvedValue({
      data: {
        id: "inv_1",
        organizationName: "Acme",
        inviterEmail: "owner@example.test",
        email: "member@example.test",
        role: "member",
      },
      error: null,
    });
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Accept invitation" }),
    ).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * **Signing out keeps the invitation**.
 *
 * The page tells a wrong-account visitor to sign out and sign in as the
 * recipient. Landing on bare `/sign-in` lost the link, so the right person
 * arrived at the console home instead of the invitation. Signing out goes to the
 * same `/sign-in?next=` the signed-out page's own "Sign in to accept" uses.
 */
describe("AcceptInvitation, signing out", () => {
  const BACK = "/sign-in?next=%2Faccept-invitation%2Finv_1";

  it("returns a wrong-account visitor to the invitation after sign-in", async () => {
    getInvitation.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession.mock.calls[0][1]).toBe(BACK);
  });

  it("does the same from the open invitation's 'Not you?' link", async () => {
    getInvitation.mockResolvedValue({
      data: {
        id: "inv_1",
        organizationName: "Acme",
        inviterEmail: "owner@example.test",
        email: "member@example.test",
        role: "member",
      },
      error: null,
    });
    renderPage();

    const link = await screen.findByRole("link", { name: "Sign out" });
    expect(link.getAttribute("href")).toBe(BACK);
    fireEvent.click(link);

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession.mock.calls[0][1]).toBe(BACK);
  });
});
