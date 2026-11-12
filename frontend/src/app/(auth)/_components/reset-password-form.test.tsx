import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => search.params,
}));

vi.mock("@/lib/auth/client", () => ({ resetPassword: vi.fn() }));

const { ResetPasswordForm } = await import("./reset-password-form");

afterEach(cleanup);

/**
 * A link with no token is incomplete, not expired, so it does not wear
 * the expired heading — the page used to say "Link is no longer valid" over a
 * body saying "This link is incomplete".
 */
describe("ResetPasswordForm, arriving with nothing usable", () => {
  it("names a link with no token incomplete, in the heading too", () => {
    search.params = new URLSearchParams();
    render(<ResetPasswordForm />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Link is incomplete",
    );
    expect(screen.getByText("This link is incomplete")).toBeDefined();
    expect(screen.queryByText("Link is no longer valid")).toBeNull();
  });

  it("keeps the expired wording for a token the callback rejected", () => {
    search.params = new URLSearchParams("error=INVALID_TOKEN");
    render(<ResetPasswordForm />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Link is no longer valid",
    );
    expect(
      screen.getByText("This link has been used or has expired"),
    ).toBeDefined();
  });
});
