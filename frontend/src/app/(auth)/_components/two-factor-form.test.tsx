import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
}));

vi.mock("@/lib/auth/client", () => ({
  twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
}));

const { TwoFactorForm } = await import("./two-factor-form");

beforeEach(() => {
  search.params = new URLSearchParams();
});

afterEach(cleanup);

/**
 * **The challenge has a way back**.
 *
 * `/2fa` was the one auth screen with no footer, so the wordmark was its only
 * link: someone who typed the wrong email, or picked up the wrong account, had
 * to guess that the logo was the exit. And nothing said what to do without the
 * authenticator app — the backup-code switch covers half of that, and the other
 * half is whoever manages the platform host, because the console has no way
 * to turn another account's two-step verification off.
 */
describe("TwoFactorForm", () => {
  function backLink() {
    return screen.getByRole("link", { name: "Back to sign in" });
  }

  it("links back to sign-in from the authenticator view", () => {
    render(<TwoFactorForm />);
    expect(backLink().getAttribute("href")).toBe("/sign-in");
  });

  it("links back to sign-in from the backup-code view", () => {
    render(<TwoFactorForm />);
    fireEvent.click(screen.getByRole("button", { name: "Backup code" }));
    expect(screen.getByLabelText("Backup code")).toBeTruthy();
    expect(backLink().getAttribute("href")).toBe("/sign-in");
  });

  it("carries the intended destination back to sign-in", () => {
    search.params = new URLSearchParams({ next: "/projects/p_1" });
    render(<TwoFactorForm />);
    expect(backLink().getAttribute("href")).toBe(
      "/sign-in?next=%2Fprojects%2Fp_1",
    );
  });

  it("says what to do without the authenticator app or a backup code", () => {
    render(<TwoFactorForm />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/the platform host, the machine Cloudgate runs on/);
    expect(text).not.toMatch(/this server/i);
    // The console has no owner-side reset for another account's second factor
    //, so the screen must not send anyone to look for one.
    expect(text).not.toMatch(/\b(owner|admin)\b/i);
  });
});
