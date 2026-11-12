import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const grants = vi.hoisted(() => ({ project: true, server: true }));
const stars = vi.hoisted(() => ({
  current: [] as { id: string; label: string; href: string }[],
}));

vi.mock("./use-home-data", () => ({
  useHomeData: () => ({
    servers: { data: [], isPending: false, error: null, isError: false },
    projects: { data: [], isPending: false, error: null, isError: false },
    shownServers: [],
    shownProjects: [],
    serverReach: { reachable: 0, unreachable: 0, unchecked: 0 },
    environmentCount: () => undefined,
  }),
}));

vi.mock("@/components/shell/recents", () => ({ useRecents: () => [] }));
vi.mock("@/components/shell/favourites", () => ({
  useStarred: () => stars.current,
}));

vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: (statement: Record<string, string[]>) => ({
    allowed: "server" in statement ? grants.server : grants.project,
    pending: false,
  }),
}));

// The two create flows are the list screens' own, and reach the session stack
// and the router; this is about whether the home page offers them.
vi.mock("@/features/project/project-form-modal", () => ({
  ProjectFormModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="New Project" /> : null,
}));
vi.mock("@/features/server/fleet/add-server-modal", () => ({
  AddServerModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Add a Server" /> : null,
}));
vi.mock("@/features/ssh-keys/manage-keys-modal", () => ({
  ManageKeysModal: () => null,
}));
vi.mock("./quick-search", () => ({ QuickSearch: () => null }));

const { OrganizationHome } = await import("./organization-home");

beforeEach(() => {
  stars.current = [];
  grants.project = true;
  grants.server = true;
});
afterEach(cleanup);

/**
 * On a new
 * instance the home page is the first screen the owner sees, and its empty
 * Servers and Projects cards said what the thing was and offered no way to make
 * one — the only controls were two 24px "All" buttons.
 */
describe("OrganizationHome with nothing in it", () => {
  it("offers New Project and Add a Server on the empty cards", () => {
    render(<OrganizationHome />);

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    expect(screen.getByRole("dialog", { name: "New Project" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add a Server" }));
    expect(screen.getByRole("dialog", { name: "Add a Server" })).toBeTruthy();
  });

  it("holds both off, saying why, for a role that can create neither", () => {
    grants.project = false;
    grants.server = false;
    render(<OrganizationHome />);

    for (const name of ["New Project", "Add a Server"]) {
      const button = screen.getByRole("button", { name });
      // §3.10 — an off action keeps its place and can say why it is off.
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toMatch(/^Your role in this Organization cannot/);
      fireEvent.click(button);
    }

    // Nothing opened.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * A star was shown
 * only on the header it was clicked on. Home lists them beside Recents.
 */
describe("OrganizationHome's Starred card", () => {
  it("links each starred resource by its path", () => {
    stars.current = [
      {
        id: "env-1",
        label: "ui-main / staging",
        href: "/environments/env-1",
      },
    ];
    render(<OrganizationHome />);

    // By text rather than by name: jsdom drops the space that ends the
    // "ui-main / " prefix span when it computes an accessible name.
    const row = screen.getByRole("link", { name: /staging/ });
    expect(row.textContent).toBe("ui-main / staging");
    expect(row.getAttribute("href")).toBe("/environments/env-1");
  });

  it("says how to star something when nothing is starred", () => {
    render(<OrganizationHome />);

    expect(screen.getByRole("heading", { name: "Starred" })).toBeTruthy();
    expect(screen.getByText(/^Star a Server, a Project or an Environment/)).toBeTruthy();
  });
});

/**
 * A "This
 * Organization" strip under the cards said the Servers and Projects counts a
 * second time. The cards' headers are where those counts live.
 */
describe("OrganizationHome's counts", () => {
  it("says each count once, on its card", () => {
    render(<OrganizationHome />);

    expect(screen.queryByText("This Organization")).toBeNull();
    expect(screen.getAllByText("0 total · 0 reachable")).toHaveLength(1);
    expect(screen.getAllByText("0 total")).toHaveLength(1);
  });
});
