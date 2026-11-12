import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./scope-provider", () => ({
  useScope: () => ({ nav: [], exit: null, exitPending: false }),
}));

vi.mock("./masthead-crumb", () => ({ MastheadCrumb: () => null }));
vi.mock("./scope-identity", () => ({ ScopeIdentity: () => null }));
vi.mock("./org-switcher", () => ({ OrgSwitcher: () => null }));
vi.mock("./avatar-menu", () => ({ AvatarMenu: () => null }));
vi.mock("@/components/console/brand-mark", () => ({ BrandMark: () => null }));
vi.mock("@/lib/api/use-branding", () => ({
  useBrandingOrDefault: () => ({ appName: null }),
}));

const { ScopeRail } = await import("./scope-rail");
const { Masthead } = await import("./masthead");

beforeAll(() => {
  // jsdom lays nothing out, and `containTab` only counts what is on screen.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});

afterEach(cleanup);

function rail(drawerOpen: boolean, onClose = vi.fn()) {
  render(
    <ScopeRail
      drawerOpen={drawerOpen}
      isDrawer
      onNavigate={vi.fn()}
      onClose={onClose}
      onSearch={vi.fn()}
    />,
  );
  return onClose;
}

/** The phone's navigation drawer behaves as a modal while it is open. */
describe("the navigation drawer", () => {
  it("moves focus to its first control when it opens", () => {
    rail(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Quick search/ }),
    );
  });

  it("closes on Escape", () => {
    const onClose = rail(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside it", () => {
    rail(true);
    const last = screen.getByRole("button", { name: "Collapse navigation" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Quick search/ }),
    );
  });

  it("does none of that while closed", () => {
    const onClose = rail(false);
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(screen.getByRole("navigation", { hidden: true }), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("names the toggle for what it will do", () => {
    const { rerender } = render(
      <Masthead
        scrolled={false}
        isDrawer
        drawerOpen={false}
        onDrawerToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Show navigation" })).toBeTruthy();
    rerender(
      <Masthead scrolled={false} isDrawer drawerOpen onDrawerToggle={vi.fn()} />,
    );
    expect(
      screen
        .getByRole("button", { name: "Hide navigation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
