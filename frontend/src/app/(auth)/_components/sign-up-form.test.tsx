import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const email = vi.hoisted(() => vi.fn());
const acceptInvitation = vi.hoisted(() => vi.fn());
const sendVerificationEmail = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
const instance = vi.hoisted(() => ({
  state: "unclaimed" as "unclaimed" | "closed" | "not-open-yet" | "open",
  turnstileSiteKey: undefined as string | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => search.params,
}));

vi.mock("@/lib/auth/client", () => ({
  signUp: { email },
  organization: { acceptInvitation },
  sendVerificationEmail,
}));

vi.mock("./use-sign-up-open", () => ({
  useSignUpOpen: () => ({
    state: instance.state,
    ready: true,
    turnstileSiteKey: instance.turnstileSiteKey,
  }),
}));

// The invitation read has its own test (`invitation-preview.test.tsx`);
// here it has answered nothing, so an invited form is the plain one.
vi.mock("./invitation-preview", () => ({
  useInvitationPreview: () => ({ ready: true, preview: undefined }),
  InvitationNotOpen: () => null,
}));

vi.mock("@/lib/auth/active-organization", () => ({
  resolveOrganizationDestination: vi.fn(async () => ({ kind: "none" })),
}));

const { SignUpForm } = await import("./sign-up-form");

beforeEach(() => {
  email.mockResolvedValue({ data: {}, error: null });
  acceptInvitation.mockResolvedValue({ data: {}, error: null });
  sendVerificationEmail.mockResolvedValue({
    data: { status: true },
    error: null,
  });
});

afterEach(() => {
  cleanup();
  email.mockReset();
  acceptInvitation.mockReset();
  sendVerificationEmail.mockReset();
  search.params = new URLSearchParams();
  instance.state = "unclaimed";
  instance.turnstileSiteKey = undefined;
  delete window.turnstile;
});

function fill() {
  for (const [label, value] of [
    ["First name", "Ursa"],
    ["Last name", "Major"],
    ["Email", "ursa@example.test"],
    ["Password", "correct-horse"],
    ["Confirm password", "correct-horse"],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

/**
 * The owner names the first Organization while setting the instance up,
 * where every instance used to start as "My Organization" until somebody found
 * Settings → Organizations → Rename.
 */
describe("SignUpForm, the Organization's name", () => {
  it("asks the owner, with My Organization already filled in", async () => {
    render(<SignUpForm />);
    const field = screen.getByLabelText(
      "Organization name",
    ) as HTMLInputElement;
    expect(field.value).toBe("My Organization");

    fill();
    fireEvent.change(field, { target: { value: "  Acme Ops " } });
    fireEvent.click(
      screen.getByRole("button", { name: "Create owner account" }),
    );

    await waitFor(() => expect(email).toHaveBeenCalledTimes(1));
    expect(email.mock.calls[0][0]).toMatchObject({
      organizationName: "Acme Ops",
    });
  });

  it("does not ask someone joining by invitation", async () => {
    search.params = new URLSearchParams("invitation=inv-1");
    render(<SignUpForm />);
    expect(screen.queryByLabelText("Organization name")).toBeNull();

    fill();
    fireEvent.click(
      screen.getByRole("button", { name: "Create account and join" }),
    );

    await waitFor(() => expect(email).toHaveBeenCalledTimes(1));
    expect(email.mock.calls[0][0]).not.toHaveProperty("organizationName");
  });
});

/**
 * The Hosted instance: "not open yet" until its Instance organization
 * has been made on the platform host, then a public form that claims nothing.
 */
describe("SignUpForm on the Hosted instance", () => {
  it("says sign-up is not open yet, with nothing to fill in", () => {
    instance.state = "not-open-yet";
    render(<SignUpForm />);

    expect(screen.getByText("Sign-up is not open yet")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByText("Set up this instance")).toBeNull();
  });

  it("offers the public form once it is open, not the owner's", async () => {
    instance.state = "open";
    render(<SignUpForm />);

    expect(screen.getByText("Create your account")).toBeTruthy();
    expect(screen.queryByText("Set up this instance")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create owner account" }),
    ).toBeNull();

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(email).toHaveBeenCalledTimes(1));
  });

  it("turns into the not-open-yet state when the submit is refused as such", async () => {
    instance.state = "open";
    email.mockResolvedValue({
      data: null,
      error: {
        status: 400,
        code: "SIGN_UP_NOT_OPEN_YET",
        message: "Sign-up is not open yet",
      },
    });
    render(<SignUpForm />);

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(screen.getByText("Sign-up is not open yet")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Email")).toBeNull();
  });
});

/**
 * After a Hosted sign-up: no session until the email is confirmed, so
 * the form gives way to "check your inbox", which can send the link again.
 */
describe("SignUpForm, check your inbox", () => {
  async function signUpOnHosted() {
    instance.state = "open";
    render(<SignUpForm />);
    fill();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Ursa Labs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(screen.getByText("Check your inbox")).toBeTruthy(),
    );
  }

  it("asks for the link to land on sign-in, and then says where it went", async () => {
    await signUpOnHosted();

    expect(email.mock.calls[0][0]).toMatchObject({
      organizationName: "Ursa Labs",
      callbackURL: "/sign-in",
    });
    expect(
      screen.getByText(/We sent a link to ursa@example\.test/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toBeTruthy();
  });

  it("sends a new email from the resend button", async () => {
    await signUpOnHosted();

    fireEvent.click(
      screen.getByRole("button", { name: "Send the link again" }),
    );

    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(1));
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "ursa@example.test",
      callbackURL: "/sign-in",
    });
    await waitFor(() =>
      expect(
        screen.getByText("A new link is on its way to ursa@example.test."),
      ).toBeTruthy(),
    );
  });

  it("says why when the resend is refused", async () => {
    await signUpOnHosted();
    sendVerificationEmail.mockResolvedValue({
      data: null,
      error: { status: 429, message: "Too many requests", retryAfter: 7 },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Send the link again" }),
    );

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.queryByText(/A new link is on its way/)).toBeNull();
  });

  it("does not show it on a Self-hosted instance, whose first account is signed in", async () => {
    render(<SignUpForm />);
    fill();
    fireEvent.click(
      screen.getByRole("button", { name: "Create owner account" }),
    );

    await waitFor(() => expect(email).toHaveBeenCalledTimes(1));
    expect(email.mock.calls[0][0]).not.toHaveProperty("callbackURL");
    expect(screen.queryByText("Check your inbox")).toBeNull();
  });
});

/**
 * Arriving from the templates website's "Deploy <app>" on its way to the
 * get-started wizard (ADR-0073): the deep link survives sign-up, the inbox
 * and the confirmation link, which signs the person in and lands on it.
 */
describe("SignUpForm, on the way to get-started", () => {
  const NEXT = "/get-started?template=ghost";

  async function signUpFrom(next: string) {
    search.params = new URLSearchParams({ next });
    instance.state = "open";
    render(<SignUpForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(screen.getByText("Check your inbox")).toBeTruthy(),
    );
  }

  it("says what the account is for, and keeps next on the way to sign in", () => {
    search.params = new URLSearchParams({ next: NEXT });
    instance.state = "open";
    render(<SignUpForm />);

    expect(
      screen.getByText("Create your free account to deploy your app"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe(`/sign-in?next=${encodeURIComponent(NEXT)}`);
  });

  it("asks for the link to land on next, and the resend too", async () => {
    await signUpFrom(NEXT);

    expect(email.mock.calls[0][0]).toMatchObject({ callbackURL: NEXT });
    expect(
      screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href"),
    ).toBe(`/sign-in?next=${encodeURIComponent(NEXT)}`);

    fireEvent.click(
      screen.getByRole("button", { name: "Send the link again" }),
    );
    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalledTimes(1));
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "ursa@example.test",
      callbackURL: NEXT,
    });
  });

  it("lands a next on another site on sign-in instead", async () => {
    await signUpFrom("//evil.example/get-started");

    expect(email.mock.calls[0][0]).toMatchObject({ callbackURL: "/sign-in" });
  });
});

