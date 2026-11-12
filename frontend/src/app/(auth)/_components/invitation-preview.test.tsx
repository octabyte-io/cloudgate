import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => search.params,
}));

vi.mock("@/lib/auth/client", () => ({
  signUp: { email: vi.fn() },
  organization: { acceptInvitation: vi.fn() },
}));

vi.mock("./use-sign-up-open", () => ({
  useSignUpOpen: () => ({ state: "unclaimed", ready: true }),
}));

const { InvitationDoors } = await import("./invitation-doors");
const { SignUpForm } = await import("./sign-up-form");

/**
 * An invitation link is checked when its page loads. A made-up id said
 * "You have been invited" and let the visitor fill in the whole sign-up form
 * before the submit was refused. `GET /auth/invitations/:id` is the boundary;
 * `fetch` answers for it.
 */

const fetchSpy = vi.fn();

function answers(body: unknown) {
  fetchSpy.mockImplementation(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const OPEN = {
  open: true,
  organizationName: "Acme",
  email: "ada@example.com",
};

function renderIn(node: React.ReactNode) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  search.params = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the invitation landing page, signed out", () => {
  it("asks the public invitation read for the id in the link", async () => {
    answers(OPEN);
    renderIn(<InvitationDoors invitationId="inv_1" />);

    await screen.findByText(/has been invited to Acme/);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      "/auth/invitations/inv_1",
    );
  });

  it("refuses a made-up id before offering any door", async () => {
    answers({ open: false, code: "INVITATION_NOT_OPEN" });
    renderIn(<InvitationDoors invitationId="bogus-id" />);

    expect(
      await screen.findByText("This invitation link is not valid"),
    ).toBeDefined();
    expect(screen.queryByText("You have been invited")).toBeNull();
    expect(screen.queryByText("Create an account")).toBeNull();
  });

  it("says an expired invitation has expired", async () => {
    answers({ open: false, code: "INVITATION_EXPIRED" });
    renderIn(<InvitationDoors invitationId="inv_old" />);

    expect(await screen.findByText("This invitation has expired")).toBeDefined();
  });

  it("names the Organization and the address of an open one, with both doors", async () => {
    answers(OPEN);
    renderIn(<InvitationDoors invitationId="inv_1" />);

    expect(
      await screen.findByText(
        "ada@example.com has been invited to Acme. Sign in to accept it, or create an account with that address.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Create an account")).toBeDefined();
  });
});

describe("the invited sign-up form", () => {
  it("refuses a made-up invitation instead of showing the form", async () => {
    search.params = new URLSearchParams("invitation=bogus-id");
    answers({ open: false, code: "INVITATION_NOT_OPEN" });
    renderIn(<SignUpForm />);

    expect(
      await screen.findByText("This invitation link is not valid"),
    ).toBeDefined();
    expect(screen.queryByRole("textbox", { name: /Email/ })).toBeNull();
  });

  it("names the Organization and fills in the invited address", async () => {
    search.params = new URLSearchParams("invitation=inv_1");
    answers(OPEN);
    renderIn(<SignUpForm />);

    expect(
      await screen.findByText(
        "You have been invited to Acme. Create an account with ada@example.com to join it.",
      ),
    ).toBeDefined();
    const email = screen.getByRole("textbox", { name: /Email/ });
    expect((email as HTMLInputElement).value).toBe("ada@example.com");
  });
});
