import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestPasswordReset = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", () => ({ requestPasswordReset }));

const { ForgotPasswordForm } = await import("./forgot-password-form");

/** `GET /auth/password-reset-open`, the read the page makes first. */
const fetchSpy = vi.fn();

function resetOpen(open: boolean) {
  fetchSpy.mockImplementation(async () =>
    new Response(JSON.stringify({ open }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function renderForm() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ForgotPasswordForm />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  // The read answers "open" by default, so the submit's own refusal is what
  // the cases below exercise.
  resetOpen(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * **The no-mail refusal names a path that exists**.
 *
 * With no mail sender better-auth refuses every reset with
 * `RESET_PASSWORD_DISABLED`, and the screen was right to say so. Its advice was
 * the defect: "Ask an owner to set a new password for you directly" sent people
 * to an action no console screen has, and on a fresh install the locked-out
 * person *is* the only owner. The one thing that makes reset work is a mail
 * sender, configured on the platform host.
 */
describe("ForgotPasswordForm, on an instance with no mail sender", () => {
  async function refuse() {
    requestPasswordReset.mockResolvedValue({
      data: null,
      error: { status: 400, code: "RESET_PASSWORD_DISABLED" },
    });
    renderForm();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "owner@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
    await screen.findByRole("heading", { name: "Reset is not set up" });
    return document.body.textContent ?? "";
  }

  it("sends them to the platform host, and names the file and the doc", async () => {
    const text = await refuse();
    expect(text).toMatch(/the platform host, the machine Cloudgate runs on/);
    expect(text).toMatch(/an email sender in \/etc\/default\/cloudgate-backend/);
    expect(text).toMatch(/docs\/deploy\.md, “Locked out”/);
    // A managed Server is a deploy target, not the machine this runs on.
    expect(text).not.toMatch(/this server/i);
  });

  it("does not promise an owner-side reset the console does not have", async () => {
    const text = await refuse();
    expect(text).not.toMatch(/Ask an owner/);
    expect(text).not.toMatch(/\b(owner|admin)\b/i);
  });

  it("still offers the way back to sign-in", async () => {
    await refuse();
    expect(
      screen.getByText("Back to sign in").closest("a")?.getAttribute("href"),
    ).toBe("/sign-in");
  });
});

/**
 * The page says up front that reset cannot send anything here, rather
 * than promising an email and refusing at submit; and when a submit does
 * replace the form, focus goes to what happened rather than to `<body>`.
 */
describe("ForgotPasswordForm, when reset cannot send email", () => {
  it("says reset is not set up before offering a form, when the instance cannot send email", async () => {
    resetOpen(false);
    renderForm();

    expect(
      await screen.findByRole("heading", { name: "Reset is not set up" }),
    ).toBeDefined();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(document.body.textContent).not.toMatch(/We will email you a link/);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      "/auth/password-reset-open",
    );
  });

  it("moves focus to the outcome after a submit", async () => {
    requestPasswordReset.mockResolvedValue({ data: {}, error: null });
    renderForm();
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "someone@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));

    const heading = await screen.findByRole("heading", {
      name: "The link is on its way",
    });
    expect(document.activeElement).toBe(heading);
  });
});
