import { STATIC_ROLES } from "@/lib/api/endpoints/roles";

/**
 * What a licence has to do with a role, in the three states that are different.
 *
 * All three exist because
 * `PermissionService.resolveRole` cannot resolve a non-static role without a valid
 * licence, so a member holding one is refused **every** permission-checked action —
 * including the ones their role grants, not only the licensed ones.
 *
 * - **Locked out** — they already hold a custom role on an unlicensed instance. The
 *   sharpest of the three, and the only one that names a way out.
 * - **Not on offer** — unlicensed, holding a built-in role. Assigning a custom one
 *   is refused, so it is withheld rather than offered and then refused.
 * - **Unconfirmed** — the licence read has not landed or failed. It states the
 *   *condition* rather than a verdict, because `licensed === undefined` is not a
 *   fact about the Organization.
 */
export function RoleLicenceNotices({
  licensed,
  memberRole,
  chosenRole,
  name,
  customCount,
}: {
  /** `undefined` while the licence read is in flight or has failed. */
  licensed: boolean | undefined;
  /**
   * The role they hold now — absent in **Invite someone**, where nobody holds
   * anything yet.
   */
  memberRole?: string;
  /** The role selected in the picker. */
  chosenRole: string;
  /** Who the role is for, as the sentences name them. */
  name: string;
  /** How many custom roles this Organization has defined. */
  customCount: number;
}) {
  const heldRoleIsCustom =
    memberRole !== undefined && !STATIC_ROLES.includes(memberRole);

  if (licensed === false && heldRoleIsCustom) {
    return (
      <div className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
        <p className="font-medium">
          {name} is locked out by {memberRole}
        </p>
        <p className="mt-1">
          Cloudgate can only resolve a custom role while the Organization holds a
          valid enterprise license, and this one does not. Until that changes,{" "}
          {name} is refused <strong className="font-medium">every</strong>{" "}
          permission-checked action — including the ones{" "}
          <strong className="font-medium">{memberRole}</strong> grants, not only the
          licensed ones. Move them to Admin or Member to give them a role that
          works, or activate a license to make {memberRole} resolve again.
        </p>
      </div>
    );
  }

  if (licensed === false && customCount > 0) {
    return (
      <div className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-body text-tx">
        <p className="font-medium">
          Custom roles need a license before they can be assigned
        </p>
        <p className="mt-1">
          Without a valid enterprise license Cloudgate cannot resolve a custom role,
          so the ones this Organization has defined are not on offer here —
          assigning one is refused rather than leaving {name} unable to do anything
          at all. Admin and Member always work.
        </p>
      </div>
    );
  }

  if (licensed === undefined && !STATIC_ROLES.includes(chosenRole)) {
    return (
      <div className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-body text-tx">
        <p className="font-medium">
          A custom role only works on a licensed instance
        </p>
        <p className="mt-1">
          Cloudgate has not confirmed this Organization&rsquo;s license, so this
          states the condition rather than a verdict:{" "}
          <strong className="font-medium">{chosenRole}</strong> only resolves while a
          valid enterprise license is active, and without one assigning it is refused.
          Admin and Member always work.
        </p>
      </div>
    );
  }

  return null;
}
