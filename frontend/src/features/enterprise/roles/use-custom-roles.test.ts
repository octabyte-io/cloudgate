import { describe, expect, it } from "vitest";

import type {
  PermissionStatements,
  RolePermissions,
  RoleVocabulary,
} from "@/lib/api/endpoints/roles";

import { countGrants, pruneEmpty } from "./use-custom-roles";

/**
 * What has to stay true of the roles editor when a statement is deleted from
 * the backend's vocabulary.
 *
 * `pruneEmpty`'s `statements` filter was shipped for exactly this with a note
 * that the next deletion should *check* rather than assume it. Then came
 * that deletion — `api`, `envVars` and `logs`, three statements every role
 * granted and nothing consulted — so this is the check, and it is worth having
 * as a test rather than a reading because the regression it guards is silent
 * from every direction: a role whose stored `permission` JSON carries a retired
 * key is submitted with that key by a form that never rendered it, and
 * `validatePermissions` refuses the whole save with `Unknown resource: logs`.
 * The operator sees a role they cannot edit and no field to blame.
 *
 * ## `STATIC_ROLE_PERMISSIONS` had a `describe` here and its subject is gone
 *
 * Serving the vocabulary from the backend deleted that object and
 * `ENTERPRISE_ONLY_RESOURCES` with it. They used to be pinned against a
 * hand-written vocabulary because they were transcriptions of backend source
 * with no route behind them; the backend serves them now, off the very
 * `ac.newRole` results `PermissionService.checkPermission` authorizes against,
 * so there is no second copy left for a console-side test to compare. **The
 * property did not disappear, it moved to where the two things being compared
 * actually live**: `test/enterprise/custom-roles/custom-role.e2e-spec.ts`
 * asserts by identity (`toBe`) that the response hands out the enforced objects
 * and that no retired statement appears in any of its four fields, which is a
 * stronger claim than the hand-written comparison could make.
 *
 * What that left on *this* side is a new seam, and it is the last test below:
 * `pruneEmpty` takes the vocabulary's `statements` field and not the vocabulary,
 * and the two are now easy to confuse at the call site in `RoleBuilderModal`.
 * Handing it the wrapper would make every declared resource read as undeclared
 * and silently strip a role's whole grant map on save — the same class of
 * invisible loss the filter was written against, in the shape the fix introduced.
 *
 * The other half moved to `use-permission.test.ts`: a static role whose grants
 * have not arrived yet must fail *open*, because an unread grant map and an
 * empty one are the same shape and answering "not allowed" from the first is
 * the same failure in a new place (§3.5, "a refusal is not an empty list").
 */

/**
 * The vocabulary `GET /custom-roles/statements` serves, written out here rather
 * than derived from anything this module also reads.
 *
 * Hand-written on purpose (§1.7): the expected answer is "the retired keys are
 * not in the vocabulary", so computing the vocabulary from anything under test
 * would be recomputing it the way the code does. It is a fixture for a pure
 * function, not a copy of backend source — nothing in the app reads it, and
 * whether it matches the real catalogue is the backend e2e's question.
 */
