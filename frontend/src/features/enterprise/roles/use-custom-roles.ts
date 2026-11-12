import { useMutation, useQuery } from "@tanstack/react-query";

import {
  rolesApi,
  type CustomRoleInput,
  type PermissionStatements,
  type RolePermissions,
} from "@/lib/api/endpoints/roles";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Organization's custom roles, and the three licensed writes.
 *
 * The **list** is F16's key (`keys.roles.list`) and is deliberately shared with
 * the Members screen's role picker rather than duplicated: they are the same
 * rows, and two keys would let one screen show a role the other has just
 * renamed.
 */
export function useCustomRoles() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.roles.list(organizationId),
    queryFn: rolesApi.list,
    enabled: organizationId !== null,
  });
}

/**
 * Who holds a role. Open to any member, like the listing.
 *
 * Fetched only when somebody asks — `GET /custom-roles/:roleName/members` is one
 * request per role, and the list already carries `memberCount`, so the roster is
 * the answer to "who exactly" and not to "how many".
 */
export function useRoleMembers(roleName: string | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.roles.members(organizationId, roleName ?? ""),
    queryFn: () => rolesApi.members(roleName as string),
    enabled: organizationId !== null && roleName !== null,
  });
}

export function useCreateCustomRole() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CustomRoleInput) => rolesApi.create(input),
    onSuccess: () => invalidate.roles(),
  });
}

export function useUpdateCustomRole() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: {
      roleName: string;
      newRoleName?: string;
      permissions: RolePermissions;
    }) =>
      rolesApi.update(input.roleName, {
        newRoleName: input.newRoleName,
        permissions: input.permissions,
      }),
    onSuccess: () => invalidate.roles(),
  });
}

export function useDeleteCustomRole() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (roleName: string) => rolesApi.remove(roleName),
    onSuccess: () => invalidate.roles(),
  });
}

/**
 * The grant map with every empty resource dropped, and every resource the
 * vocabulary no longer has.
 *
 * `PermissionGrid` writes `{...value, [resource]: []}` when the last action of a
 * resource is unticked, so a map edited down to nothing is a map full of empty
 * arrays. The backend accepts them — `validatePermissions` iterates actions and
 * an empty list has none — but they are noise on the way in and noise coming
 * back out of `GET /custom-roles`, where they would render as a resource the
 * role "has" with nothing in it.
 *
 * **`statements` is what makes a stored role editable after a statement is
 * retired.** A role saved before `projectEnvVars` and
 * `environmentEnvVars` were deleted still carries them in its `permission`
 * JSON, and the builder seeds its state from that JSON — but the grid renders
 * only the subjects `GET /custom-roles/statements` reports, so the dead key is
 * invisible on screen and submitted anyway. `validatePermissions` then refuses
 * the whole save with `Unknown resource: projectEnvVars`, and the operator has
 * no way to remove from the form a key the form never showed them.
 *
 * Dropping it here rather than loosening `validatePermissions` to ignore
 * unknown resources: that check is what catches a typo'd subject in a
 * hand-written payload, and the grant is unreachable anyway — better-auth's
 * `role.authorize` reads the role's own map only for the resources a request
 * names, so a granted key nothing asks for authorizes nothing.
 *
 * **Checked rather than assumed for the next three.** This filter shipped
 * with a note that a later deletion should verify it instead of citing it;
 * `api`, `envVars` and `logs` were then deleted, and `use-custom-roles.test.ts`
 * is the verification — a stored role carrying all three comes back out of here
 * as a map every key of which `validatePermissions` declares, so the save the
 * earlier regression refused now goes through. Nothing changed in this function
 * to make that so, which is the result worth recording: the filter is written
 * against `statements` rather than against a list of retired names, so it does
 * not need editing per deletion, and that is exactly the claim a test has to
 * carry rather than a comment.
 *
 * **`managed` is the one stored key the `statements` filter cannot catch.**
 * `organization`, `invitation`, `team` and `ac` *are* declared statements — they are
 * declared so `validatePermissions` can refuse them — and it refuses them first, with
 * `Resource "team" is managed internally and cannot be assigned to custom roles`. So
 * a role whose stored map carries one hit the same failure in the shape the filter
 * could not see: the grid renders the row with its checkboxes disabled, the key is
 * submitted anyway, and the save is refused over a control the operator was never
 * allowed to touch. Same population as the backend's internal-grants report — nothing
 * wrote such a row through the API, so it came from a migration or a hand-run
 * `UPDATE` — and `PermissionService.resolveRole`'s line for it says re-saving the
 * role clears it, which is a promise this parameter keeps.
 *
 * Both lists stay optional — `RoleBuilderModal` is the only caller and passes
 * both — and both are read off the served vocabulary rather than named here, so
 * a fifth internal resource is a backend change and a deploy, which is the
 * whole point of serving the vocabulary.
 */
export function pruneEmpty(
  permissions: RolePermissions,
  statements?: PermissionStatements,
  managed?: readonly string[],
): RolePermissions {
  return Object.fromEntries(
    Object.entries(permissions).filter(
      ([resource, actions]) =>
        actions.length > 0 &&
        (!statements || resource in statements) &&
        (!managed || !managed.includes(resource)),
    ),
  );
}

/** How many grants a role actually holds, for the list's summary. */
export function countGrants(permissions: RolePermissions): number {
  return Object.values(permissions).reduce(
    (sum, actions) => sum + actions.length,
    0,
  );
}
