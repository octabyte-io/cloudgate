// No `"use client"` here, which is the rule across `src` rather than
// this file's exception: the 93 files that still carry the directive are the
// ones a Server Component imports, and nothing else does.
//
// `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`:
// the directive "declares an entry point" and is only needed on "the files whose
// components you want to render directly within Server Components" — and the
// props of a component in such a file "must be serializable". This dialog's only
// importer is `members-card.tsx`, which is itself a client entry point, so this
// file is not a boundary; the hooks below still run on the client because they
// are inside that entry point's module graph.
//
// Keeping the directive made `onOpenChange` a serializability error (71007), and
// the fix it suggests — renaming to `onOpenChangeAction` — would be wrong twice
// over: it is not a Server Action, and the name would claim a callback into
// `members-card.tsx` crosses the network.

import { useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { useLicenseStatus } from "@/features/enterprise/use-license";
import { errorMessage } from "@/lib/api/error-message";
import type { MemberWithUser } from "@/lib/api/endpoints/organizations";
import { type RolePermissions } from "@/lib/api/endpoints/roles";
import { useUpdateMemberRole } from "@/lib/api/use-member-grants";
import { useRoleVocabulary } from "@/lib/api/use-role-vocabulary";
import { personName } from "@/lib/format/person";

import { useCustomRoles } from "./use-members";
import { RoleLicenceNotices } from "./role-licence-notices";
import { roleOptions } from "./role-options";
import { RolePreview } from "./role-preview";

/**
 * Change what somebody is allowed to do — with what the new role means on the
 * same screen as the choice.
 *
 * **That grid is the whole reason this is a dialog and not a picker in the row.**
 * Committing per-selection is the pattern F08 chose for tags, and it is right
 * there because a tag is a label you can take off again in one click. A role is
 * the answer to "can this person delete the production Environment", and the
 * word in the picker does not say. Showing the grants beside the choice turns a
 * decision made from a label into one made from the rules.
 *
 * ## Custom roles are offered only when a licence can resolve them
 *
 * `updateMemberRole` now asks for the same valid enterprise licence
 * `CustomRolesService.ensureEnterprise` asks for, and refuses the assignment
 * without one. It
 * has to: `PermissionService.resolveRole` cannot resolve a custom role
 * unlicensed, so the old accepted-then-unresolvable assignment did not *narrow*
 * what somebody could do, it refused them every `@RequirePermission` route
 * including the ones the role explicitly grants.
 *
 * So an unlicensed Organization's custom roles are not on offer here — the same
 * rule that keeps `owner` out of the picker, and stated in the file already: the
 * route refuses it in both directions ("The owner role is nontransferable"), so
 * offering it would be offering a guaranteed 403.
 *
 * **The one exception is the role this person already holds.** A licence lapses
 * on its own and nothing deletes the `organization_role` rows or moves anyone
 * off them, so somebody can be sitting on a custom role that stopped resolving —
 * and every guarded route now tells them the licence is what is missing rather
 * than `Invalid role`. That is the state this dialog is opened *to fix*, so the
 * role stays in the picker (otherwise it would show no option matching its own
 * value) and the block above the grid says what is happening — in the same words
 * as the banner on the Roles screen, which counts how many people are in that
 * position.
 *
 * ## Why this now reads `GET /license/status`
 *
 * F16 chose not to, and the reason was sound at the time: that route and the
 * `LicenseGate` around it were F18's, and answering "is this licensed?" from the
 * members screen would have been a second implementation of it. So the dialog
 * stated the condition on every custom-role selection instead — true either way,
 * and over-warning when the licence was fine. `useLicenseStatus` is now the one
 * shared query key every enterprise section reads, and the route now answers
 * `{ licensed, status, validUntil, features }` (a918dc3), so asking is a cache
 * hit rather than a second implementation and the dialog can say which case it
 * is in.
 *
 * `licensed` is `undefined` while that read is in flight or has failed, and that
 * is a third state rather than "unlicensed" — the picker keeps every custom role
 * and falls back to F16's sentence, because inventing "no licence" from an
 * unanswered question is how a screen ends up refusing something that works.
 */
export function ChangeRoleModal({
  member,
  open,
  onOpenChange,
}: {
  /** The member row, or the part of it this dialog reads (the Roles screen's roster). */
  member: Pick<MemberWithUser, "id" | "role" | "user">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateMemberRole();
  const vocabulary = useRoleVocabulary();
  const customRoles = useCustomRoles();
  const license = useLicenseStatus();
  const [role, setRole] = useState(member.role);
  const [refusal, setRefusal] = useState<string | null>(null);

  const custom = customRoles.data ?? [];
  /** `undefined` while the licence read is in flight or has failed. */
  const licensed = license.data?.licensed;

  const options = roleOptions({ custom, licensed, heldRole: member.role });

  const permissions: RolePermissions =
    vocabulary.data?.staticRoles[role] ??
    custom.find((entry) => entry.role === role)?.permissions ??
    {};

  const name = personName(member.user);

  // `React.SubmitEvent`, not the deprecated `React.FormEvent` — @types/react
  // marks that one "doesn't actually exist", and `onSubmit` is typed
  // `SubmitEventHandler`.
  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (update.isPending || role === member.role) return;
    setRefusal(null);
    try {
      await update.mutateAsync({ memberId: member.id, role });
      toast.done(`${name} is now ${role}.`);
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title={`Change ${name}'s role`}
        description="It takes effect on their next request — they do not have to sign in again."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <Field name="role" label="Role" manual>
            <Picker value={role} onValueChange={setRole} options={options} />
          </Field>

          <RoleLicenceNotices
            licensed={licensed}
            memberRole={member.role}
            chosenRole={role}
            name={name}
            customCount={custom.length}
          />

          {/*
            `pending` and not just `data`: an unread vocabulary and a refused
            one are the same `undefined`, and this panel used to call both a
            failure.
          */}
          <RolePreview
            role={role}
            permissions={permissions}
            vocabulary={vocabulary.data}
            pending={vocabulary.isPending}
          />

          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant="pri"
            disabled={role === member.role || update.isPending}
            aria-busy={update.isPending || undefined}
          >
            Change role
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
