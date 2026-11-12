import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomRole, RoleVocabulary } from "@/lib/api/endpoints/roles";

const update = vi.fn();
const create = vi.fn();

vi.mock("./use-custom-roles", async (importOriginal) => ({
  // `pruneEmpty` and `countGrants` stay real: what this file is about is the
  // argument the dialog hands the real one.
  ...(await importOriginal<typeof import("./use-custom-roles")>()),
  useCreateCustomRole: () => ({ isPending: false, mutateAsync: create }),
  useUpdateCustomRole: () => ({ isPending: false, mutateAsync: update }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { RoleBuilderModal } = await import("./role-builder-modal");

/**
 * That the builder hands `pruneEmpty` the served `internalResources`.
 *
 * `use-custom-roles.test.ts` pins what `pruneEmpty` does with that list. This
 * pins that it is given one — the half a unit test of the filter cannot reach,
 * and the half that decides whether the sentence
 * `PermissionService.reportInternalGrants` logs is true. That line tells the
 * operator that saving the role again clears the grant, and `update` replaces
 * the whole `permission` column, so the promise holds exactly as long as the
 * key is gone from the body. Without the third argument the save is *refused*
 * — `validatePermissions` answers 400 `Resource "team" is managed internally`
 * over a row whose checkboxes the grid renders disabled — which is the
 * retired-statement failure in the one shape that filter cannot catch.
 *
 * The stored map is seeded into state from `role.permissions`, which is why the
 * key is in the submitted body at all: nothing the operator can touch put it
 * there and nothing they can touch takes it out.
 */

const VOCABULARY: RoleVocabulary = {
  statements: {
    service: ["create", "read", "update", "delete"],
    auditLog: ["read"],
    // Declared, which is the whole point: the `statements` filter keeps it.
    team: ["create", "update", "delete"],
  },
  staticRoles: { member: { service: ["read"] } },
  enterpriseOnlyResources: ["auditLog"],
  internalResources: ["team"],
};

/** A row that did not come through the API — a migration or a hand-run UPDATE. */
const STORED: CustomRole = {
  role: "legacy-auditor",
  permissions: { service: ["read"], team: ["read"] },
  memberCount: 1,
} as unknown as CustomRole;

afterEach(() => {
  cleanup();
  update.mockReset();
  create.mockReset();
});

describe("RoleBuilderModal", () => {
  it("leaves a stored grant of a managed resource out of the body it saves", async () => {
    const { baseElement } = render(
      <RoleBuilderModal
        vocabulary={VOCABULARY}
        role={STORED}
        onClose={vi.fn()}
      />,
    );

    fireEvent.submit(baseElement.querySelector("form")!);

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toEqual({
      roleName: "legacy-auditor",
      newRoleName: undefined,
      permissions: { service: ["read"] },
    });
    // The grant the operator can actually hold is still there, so this is a
    // filter and not a truncation.
    expect(update.mock.calls[0][0].permissions.service).toEqual(["read"]);
  });

  it("saves a role that grants nothing managed exactly as it stands", async () => {
    render(
      <RoleBuilderModal
        vocabulary={VOCABULARY}
        role={
          {
            role: "auditor",
            permissions: { service: ["read"], auditLog: ["read"] },
            memberCount: 0,
          } as unknown as CustomRole
        }
        onClose={vi.fn()}
      />,
    );

    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0].permissions).toEqual({
      service: ["read"],
      auditLog: ["read"],
    });
  });
});
