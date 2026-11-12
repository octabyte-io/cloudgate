import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const listSessions = vi.hoisted(() => vi.fn());
const useSession = vi.hoisted(() => vi.fn());
const useSignOut = vi.hoisted(() => vi.fn());

// Three system boundaries, all replaced rather than driven: the HTTP client,
// better-auth's session store, and the sign-out that would navigate.
vi.mock("@/lib/api/endpoints/users", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/users")>();
  return { ...actual, usersApi: { ...actual.usersApi, listSessions } };
});

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useSession,
}));

vi.mock("@/lib/auth/use-sign-out", () => ({ useSignOut }));

const { SessionsCard } = await import("./sessions-card");

afterEach(() => {
  cleanup();
  listSessions.mockReset();
  useSession.mockReset();
  useSignOut.mockReset();
});

/**
 * The stale-session state, and what identifies it (H-36).
 *
 * `isStaleSession` matched the refusal's **English** with `/not fresh/i` — the
 * last string match in the console, by its own comment, and it was one because
 * `callAuthApi` flattened better-auth's `SESSION_NOT_FRESH` down to a bare 403
 * on every Cloudgate route. It reads the code now, so the case below is the one
 * that separates the two: a refusal that carries the code and does **not** carry
 * the old wording.
 *
 * That is not a hypothetical rewording. H-29 replaced better-auth's own spelling
 * of the ban in the same run, and `bannedUserMessage` is a config option — a
 * wire sentence is allowed to change, which is the whole argument for not
 * reading one.
 */

const HEADING = "This list needs a session less than a day old";

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderCard() {
  useSession.mockReturnValue({ data: { session: { id: "session-1" } } });
  useSignOut.mockReturnValue({ signOutNow: vi.fn(), pending: false });
  render(withQuery(<SessionsCard />));
}

describe("SessionsCard", () => {
  it("shows the stale-session state for the freshness code whatever the refusal is worded as", async () => {
    listSessions.mockRejectedValue(
      new ApiError(403, "That session predates the freshness window", {
        path: "/users/me/sessions",
        code: "SESSION_NOT_FRESH",
      }),
    );
    renderCard();

    expect(await screen.findByText(HEADING)).toBeTruthy();
    // The state is the point, not the heading: it is the one refusal on this
    // screen that comes with a button that fixes it.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  /**
   * The control, and the half that says the card is reading the code rather than
   * the status: a 403 that names itself nothing is a role refusal, and the card
   * must not offer "sign out and back in" as the fix for one.
   */
  it("leaves a 403 that names itself nothing to the ordinary sentence", async () => {
    listSessions.mockRejectedValue(
      new ApiError(403, "Forbidden resource", { path: "/users/me/sessions" }),
    );
    renderCard();

    expect(
      await screen.findByText(
        "Your role in this Organization does not allow this. Ask an owner or an admin to do it, or to change your role.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  /**
   * The user agent ellipsises inside a column that bounds it.
   *
   * jsdom has no layout, so this pins the structure the ellipsis depends on
   * rather than the ellipsis: the Device header takes the table's slack as a
   * percentage share, and the agent sits in a clipping box that cannot widen
   * the column. Before the fix the agent's span carried `truncate` inside an
   * auto-layout cell nothing bounded, which at 1440px was 767px wide and put
   * Revoke behind the table's horizontal scroll.
   */
  it("bounds the Device column so a long user agent cannot widen the table", async () => {
    const agent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    listSessions.mockResolvedValue([
      {
        id: "session-1",
        userId: "user-1",
        createdAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-09-08T00:00:00.000Z",
        ipAddress: "203.0.113.7",
        userAgent: agent,
      },
    ]);
    renderCard();

    const text = await screen.findByText(agent);
    // The whole string stays reachable, as a tooltip.
    expect(text.getAttribute("title")).toBe(agent);
    const clip = text.closest("td > div");
    // A fixed width, not `w-0`: it is also the column's floor, so the Device
    // column cannot collapse to nothing at phone width.
    expect(clip?.className).toMatch(/\bw-32\b/);
    expect(clip?.className).toMatch(/\bmin-w-full\b/);
    expect(clip?.className).toMatch(/\btruncate\b/);

    const device = screen.getByRole("columnheader", { name: "Device" });
    expect(device.style.width).toBe("100%");
    expect(device.className).toMatch(/\bmin-w-32\b/);
    // The chip stays beside the agent rather than wrapping under it.
    expect(text.parentElement?.className).not.toMatch(/flex-wrap/);
    // …and keeps its own width: the agent is what gives way.
    expect(screen.getByText("This session").className).toMatch(/\bflex-none\b/);
  });
});
