import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({ name: "My Organization" }));

// The cell's own parts are tested beside them; here only the cell is.
vi.mock("./org-switcher", () => ({
  OrgSwitcher: () => (
    <button type="button">
      <span data-org-name>{shown.name}</span>
    </button>
  ),
}));
vi.mock("./avatar-menu", () => ({ AvatarMenu: () => null }));
vi.mock("./masthead-crumb", () => ({ MastheadCrumb: () => null }));
vi.mock("./scope-identity", () => ({ ScopeIdentity: () => null }));
vi.mock("./scope-provider", () => ({
  useScope: () => ({ identity: null, pending: false }),
}));
vi.mock("@/lib/api/use-branding", async (original) => {
  const actual = await original<typeof import("@/lib/api/use-branding")>();
  const { UNBRANDED } = await import("@/lib/branding/branding");
  return { ...actual, useBrandingOrDefault: () => UNBRANDED };
});

const { Masthead } = await import("./masthead");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  render(
    <Masthead
      scrolled={false}
      isDrawer={false}
      drawerOpen={false}
      onDrawerToggle={() => {}}
    />,
  );
  const home = screen.getByRole("link", { name: /Organization home/ });
  return {
    cell: home.parentElement!,
    word: screen.getByText("cloudgate"),
  };
}

/**
 * jsdom lays nothing out, so the widths the cell is measured by are given:
 * the name's whole width and its room, and the word's.
 */
function laidOut({
  nameWidth,
  nameRoom,
}: {
  nameWidth: number;
  nameRoom: number;
}) {
  const named = (element: HTMLElement) => element.hasAttribute("data-org-name");
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return named(this) ? nameWidth : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return named(this) ? nameRoom : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.textContent === "cloudgate" &&
        !this.classList.contains("hidden")
        ? 80
        : 0;
    },
  );
}

describe("the masthead's Organization cell", () => {
  it("is exactly the rail's width, so its border and the rail's are one line", () => {
    const { cell } = mount();

    const classes = cell.className.split(/\s+/);
    expect(classes).toContain("w-(--rail-w)");
    // It used to be the rail's at least, growing for a long name.
    expect(classes).not.toContain("w-max");
    expect(classes).not.toContain("min-w-(--rail-w)");
    expect(classes).not.toContain("max-w-2/5");
    // The strip and the drawer keep their own widths.
    expect(classes).toContain("railc:w-(--rail-w)");
    expect(classes).toContain("max-rail:w-auto");
  });

  it("keeps the wordmark beside a short name", () => {
    shown.name = "Acme";
    laidOut({ nameWidth: 34, nameRoom: 100 });
    const { word } = mount();

    expect(word.classList.contains("hidden")).toBe(false);
  });

  it("drops the wordmark to the glyph when the name does not fit beside it", () => {
    shown.name = "My Organization";
    laidOut({ nameWidth: 112, nameRoom: 72 });
    const { word } = mount();

    expect(word.classList.contains("hidden")).toBe(true);
    expect(screen.getByText("My Organization")).toBeTruthy();
  });
});
