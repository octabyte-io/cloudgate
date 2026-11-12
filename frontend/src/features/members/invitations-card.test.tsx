import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Invitation } from "@/lib/api/endpoints/organizations";

const removeInvitation = vi.fn();

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
  useInvitations: () => ({ data: rows, isPending: false, error: null }),
  useRemoveInvitation: () => ({
    isPending: false,
    mutateAsync: removeInvitation,
  }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { InvitationsCard } = await import("./invitations-card");

/**
 * That **Revoke asks before it deletes**.
 *
 * The first assertion of each case is the whole issue: `removeInvitation` was
 * called straight from the row's `onClick`, so one mis-aimed press destroyed an
 * invitation and the link that had already been sent for it. "The dialog is
 * there" is not enough on its own — a dialog that opens *after* the mutation
 * has gone would satisfy it — so every case pins that nothing has been sent
 * yet, and only then that the confirmation names what is about to be lost.
 */

const PENDING: Invitation = {
  id: "inv_1",
  email: "ada@example.test",
  role: "member",
  status: "pending",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
} as Invitation;

const ACCEPTED: Invitation = {
  ...PENDING,
  id: "inv_2",
  email: "mira@example.test",
  status: "accepted",
};

let rows: Invitation[];

beforeEach(() => {
  rows = [PENDING];
  removeInvitation.mockReset();
  removeInvitation.mockResolvedValue({ success: true });
});

afterEach(cleanup);

describe("InvitationsCard", () => {
  it("does not revoke an invitation on the first click", () => {
    render(<InvitationsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    // Nothing was sent on the way to asking.
    expect(removeInvitation).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("names the address and says the link stops working", () => {
    render(<InvitationsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("ada@example.test");
    expect(dialog.textContent).toMatch(/link already handed out stops working/i);
  });

  it("revokes it once the confirmation is the thing that was pressed", async () => {
    render(<InvitationsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke it" }));

    await waitFor(() => expect(removeInvitation).toHaveBeenCalledWith("inv_1"));
    expect(removeInvitation).toHaveBeenCalledTimes(1);
  });

  it("does not delete a spent invitation on the first click either", () => {
    rows = [ACCEPTED];
    render(<InvitationsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(removeInvitation).not.toHaveBeenCalled();
    // The link was already refused, so this one is about the record and says so
    // rather than warning about a link that stopped working weeks ago.
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("mira@example.test");
    expect(dialog.textContent).toMatch(/leaves this list/i);
  });
});
