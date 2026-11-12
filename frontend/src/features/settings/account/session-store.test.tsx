import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserProfile, UserSession } from "@/lib/api/endpoints/users";

const listSessions = vi.hoisted(() => vi.fn());
const updateMe = vi.hoisted(() => vi.fn());
const enableTwoFactor = vi.hoisted(() => vi.fn());
const verifyTwoFactor = vi.hoisted(() => vi.fn());
const disableTwoFactor = vi.hoisted(() => vi.fn());

// Two boundaries replaced. Nest's `/users/me/*` routes are one — they are what
// the console writes through, and the test is not about them. The toast is the
// other, because it renders through a portal nothing here reads. **better-auth's
// client is deliberately NOT mocked**: its session store is the thing under
// test, and a double in its place would pass whether or not anything tells it
// to refetch (the same argument `organizations-section.test.tsx` makes).
vi.mock("@/lib/api/endpoints/users", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/users")>();
  return {
    ...actual,
    usersApi: {
      ...actual.usersApi,
      listSessions,
      updateMe,
      enableTwoFactor,
      verifyTwoFactor,
      disableTwoFactor,
    },
  };
});

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/use-sign-out", () => ({
  useSignOut: () => ({ signOutNow: vi.fn(), pending: false }),
}));

/** The `session` and `user` rows, as far as this test is concerned. */
let server: { sessionId: string; name: string; email: string };

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** better-auth's `get-session`, answered off the rows the mocked writes change. */
const authServer = vi.fn(() =>
  Promise.resolve(
    json({
      session: { id: server.sessionId, userId: "user_1" },
      user: { id: "user_1", name: server.name, email: server.email },
    }),
  ),
);

// Stubbed before the auth client is imported — `createAuthClient` captures
// `fetch` while the module evaluates. `organizations-section.test.tsx` says why
// at length; everything that pulls `@/lib/auth/client` in has to land after it.
vi.stubGlobal("fetch", authServer);

const { authClient } = await import("@/lib/auth/client");
const { SessionsCard } = await import("./sessions-card");
const { ProfileCard } = await import("./profile-card");
const { EnrolTwoFactorModal } = await import("./enrol-two-factor-modal");
const { DisableTwoFactorModal } = await import("./disable-two-factor-modal");

/**
 * Every `/users/me/*` write that changes what `get-session` answers, read back
 * through better-auth's own store.
 *
 * **The defect was a disagreement between two stores.** The account screens
 * write through Nest and refresh TanStack's `account` keys; the avatar menu and
 * the Sessions card's "This session" read `useSession()`, which is better-auth's
 * nanostore and which only refetches for writes made through its *own* client.
 * So a saved name stayed old in the menu, and — the worse half — turning
 * two-factor on or off rotated this browser's session, and the card went on
 * matching rows against the dead id: no row said "This session", and the row
 * that was this browser offered Revoke.
 *
 * The reader here is a two-line component over the real `useSession`, rather
 * than the masthead's `AvatarMenu` itself, so the assertion is about the store
 * and not about a menu's popup mechanics.
 */
function SessionName() {
  const { data } = authClient.useSession();
  return <p data-testid="session-name">{data?.user.name ?? "none"}</p>;
}

function row(id: string): UserSession {
  return {
    id,
    userId: "user_1",
    userAgent: `UA ${id}`,
    ipAddress: "192.0.2.1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2099-09-01T00:00:00.000Z",
  } as UserSession;
}

const profile = {
  id: "user_1",
  firstName: "Ursa",
  lastName: "Ownerton",
  email: "ursa@example.test",
  image: null,
} as UserProfile;

function renderWith(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

/** The row "This session" sits on, by the user agent it renders. */
function currentRow() {
  return screen.getByText("This session").closest("tr")?.textContent ?? "";
}

beforeEach(async () => {
  server = { sessionId: "session_old", name: "Ursa", email: profile.email };
  listSessions.mockImplementation(() =>
    Promise.resolve([row(server.sessionId), row("session_other")]),
  );
  // Settle the store on the pre-write state, so a later read is a refetch and
  // not the store's first load.
  await authClient.$store.atoms.session.get().refetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("account writes refresh better-auth's session store", () => {
  it("marks the rotated session as this one once two-factor is turned on, with no reload", async () => {
    enableTwoFactor.mockResolvedValue({
      totpURI: "otpauth://totp/Cloudgate:ursa?secret=ABC",
      backupCodes: ["aaaa-1111"],
    });
    verifyTwoFactor.mockImplementation(() => {
      // What `verifyTOTP` does: this browser's row is deleted and a new one
      // minted in its place.
      server.sessionId = "session_new";
      return Promise.resolve({});
    });

    renderWith(
      <>
        <SessionsCard />
        <EnrolTwoFactorModal open onOpenChange={() => {}} />
      </>,
    );
    await waitFor(() => expect(currentRow()).toContain("UA session_old"));

    fireEvent.change(screen.getByLabelText("Your password"), {
      target: { value: "hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText(/six-digit code/), {
      target: { value: "902 112" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on two-factor" }));

    await waitFor(() => expect(verifyTwoFactor).toHaveBeenCalled());
    await waitFor(() => expect(currentRow()).toContain("UA session_new"));
    // And the row that is this browser does not offer to revoke itself.
    const self = screen.getByText("This session").closest("tr")!;
    expect(within(self).queryByRole("button", { name: /Revoke/ })).toBeNull();
  });

  it("marks the rotated session as this one once two-factor is turned off", async () => {
    disableTwoFactor.mockImplementation(() => {
      server.sessionId = "session_after_disable";
      return Promise.resolve({});
    });

    renderWith(
      <>
        <SessionsCard />
        <DisableTwoFactorModal open onOpenChange={() => {}} />
      </>,
    );
    await waitFor(() => expect(currentRow()).toContain("UA session_old"));

    fireEvent.change(screen.getByLabelText("Your password"), {
      target: { value: "hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn off two-factor" }));

    await waitFor(() => expect(disableTwoFactor).toHaveBeenCalled());
    await waitFor(() =>
      expect(currentRow()).toContain("UA session_after_disable"),
    );
  });

  it("names the person by the saved name once the profile is saved", async () => {
    updateMe.mockImplementation((input: { firstName: string }) => {
      server.name = input.firstName;
      return Promise.resolve({ ...profile, firstName: input.firstName });
    });

    renderWith(
      <>
        <SessionName />
        <ProfileCard profile={profile} />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("session-name").textContent).toBe("Ursa"),
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ursula" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateMe).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("session-name").textContent).toBe("Ursula"),
    );
  });
});
