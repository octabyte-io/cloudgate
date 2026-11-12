import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Team } from "@/lib/api/endpoints/organizations";

const removeTeam = vi.fn();

/**
 * `usePermission`'s verdict, held by statement. Everything is held
 * unless a case takes it away; the decision itself is pinned in
 * `use-permission.test.ts`.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

vi.mock("./use-members", () => ({
  useTeams: () => ({ data: teams, isPending: false, error: null }),
  useRemoveTeam: () => ({ isPending: false, mutateAsync: removeTeam }),
  useTeamMembers: (teamId: string | null) => ({
    data: teamId === null ? undefined : roster,
    isPending: false,
    error: null,
  }),
  useMembers: () => ({ data: { members: [] }, isPending: false, error: null }),
  useAddTeamMember: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRemoveTeamMember: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useCreateTeam: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRenameTeam: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { TeamsCard } = await import("./teams-card");

/**
 * That **Delete asks before it takes the roster with it**.
 *
 * `removeTeam.mutateAsync` ran from the row's own Delete, and `team_member`
 * cascades — so one press deleted the team *and* every membership row under it,
 * with nothing keeping a copy. As in `invitations-card.test.tsx`, the first
 * assertion is that nothing was sent; the count is the second, because "delete
 * this team" and "delete this team and its two members" are different decisions
 * and the row cannot tell them apart.
 */

const TEAM = { id: "team_1", name: "Platform" } as Team;

let teams: Team[];
/** `undefined` is the roster read that has not answered yet. */
let roster: { id: string; userId: string }[] | undefined;

beforeEach(() => {
  teams = [TEAM];
  roster = [
    { id: "tm_1", userId: "u1" },
    { id: "tm_2", userId: "u2" },
  ];
  refused.current = new Set();
  removeTeam.mockReset();
  removeTeam.mockResolvedValue({ success: true });
});

afterEach(cleanup);

describe("TeamsCard", () => {
  it("does not delete a team on the first click", () => {
    render(<TeamsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Nothing was sent on the way to asking.
    expect(removeTeam).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("names the team and counts who goes with it", () => {
    render(<TeamsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Delete Platform?");
    expect(dialog.textContent).toMatch(/its 2 members are deleted together/i);
  });

  it("says nothing goes with an empty team", () => {
    roster = [];
    render(<TeamsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("dialog").textContent).toMatch(
      /Nobody is in it, so nothing else goes with it/i,
    );
  });

  it("refuses to imply an empty team while the roster is unread", () => {
    roster = undefined;
    render(<TeamsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/could not count who is in it/i);
    expect(dialog.textContent).not.toMatch(/Nobody is in it/i);
  });

  it("deletes it once the confirmation is the thing that was pressed", async () => {
    render(<TeamsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete the team" }));

    await waitFor(() => expect(removeTeam).toHaveBeenCalledWith("team_1"));
    expect(removeTeam).toHaveBeenCalledTimes(1);
  });

  // Create a team, Rename and Delete were live for the member and
  // refused only on submit.
  it("turns Create a team, Rename and Delete off, with the reason, for a role without team statements", () => {
    refused.current = new Set(["team:create", "team:update", "team:delete"]);
    render(<TeamsCard />);

    for (const name of ["Create a team", "Rename", "Delete"]) {
      const control = screen.getByRole("button", { name });
      expect(control.getAttribute("aria-disabled"), name).toBe("true");
      expect(control.getAttribute("title"), name).toMatch(/^Your role/);
    }
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
