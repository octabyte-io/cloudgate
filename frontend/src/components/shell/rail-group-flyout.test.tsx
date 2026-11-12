import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const recents = vi.hoisted(() => ({
  list: [] as { href: string; label: string }[],
}));

vi.mock("./scope-provider", () => ({
  useScope: () => ({ scope: { kind: "organization" } }),
}));
vi.mock("./recents", () => ({ useRecents: () => recents.list }));
vi.mock("./favourites", () => ({ useStarred: () => [] }));
vi.mock("./use-is-drawer", () => ({ useIsDrawer: () => false }));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "o1" }),
}));

const { RailEntry } = await import("./rail-entries");
const { toggleRail } = await import("./rail-state");

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-rail");
  recents.list = [];
});

function renderRecents() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RailEntry
        entry={{
          kind: "group",
          id: "recents",
          icon: "clock",
          label: "Recents",
          source: "recents",
        }}
        onNavigate={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/**
 * On the collapsed icon strip a group's sub-list has no room under the row, so
 * clicking Recents or Starred used to flip `aria-expanded` and show nothing.
 * The items open beside the icon now.
 */
describe("a rail group on the icon strip", () => {
  it("opens its items in a menu beside the icon", async () => {
    recents.list = [{ href: "/projects/p1", label: "Shop" }];
    act(() => toggleRail());
    renderRecents();

    fireEvent.click(screen.getByRole("button", { name: "Recents" }));

    const item = await screen.findByRole("menuitem", { name: "Shop" });
    expect(item.getAttribute("href")).toBe("/projects/p1");
  });

  it("says when there is nothing in it", async () => {
    act(() => toggleRail());
    renderRecents();

    fireEvent.click(screen.getByRole("button", { name: "Recents" }));

    expect(await screen.findByText("Nothing visited yet.")).toBeTruthy();
  });

  it("still opens the sub-list in place when the rail is expanded", () => {
    recents.list = [{ href: "/projects/p1", label: "Shop" }];
    renderRecents();

    fireEvent.click(screen.getByRole("button", { name: "Recents" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("link", { name: "Shop" })).toBeTruthy();
  });
});
