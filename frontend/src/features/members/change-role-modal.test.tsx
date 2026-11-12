import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberWithUser } from "@/lib/api/endpoints/organizations";
import type { RoleVocabulary } from "@/lib/api/endpoints/roles";

/** What `useRoleVocabulary` answers this render. Set per case. */
let vocabulary: {
  data: RoleVocabulary | undefined;
  isPending: boolean;
  error: unknown;
};

vi.mock("@/lib/api/use-role-vocabulary", () => ({
  useRoleVocabulary: () => vocabulary,
}));

vi.mock("./use-members", () => ({
  useCustomRoles: () => ({ data: [], isPending: false, error: null }),
}));

vi.mock("@/lib/api/use-member-grants", () => ({
  useUpdateMemberRole: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus: () => ({ data: { licensed: true }, isPending: false }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { ChangeRoleModal } = await import("./change-role-modal");

/**
 * That the dialog hands `RolePreview` the state it needs to tell a read in
 * flight from a read that failed.
 *
 * `role-preview.test.tsx` pins the three renders of the panel itself. This pins
 * the wiring, which is the half the issue is actually about — the component had
 * no pending signal to render from, and giving it one that is never `true` would
 * leave the defect exactly where it was while every test in that file passed.
 */

const VOCABULARY: RoleVocabulary = {
  statements: { service: ["read", "update"], auditLog: ["read"] },
  staticRoles: { member: { service: ["read"] }, admin: { service: ["read"] } },
  enterpriseOnlyResources: ["auditLog"],
  internalResources: [],
};

const member = {
  id: "m1",
  role: "member",
  userId: "u1",
  organizationId: "org_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
} as unknown as MemberWithUser;

const REFUSAL = /could not read the permission table/i;

beforeEach(() => {
  vocabulary = { data: VOCABULARY, isPending: false, error: null };
});

afterEach(cleanup);

describe("ChangeRoleModal", () => {
  it("waits rather than blaming the read while the vocabulary is in flight", () => {
    vocabulary = { data: undefined, isPending: true, error: null };

    const { baseElement } = render(
      <ChangeRoleModal member={member} open onOpenChange={vi.fn()} />,
    );

    expect(baseElement.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });

  it("blames the read once it has finished with nothing", () => {
    vocabulary = {
      data: undefined,
      isPending: false,
      error: new Error("nope"),
    };

    const { baseElement } = render(
      <ChangeRoleModal member={member} open onOpenChange={vi.fn()} />,
    );

    expect(screen.getByText(REFUSAL)).toBeDefined();
    expect(
      baseElement.querySelectorAll('[data-slot="skeleton"]'),
    ).toHaveLength(0);
  });

  it("describes the role once the vocabulary has arrived", () => {
    render(<ChangeRoleModal member={member} open onOpenChange={vi.fn()} />);

    expect(screen.getByText("Audit log")).toBeDefined();
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });
});