const STATEMENTS: PermissionStatements = {
  organization: ["update", "delete"],
  member: ["read", "create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
  project: ["create", "update", "delete"],
  service: ["create", "read", "update", "delete"],
  environment: ["create", "read", "update", "delete"],
  docker: ["read", "write"],
  sshKeys: ["read", "create", "delete"],
  gitProviders: ["read", "create", "delete"],
  traefikFiles: ["read", "write"],
  volume: ["read", "create", "delete"],
  deployment: ["read", "create", "cancel"],
  server: ["read", "create", "delete"],
  registry: ["read", "create", "delete"],
  certificate: ["read", "create", "update", "delete"],
  backup: ["read", "create", "update", "delete", "restore"],
  volumeBackup: ["read", "create", "update", "delete", "restore"],
  schedule: ["read", "create", "update", "delete"],
  domain: ["read", "create", "delete"],
  destination: ["read", "create", "delete"],
  notification: ["read", "create", "update", "delete"],
  tag: ["read", "create", "update", "delete"],
  monitoring: ["read"],
  auditLog: ["read"],
};

/** The three retired last, and the two retired before them. */
const RETIRED = [
  "api",
  "envVars",
  "logs",
  "projectEnvVars",
  "environmentEnvVars",
];

describe("pruneEmpty", () => {
  it("declares none of the retired statements in the vocabulary it is given", () => {
    expect(RETIRED.filter((resource) => resource in STATEMENTS)).toEqual([]);
  });

  /**
   * The regression itself, in the shape the operator meets it: a role saved
   * while `logs` was a statement, opened in the builder, saved again unchanged.
   * `RoleBuilderModal` seeds its state from `role.permissions` — the stored JSON
   * verbatim — and `PermissionGrid` renders only the subjects `statements`
   * reports, so `logs` is on the way out of the form without ever having been on
   * screen. What has to come back out of `pruneEmpty` is a map
   * `validatePermissions` accepts, which means every key is a declared
   * statement.
   */
  it("drops a stored grant whose statement the vocabulary no longer declares", () => {
    const stored: RolePermissions = {
      service: ["read", "update"],
      deployment: ["read", "create"],
      logs: ["read"],
      envVars: ["read", "write"],
      api: ["read"],
    };

    const cleaned = pruneEmpty(stored, STATEMENTS);

    expect(cleaned).toEqual({
      service: ["read", "update"],
      deployment: ["read", "create"],
    });
    expect(
      Object.keys(cleaned).filter((resource) => !(resource in STATEMENTS)),
    ).toEqual([]);
  });

  /**
   * The half that is not about retired statements and is why the function
   * exists at all: `PermissionGrid` writes `{...value, [resource]: []}` when
   * the last action of a resource is unticked, so a map edited down to nothing
   * is a map full of empty arrays rather than an empty map. Asserted alongside
   * the deletion because the same call does both, and a fix to one that broke
   * the other would otherwise be invisible.
   */
  it("drops a resource edited down to no actions, and keeps the count honest", () => {
    const edited: RolePermissions = {
      service: ["read"],
      domain: [],
      backup: [],
    };

    expect(pruneEmpty(edited, STATEMENTS)).toEqual({ service: ["read"] });
    expect(countGrants(pruneEmpty(edited, STATEMENTS))).toBe(1);
  });

  /**
   * A retired key survives when no vocabulary is supplied, which is the
   * documented contract (`statements` is optional) and the reason the builder
   * passes it. Pinned so that making the parameter required — or defaulting it
   * — is a decision somebody takes rather than a silent change of behaviour on
   * the callers that omit it.
   */
  it("keeps an undeclared resource when it is given no vocabulary to check against", () => {
    expect(pruneEmpty({ logs: ["read"] })).toEqual({ logs: ["read"] });
  });

  /**
   * The seam serving the vocabulary created: the builder now holds a whole
   * {@link RoleVocabulary} and has to hand this function the `statements` field
   * out of it. The wrapper has four keys, none of which is a resource name, so
   * passing it would make every declared grant read as retired and strip the
   * role's map on save — a silent total loss, and the failure this asserts
   * against by pinning that the field is what works.
   */
  it("keeps a role's grants when it is given the statements field of a served vocabulary", () => {
    const served: RoleVocabulary = {
      statements: STATEMENTS,
      staticRoles: { member: { service: ["read", "update"] } },
      enterpriseOnlyResources: ["auditLog", "server"],
      internalResources: ["organization", "invitation", "team", "ac"],
    };
    const stored: RolePermissions = {
      service: ["read", "update"],
      auditLog: ["read"],
      logs: ["read"],
    };

    expect(pruneEmpty(stored, served.statements)).toEqual({
      service: ["read", "update"],
      auditLog: ["read"],
    });
    // And the wrapper is not interchangeable with the field, which is the
    // mistake worth being loud about: nothing survives it.
    expect(
      pruneEmpty(stored, served as unknown as PermissionStatements),
    ).toEqual({});
  });

  /**
   * The other way a stored grant makes a role unsaveable, and it is not a
   * retired one.
   *
   * `organization`, `invitation`, `team` and `ac` are declared statements, so
   * the `statements` filter above keeps them — and `validatePermissions`
   * refuses them ahead of everything else, with `Resource "team" is managed
   * internally and cannot be assigned to custom roles`. So a role whose stored
   * map carries one is submitted with it by a form whose checkboxes for that
   * row are disabled, and the save is refused over a control the operator could
   * not have touched: the retired-statement failure exactly, in the one shape
   * its filter cannot catch.
   *
   * It is the same population the backend's internal-grants report covers — no
   * row carrying one came through the API, so it came from a migration or a
   * hand-run `UPDATE` — and `PermissionService.resolveRole`'s line for it says
   * re-saving the role clears it, which is only true with this filter in place.
   */
  it("drops a stored grant of a resource the vocabulary says Cloudgate manages", () => {
    const internal = ["organization", "invitation", "team", "ac"];
    const stored: RolePermissions = {
      service: ["read", "update"],
      team: ["read"],
      ac: ["read"],
    };

    expect(pruneEmpty(stored, STATEMENTS, internal)).toEqual({
      service: ["read", "update"],
    });
    // The row is declared, which is why the `statements` filter alone leaves it
    // behind — the assertion that makes the case above a real one rather than a
    // second spelling of the retired-statement one.
    expect(Object.keys(stored).filter((r) => !(r in STATEMENTS))).toEqual([]);
  });

  /**
   * Omitting the list leaves such a grant alone, on the same terms as the
   * `statements` parameter two cases up: both are optional, the builder is the
   * only caller and it passes both, and this pins that making either required
   * is a decision somebody takes rather than a silent change.
   */
  it("keeps a managed resource when it is given no managed list to check against", () => {
    expect(pruneEmpty({ team: ["read"] }, STATEMENTS)).toEqual({
      team: ["read"],
    });
  });
});
