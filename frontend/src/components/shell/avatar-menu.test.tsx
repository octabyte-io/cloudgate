import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useSession,
}));

vi.mock("@/lib/auth/use-sign-out", () => ({
  useSignOut: () => ({ signOutNow: vi.fn() }),
}));

const { AvatarMenu } = await import("./avatar-menu");

const URSA = { id: "u1", name: "Ursa", email: "ursa@example.com" };

beforeEach(() => {
  useSession.mockReturnValue({ data: { user: URSA }, isPending: false });
});

afterEach(() => {
  cleanup();
  useSession.mockReset();
});

/**
 * Profile is the account screen the operator can use.
 *
 * It pointed at `/account`, which was written before F16 put the account screen
 * under Settings and was left rendering a "built in phase F16" placeholder.
 */
describe("AvatarMenu", () => {
  it("links Profile to Settings → Account", () => {
    render(<AvatarMenu />);

    fireEvent.click(screen.getByRole("button", { name: "Your account" }));

    expect(
      screen.getByRole("menuitem", { name: "Profile" }).getAttribute("href"),
    ).toBe("/settings/account");
  });

  /**
   * The Avatar and Last name saved on Settings → Account show where the
   * console represents the person
   * The button
   * was a person glyph whatever was saved, and the menu said the first name.
   */
  describe("the person it shows", () => {
    const URL = "https://avatars.example.com/u/9919?v=4";

    function renderAs(user: Record<string, unknown> | null) {
      useSession.mockReturnValue({
        data: user ? { user } : null,
        isPending: false,
      });
      render(<AvatarMenu />);
      return screen.getByRole("button", { name: "Your account" });
    }

    it("shows the saved avatar on the masthead button", () => {
      const button = renderAs({ ...URSA, lastName: "Ownerton", image: URL });

      expect(button.querySelector("img")?.getAttribute("src")).toBe(URL);
    });

    it("falls back to the initials when the avatar will not load", () => {
      const button = renderAs({ ...URSA, lastName: "Ownerton", image: URL });

      fireEvent.error(button.querySelector("img")!);

      expect(button.querySelector("img")).toBeNull();
      expect(button.textContent).toBe("UO");
    });

    it("keeps the person glyph when nobody is signed in yet", () => {
      const button = renderAs(null);

      expect(button.querySelector("img")).toBeNull();
      expect(button.querySelector("svg")).not.toBeNull();
    });

    it("names the person with their last name in the menu", () => {
      const button = renderAs({ ...URSA, lastName: "Ownerton", image: null });

      fireEvent.click(button);

      expect(screen.getByText("Ursa Ownerton")).toBeTruthy();
    });
  });
});
