import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "sess_Jq8vT2kLw9xR";

vi.mock("@/lib/auth/client", () => ({
  signIn: { email: vi.fn() },
  signOut: vi.fn(),
  useSession: () => ({
    isPending: false,
    data: {
      user: { email: "owner@example.test" },
      session: { id: SESSION_ID, activeOrganizationId: "org_a" },
    },
  }),
}));

vi.mock("@/lib/api/endpoints/users", () => ({
  usersApi: { me: () => new Promise(() => {}) },
}));

const { SessionPanel } = await import("./session-panel");

afterEach(cleanup);

/**
 * `/dev/data` does not print the reader's session id. It did, in the
 * clear, next to their email — on a page the production build served. The id
 * is what revocation is keyed by (ADR-0009), and proving that a session exists
 * needs none of it: "Signed in as" already says so.
 */
describe("SessionPanel", () => {
  it("says who is signed in without printing the session id", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionPanel />
      </QueryClientProvider>,
    );

    expect(screen.getByText("owner@example.test")).toBeTruthy();
    expect(container.textContent).not.toContain(SESSION_ID);
    expect(screen.queryByText("Session id")).toBeNull();
  });
});
