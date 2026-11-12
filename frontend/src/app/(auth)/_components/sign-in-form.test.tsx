import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const email = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
const signUpOpen = vi.hoisted(() => ({ state: "closed" as "closed" | "open" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => search.params,
}));

vi.mock("@/lib/auth/client", () => ({ signIn: { email } }));

vi.mock("./use-sso-config", () => ({
  useSsoConfig: () => ({ enabled: false, enforced: false, ready: true }),
}));

vi.mock("./use-sign-up-open", () => ({
  useSignUpOpen: () => ({ state: signUpOpen.state, ready: true }),
}));

// `GET /settings/whitelabeling`, at the hook every branded surface reads it
// through; unbranded unless a test says otherwise.
const branding = vi.hoisted(() => ({ appName: null as string | null }));
vi.mock("@/lib/api/use-branding", () => ({
  useBrandingOrDefault: () => ({ appName: branding.appName }),
}));

// What the session that was just created turned out to need.
const resolveOrganizationDestination = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/active-organization", () => ({
  resolveOrganizationDestination,
}));

const { SignInForm } = await import("./sign-in-form");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  branding.appName = null;
  search.params = new URLSearchParams();
  signUpOpen.state = "closed";
});

/**
 * Arriving from the templates website's "Deploy <app>" on its way to the
 * get-started wizard (ADR-0073): the screen says what signing in is for, and
 * "Create one" keeps the deep link, so signing up lands where signing in
 * would.
 */
describe("SignInForm, on the way to get-started", () => {
  const NEXT = "/get-started?template=ghost";

  it("says what signing in is for, and carries next to sign-up", () => {
    search.params = new URLSearchParams({ next: NEXT });
    signUpOpen.state = "open";
    render(<SignInForm />);

    expect(screen.getByText("Sign in to deploy your app")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Create one" }).getAttribute("href"),
    ).toBe(`/sign-up?next=${encodeURIComponent(NEXT)}`);
  });

  it("offers a plain Create one with no next", () => {
    signUpOpen.state = "open";
    render(<SignInForm />);

    expect(screen.queryByText("Sign in to deploy your app")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Create one" }).getAttribute("href"),
    ).toBe("/sign-up");
  });
});

/**
 * **A throttled sign-in waits out the throttle**.
 *
 * The sentence names the wait (`retry-after.test.ts` pins that on the wire);
 * this pins the other half. On the run that found it, one person sent eleven
 * throttled sign-ins in six seconds and every one was refused, so the button
 * stays off for exactly the wait the backend gave, then comes back.
 */
describe("SignInForm, when better-auth throttles it", () => {
  it("names the wait and holds the button until it has passed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // What the auth client's `onResponse` hook makes of a 429 carrying
    // `X-Retry-After: 9`.
    email.mockResolvedValue({
      data: null,
      error: {
        status: 429,
        statusText: "Too Many Requests",
        message: "Too many requests. Please try again later.",
        retryAfter: 9,
      },
    });
    render(<SignInForm />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);

    expect(
      await screen.findByText("Too many attempts. Try again in 9 seconds."),
    ).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);
    expect(email).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    // A countdown that has run out is no longer true, so it goes with the wait.
    expect(screen.queryByText(/Try again in 9 seconds/)).toBeNull();
  });
});

/**
 * **The door names the instance it opens**. The sign-in screen is the
 * surface `GET /settings/whitelabeling` was made public for, and the branding
 * used to be read by nothing — so an instance renamed over the API still said
 * only "Sign in" under Cloudgate's mark.
 */
describe("SignInForm, on a white-labelled instance", () => {
  it("puts the instance's name in the heading", () => {
    branding.appName = "Acme Deploy";
    render(<SignInForm />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in to Acme Deploy" }),
    ).toBeTruthy();
  });

  it("keeps the two-word heading when nothing is branded", () => {
    render(<SignInForm />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
  });
});

/**
 * **Several Organizations and no default are asked about**.
 *
 * The backend now leaves such a session in no Organization, and this is the
 * step that has to turn that into "Choose an Organization" — before that the
 * `choose` answer never arrived here, so nothing had ever shown it routed.
 */
describe("SignInForm, for a member of several Organizations with no default", () => {
  it("goes to /select-organization to ask which one", async () => {
    const assign = vi.fn();
    const location = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "http://localhost/sign-in" },
    });
    try {
      email.mockResolvedValue({ data: { user: { id: "u_1" } }, error: null });
      resolveOrganizationDestination.mockResolvedValue({
        kind: "choose",
        href: "/select-organization",
        organizations: [
          { id: "org_a", name: "Alpha" },
          { id: "org_b", name: "Beta" },
        ],
      });
      render(<SignInForm />);

      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "ida@example.test" },
      });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "super-secret-password" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      await vi.waitFor(() =>
        expect(assign).toHaveBeenCalledWith("/select-organization"),
      );
      expect(resolveOrganizationDestination).toHaveBeenCalledWith("/");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: location,
      });
    }
  });
});
