import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const showSsoSignIn = vi.hoisted(() => vi.fn());
const enforceSso = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth/client", () => ({ signIn: { email: vi.fn() } }));

// The two public reads the sign-in screen makes, at the HTTP boundary; the
// screen's own `useSsoConfig` runs for real.
vi.mock("@/lib/api/endpoints/sso", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/sso")>()),
  showSsoSignIn,
  enforceSso,
}));

vi.mock("./use-sign-up-open", () => ({
  useSignUpOpen: () => ({ state: "closed", ready: true }),
}));

vi.mock("@/lib/api/use-branding", () => ({
  useBrandingOrDefault: () => ({ appName: null }),
}));

const { SignInForm } = await import("./sign-in-form");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderSignIn(enabled: boolean, enforced = false) {
  showSsoSignIn.mockResolvedValue({ enabled });
  enforceSso.mockResolvedValue({ enforced });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SignInForm />
    </QueryClientProvider>,
  );
}

/**
 * The SSO button follows `GET /sso/show-sign-in` and nothing else: on
 * the Hosted instance that is false until an Enterprise Organization has a
 * provider with a Proven domain, and the screen offers no button until then.
 */
describe("SignInForm's SSO offer", () => {
  it("offers no SSO button while the backend says SSO is not set up", async () => {
    renderSignIn(false);

    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByLabelText(/work email/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sso/i })).toBeNull();
  });

  it("offers the SSO button once the backend says it is", async () => {
    renderSignIn(true);

    expect(await screen.findByRole("button", { name: /sso/i })).toBeTruthy();
  });
});

/**
 * SSO-only (`enforceSSO`) is kept without a plan check so an instance can
 * always switch it back. So the screen has to keep a way in when SSO
 * sign-in itself has stopped: it drops the password form only while it offers
 * the button.
 */
describe("SignInForm with SSO-only set", () => {
  it("shows only the SSO button while SSO sign-in is offered", async () => {
    renderSignIn(true, true);

    expect(await screen.findByRole("button", { name: /sso/i })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("shows the password form when SSO sign-in is not offered", async () => {
    renderSignIn(false, true);

    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.getByText("Forgot your password?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sso/i })).toBeNull();
  });
});
