import type {
  RolePermissions,
  RoleVocabulary,
} from "@/lib/api/endpoints/roles";

/**
 * One sentence for what a built-in role may do, for the one dialog with room
 * for a sentence and not for the grid.
 *
 * **What broke first: the invite dialog described Admin whichever role was
 * chosen.** The hint was a literal on the Role `Field` — `"Admin can do
 * everything except delete this Organization."` — so the default, Member, was
 * offered a description of the role it is not, and nothing about the one it is.
 *
 * ## Why the sentence is checked rather than just written
 *
 * `RolesCard` and `RolePreview` answer this question properly, from
 * `GET /custom-roles/statements` — the grant maps `PermissionService` itself
 * authorizes against — and neither can go stale. A sentence can, and
 * this is what that costs: `STATIC_ROLE_PERMISSIONS` was a hand-kept
 * transcription of those same roles, it drifted in both directions, and the
 * drift was invisible because nothing compared the copy to the original.
 *
 * So the gloss is **not** a second copy of the grants. It is a sentence plus the
 * claims it makes, and it is shown only while the served vocabulary agrees with
 * every one of them. Change `memberRole` so a member can no longer update a
 * Service and this stops asserting that they can, falling back to pointing at
 * the card that renders the real answer — rather than going on saying something
 * that was true two releases ago. The rendered grid stays the authority; this is
 * a one-line reading of it that cannot outlive it.
 *
 * Owner has no gloss because no screen offers it: the role is non-delegable, so
 * `inviteMemberSchema` refuses it and `roleOptions` never lists it. A role
 * reaching here without a gloss — owner, or a custom role, which the invite
 * picker offers — gets the pointer, which is true of every role.
 */
interface RoleGloss {
  sentence: string;
  /**
   * Whether the served vocabulary still supports the sentence. Reads the grant
   * map it is describing, and — for a claim about *everything* — the other
   * built-in roles beside it.
   */
  holds: (grants: RolePermissions, vocabulary: RoleVocabulary) => boolean;
}

/** Does this grant map carry that action on that resource? */
function granted(
  grants: RolePermissions,
  resource: string,
  action: string,
): boolean {
  return (grants[resource] ?? []).includes(action);
}

/**
 * The `resource:action` pairs `full` holds and `have` does not, sorted so the
 * result is comparable.
 */
function shortfall(full: RolePermissions, have: RolePermissions): string[] {
  return Object.entries(full)
    .flatMap(([resource, actions]) =>
      actions
        .filter((action) => !granted(have, resource, action))
        .map((action) => `${resource}:${action}`),
    )
    .sort();
}

const GLOSSES: Record<string, RoleGloss> = {
  member: {
    sentence:
      "Member can read and update the Services and Environments they are granted, and cannot create or delete a Project.",
    holds: (grants) =>
      granted(grants, "service", "read") &&
      granted(grants, "service", "update") &&
      granted(grants, "environment", "read") &&
      granted(grants, "environment", "update") &&
      !granted(grants, "project", "create") &&
      !granted(grants, "project", "delete"),
  },
  admin: {
    sentence: "Admin can do everything except delete this Organization.",
    /**
     * "Everything" measured against owner rather than against `statements`:
     * owner is the built-in maximum and is served in the same response, so the
     * comparison is exact, whereas a statement no built-in role holds would
     * make the sentence read as false when it is not.
     */
    holds: (grants, vocabulary) => {
      const owner = vocabulary.staticRoles.owner;
      if (!owner) return false;
      const missing = shortfall(owner, grants);
      return missing.length === 1 && missing[0] === "organization:delete";
    },
  },
};

/**
 * The hint under a role picker: the gloss while it is still true, and otherwise
 * the card that is always true.
 *
 * `vocabulary` is `undefined` while the read is in flight or has failed, and
 * both answer the same way here — this is a hint on a form, not a terminal
 * state, so there is nothing to blame anybody for and the pointer is useful in
 * either case.
 */
export function roleHint(
  role: string,
  vocabulary: RoleVocabulary | undefined,
): string {
  const gloss = GLOSSES[role];
  const grants = vocabulary?.staticRoles[role];

  if (gloss && vocabulary && grants && gloss.holds(grants, vocabulary)) {
    return gloss.sentence;
  }
  return `What each role can do, on this screen, lists every permission ${role} holds.`;
}
