import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AllowanceSource } from "@/lib/api/endpoints/billing";
import type { CustomRole, RoleVocabulary } from "@/lib/api/endpoints/roles";

const state = vi.hoisted(() => ({
  licensed: false,
  plan: "starter" as AllowanceSource | null,
  roles: [] as unknown[],
  scheduledAt: null as string | null,
}));
const remove = vi.hoisted(() => vi.fn());

const keepBusiness = vi.hoisted(() => vi.fn());

/** `usePermission`'s verdict: held unless a case takes it away. */
const permitted = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: permitted.current, pending: false }),
}));

const query = (data: unknown) => ({ data, isPending: false, error: null });

const VOCABULARY: RoleVocabulary = {
  statements: { service: ["read", "update"] },
  staticRoles: { member: { service: ["read"] }, admin: { service: ["read"] } },
  enterpriseOnlyResources: [],
  internalResources: [],
};

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "hosted", isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus: () =>
    query({ licensed: state.licensed, status: "inactive", validUntil: null }),
}));
vi.mock("@/lib/api/use-organizations", () => ({
  useOrganizations: () =>
    query([{ id: "org-1", name: "Northwind Labs", member: { role: "owner" } }]),
}));
vi.mock("@/lib/api/use-billing", () => ({
  usePlan: () => query({ plan: state.plan, scheduledAt: state.scheduledAt }),
  useTrialOpen: () => false,
  useSubscription: () => query({ status: "active", trial: null }),
  useKeepBusiness: () => ({ isPending: false, mutateAsync: keepBusiness }),
}));
vi.mock("@/components/console/upgrade-confirm", () => ({
  UpgradeConfirm: () => null,
}));
vi.mock("@/lib/api/use-role-vocabulary", () => ({
  useRoleVocabulary: () => query(VOCABULARY),
}));
vi.mock("@/features/members/use-members", () => ({
  useCustomRoles: () => query(state.roles),
}));
vi.mock("@/lib/api/use-member-grants", () => ({
  useUpdateMemberRole: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("./use-custom-roles", async (original) => ({
  ...(await original<typeof import("./use-custom-roles")>()),
  useCustomRoles: () => query(state.roles),
  useDeleteCustomRole: () => ({ isPending: false, mutateAsync: remove }),
  useRoleMembers: () =>
    query([
      {
        id: "m1",
        userId: "u1",
        email: "priya@northwind.dev",
        firstName: "Priya",
        lastName: "Shah",
      },
    ]),
}));

const { RolesSection } = await import("./roles-section");

const role = (name: string, memberCount: number): CustomRole => ({
  role: name,
  permissions: { service: ["read"] },
  memberCount,
  createdAt: "2026-10-01T00:00:00.000Z",
  ids: [`${name}-id`],
});

afterEach(() => {
  cleanup();
  remove.mockReset();
  Object.assign(state, {
    licensed: false,
    plan: "starter",
    roles: [],
    scheduledAt: null,
  });
  keepBusiness.mockReset();
});

const disabled = (button: HTMLElement) =>
  button.getAttribute("aria-disabled") === "true";

/** Custom roles below Business, kept but stopped or never set up. */
describe("RolesSection below Business", () => {
  it("shows kept roles as allowing nothing, with Change their role beside the people", () => {
    state.roles = [role("deployer", 1), role("auditor", 0)];
    render(<RolesSection />);

    expect(screen.getByRole("status").textContent).toContain(
      "Custom roles allow nothing right now. This Organization is on Starter. The settings below are kept and work again on Business.",
    );
    expect(screen.getAllByText("Allows nothing on Starter")).toHaveLength(2);
    expect(
      disabled(screen.getByRole("button", { name: "Create a role" })),
    ).toBe(true);
    for (const edit of screen.getAllByRole("button", { name: "Edit" })) {
      expect(disabled(edit)).toBe(true);
    }
    // The role nobody holds can go; the held one is the data rule's, not the plan's.
    const [held, free] = screen.getAllByRole("button", { name: "Delete" });
    expect(disabled(held)).toBe(true);
    expect(disabled(free)).toBe(false);
    expect(
      screen.getByText(
        "This person can sign in but can't do anything until you give them a built-in role.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Change their role/ }));
    const roster = screen.getByRole("dialog");
    fireEvent.click(
      within(roster).getByRole("button", { name: /^Change their role/ }),
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "Change Priya Shah's role",
    );
  });

  it("keeps Change their role off, with why, for a role that cannot change one", () => {
    state.roles = [role("deployer", 1)];
    permitted.current = false;
    try {
      render(<RolesSection />);

      const change = screen.getByRole("button", { name: /^Change their role/ });
      expect(disabled(change)).toBe(true);
      expect(change.getAttribute("title")).toContain(
        "Your role in this Organization cannot change someone's role.",
      );
      fireEvent.click(change);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      permitted.current = true;
    }
  });

  it("deletes a kept role nobody holds", () => {
    state.roles = [role("auditor", 0)];
    render(<RolesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows only the panel when no role was ever defined", () => {
    render(<RolesSection />);

    expect(
      screen.getByText("Custom roles come with the Business plan."),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows neither strip nor chip once on Business", () => {
    state.licensed = true;
    state.plan = "business";
    state.roles = [role("deployer", 1)];
    render(<RolesSection />);

    expect(screen.queryByText(/Allows nothing/)).toBeNull();
    expect(screen.queryByText(/kept and work again/)).toBeNull();
    expect(disabled(screen.getByRole("button", { name: "Edit" }))).toBe(false);
  });
});

/** While a downgrade waits, on Business, the page says when. */
describe("RolesSection while a downgrade waits", () => {
  it("says from when custom roles allow nothing, only while it waits", () => {
    state.licensed = true;
    state.plan = "business";
    state.roles = [role("deployer", 1)];
    state.scheduledAt = "2026-12-01T12:00:00.000Z";
    const { unmount } = render(<RolesSection />);

    expect(
      screen.getByText(/Custom roles stop allowing anything on/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep Business" })).toBeTruthy();

    unmount();
    state.scheduledAt = null;
    render(<RolesSection />);
    expect(
      screen.queryByText(/Custom roles stop allowing anything/),
    ).toBeNull();
  });
});
