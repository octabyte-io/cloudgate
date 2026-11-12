import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberWithUser } from "@/lib/api/endpoints/organizations";

let rows: MemberWithUser[];

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
  useMembers: () => ({
    data: { members: rows, total: rows.length },
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/lib/auth/client", () => ({
  useSession: () => ({ data: { user: { id: "u_owner" } } }),
}));

const { MembersCard } = await import("./members-card");

/**
 * That **a deactivated member does not read like an active one**.
 *
 * An identity provider's `active: false` bans the account and keeps the
 * membership, so the row stays — and it rendered identically to an active
 * member's, which made the only screen that answers "who can get in" wrong for
 * every deprovisioned account. The first case is the assertion that would have
 * failed then: the two rows differ, and the difference is a word.
 */

const base = {
  organizationId: "org_1",
  role: "member",
  createdAt: "2026-01-01T00:00:00.000Z",
  isDefault: false,
  accessedProjects: [],
  accessedEnvironments: [],
  accessedServices: [],
  deactivation: null,
};

const person = (id: string, name: string, email: string) => ({
  id,
  name,
  lastName: "",
  email,
  image: null,
});

const OWNER: MemberWithUser = {
  ...base,
  id: "m_owner",
  userId: "u_owner",
  role: "owner",
  user: person("u_owner", "Grace", "grace@example.test"),
};

const ACTIVE: MemberWithUser = {
  ...base,
  id: "m_active",
  userId: "u_active",
  user: person("u_active", "Ada", "ada@example.test"),
};

const BY_DIRECTORY: MemberWithUser = {
  ...base,
  id: "m_scim",
  userId: "u_scim",
  user: person("u_scim", "Scim", "scim@example.test"),
  deactivation: {
    byDirectory: true,
    reason: "Deactivated via SCIM",
    expiresAt: null,
  },
};

const BY_SOMEONE: MemberWithUser = {
  ...base,
  id: "m_ban",
  userId: "u_ban",
  user: person("u_ban", "Mira", "mira@example.test"),
  deactivation: {
    byDirectory: false,
    reason: "Left the company",
    expiresAt: null,
  },
};

/** An Agent, as `GET /organizations/members` answers it: its synthetic address and all. */
const AGENT: MemberWithUser = {
  ...base,
  id: "m_agent",
  userId: "k3x9q2",
  role: "agentOperator",
  user: person("k3x9q2", "deploy-bot", "k3x9q2@agents.cloudgate.invalid"),
};

const rowOf = (email: string) => screen.getByText(email).closest("tr")!;

beforeEach(() => {
  rows = [OWNER, ACTIVE, BY_DIRECTORY, BY_SOMEONE];
  refused.current = new Set();
});

afterEach(cleanup);

describe("MembersCard", () => {
  it("marks a deactivated member and leaves an active one unmarked", () => {
    render(<MembersCard />);

    expect(within(rowOf("scim@example.test")).getByText("deactivated"));
    expect(
      within(rowOf("ada@example.test")).queryByText(/deactivat/i),
    ).toBeNull();
    expect(
      within(rowOf("grace@example.test")).queryByText(/deactivat/i),
    ).toBeNull();
  });

  it("says the directory did it, and that only the directory can undo it", () => {
    render(<MembersCard />);

    const row = rowOf("scim@example.test");
    expect(
      within(row).getByText(/deactivated by your identity provider over SCIM/i)
        .textContent,
    ).toMatch(/only the directory can reactivate/i);
  });

  it("carries a ban's own reason when the directory did not write it", () => {
    render(<MembersCard />);

    const row = rowOf("mira@example.test");
    expect(within(row).getByText("deactivated"));
    expect(within(row).getByText(/Left the company/)).toBeDefined();
    expect(within(row).queryByText(/identity provider/i)).toBeNull();
  });

  // The member filled the invite form in and met the 403 on submit.
  it("turns Invite, Change role, Manage access and Remove off, with the reason, for the built-in member", () => {
    refused.current = new Set([
      "invitation:create",
      "member:update",
      "member:delete",
    ]);
    render(<MembersCard />);

    const invite = screen.getByRole("button", { name: "Invite someone" });
    expect(invite.getAttribute("aria-disabled")).toBe("true");
    expect(invite.getAttribute("title")).toMatch(
      /^Your role in this Organization cannot invite someone\./,
    );
    const row = rowOf("ada@example.test");
    for (const name of ["Change role", "Manage access", "Remove"]) {
      const control = within(row).getByRole("button", { name });
      expect(control.getAttribute("aria-disabled"), name).toBe("true");
      expect(control.getAttribute("title"), name).toMatch(/^Your role/);
    }
  });

  it("leaves them live for a role that holds their statements", () => {
    render(<MembersCard />);
    expect(
      screen
        .getByRole("button", { name: "Invite someone" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  // People and Agents do not mix, and an operator who
  // looks for an Agent here is pointed at where it lives.
  describe("Agents", () => {
    it("leaves Agents out of the table and the head count, and never renders an Agent's address", () => {
      rows = [OWNER, ACTIVE, AGENT];
      render(<MembersCard />);

      expect(screen.queryByText("deploy-bot")).toBeNull();
      expect(document.body.textContent).not.toContain(
        "agents.cloudgate.invalid",
      );
      expect(screen.getByText("2 people in this Organization.")).toBeDefined();
    });

    it("points at the Agents section with one line counting them", () => {
      const second = { ...AGENT, id: "m_agent2", userId: "a2" };
      rows = [OWNER, ACTIVE, AGENT, second];
      render(<MembersCard />);

      const pointer = screen.getByText(/2 Agents are managed in/);
      expect(pointer.textContent).toBe("2 Agents are managed in Agents.");
      expect(
        within(pointer).getByRole("link", { name: "Agents" }).getAttribute("href"),
      ).toBe("/settings/agents");
    });

    it("says nothing about Agents when there are none", () => {
      render(<MembersCard />);
      expect(screen.queryByText(/managed in/)).toBeNull();
    });

    it("offers no action that could act on an Agent", () => {
      rows = [OWNER, ACTIVE, AGENT];
      render(<MembersCard />);

      // One person row with actions (Ada); the owner row has none, and the
      // Agent has no row at all.
      expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    });
  });
});