/**
 * Cloudflare Turnstile on the Hosted public form. Cloudflare's script
 * is stood in for by `window.turnstile`, which hands the widget a token as
 * soon as it renders, the way a visitor who passes the check gets one.
 */
describe("SignUpForm, Turnstile on the Hosted instance", () => {
  const SITE_KEY = "0x4AAAAAAAsite";
  const render_ = vi.fn();
  const reset = vi.fn();

  beforeEach(() => {
    render_.mockReset();
    reset.mockReset();
    window.turnstile = {
      render: (container, options) => {
        render_(container, options);
        options.callback("token-from-cloudflare");
        return "widget-1";
      },
      reset,
      remove: vi.fn(),
    };
  });

  function fillPublic() {
    fill();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Ursa Labs" },
    });
  }

  it("renders the widget with the instance's site key, and sends its token", async () => {
    instance.state = "open";
    instance.turnstileSiteKey = SITE_KEY;
    render(<SignUpForm />);

    const widget = screen.getByTestId("turnstile");
    expect(widget.getAttribute("data-sitekey")).toBe(SITE_KEY);
    await waitFor(() => expect(render_).toHaveBeenCalledTimes(1));
    expect(render_.mock.calls[0][1]).toMatchObject({ sitekey: SITE_KEY });

    fillPublic();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(email).toHaveBeenCalledTimes(1));
    expect(email.mock.calls[0][1]).toEqual({
      headers: { "x-captcha-response": "token-from-cloudflare" },
    });
  });

  it("asks for the check before sending a sign-up without a token", async () => {
    instance.state = "open";
    instance.turnstileSiteKey = SITE_KEY;
    window.turnstile = { render: () => "widget-1", reset, remove: vi.fn() };
    render(<SignUpForm />);

    fillPublic();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Complete the check above the button/),
      ).toBeTruthy(),
    );
    expect(email).not.toHaveBeenCalled();
  });

  it("gets a fresh token after a refused sign-up", async () => {
    instance.state = "open";
    instance.turnstileSiteKey = SITE_KEY;
    email.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        code: "VERIFICATION_FAILED",
        message: "Captcha verification failed",
      },
    });
    render(<SignUpForm />);
    await waitFor(() => expect(render_).toHaveBeenCalledTimes(1));

    fillPublic();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(reset).toHaveBeenCalledWith("widget-1"));
  });

  it("has no widget on a Self-hosted instance", () => {
    render(<SignUpForm />);

    expect(screen.queryByTestId("turnstile")).toBeNull();
  });

  it("has no widget on an invited sign-up, which its invitation authorises", () => {
    instance.state = "open";
    instance.turnstileSiteKey = SITE_KEY;
    search.params = new URLSearchParams({ invitation: "inv_1" });
    render(<SignUpForm />);

    expect(screen.queryByTestId("turnstile")).toBeNull();
  });
});
