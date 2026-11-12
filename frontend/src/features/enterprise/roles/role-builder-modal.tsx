import { useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type {
  CustomRole,
  RolePermissions,
  RoleVocabulary,
} from "@/lib/api/endpoints/roles";
import { PermissionGrid } from "@/features/members/permission-grid";

import {
  countGrants,
  pruneEmpty,
  useCreateCustomRole,
  useUpdateCustomRole,
} from "./use-custom-roles";

/**
 * Build a role, or change one.
 *
 * **The grid is F16's, unchanged.** Its `onChange` was in the signature from the
 * day it was written, with a comment saying F18 would add a call site and not a
 * component — this is that call site. So the builder offers exactly the
 * subject/action pairs `GET /custom-roles/statements` reports, which is
 * `rbac/access-control.ts` served verbatim: a resource added to the backend
 * appears here on the next deploy, and a resource that has moved cannot be
 * granted by accident.
 *
 * `explainBypass` is **off** here, and that is the one difference from the
 * read-only rendering. Those annotations say "not checked for the built-in
 * roles" — true, and irrelevant while you are building a custom one, where every
 * tick is checked. The internal-resource rows stay disabled and keep saying why,
 * because that annotation is about *this* form.
 *
 * ## Renaming moves people, and the dialog says so before it does it
 *
 * `member.role` holds the role **name**, so `PATCH /custom-roles/:roleName` with
 * a `newRoleName` rewrites every member row holding it in the same request.
 * That is the right behaviour — the alternative leaves people pointing at a name
 * no row carries, which resolves to no role at all — but it is a bigger change
 * than "rename" usually implies, so the field says it when there are members.
 *
 * ## Four refusals, and all of them land on a field
 *
 * A reserved name (`owner`/`admin`/`member`) is refused by `roleNameSchema`
 * itself and arrives as a 400 issue on `roleName`; a duplicate is a 409; a
 * tenth role is a 400. `useApiForm` would route the first of those and not the
 * other two, which is why this dialog holds its own refusal state and puts
 * everything in one place — the dialog stays open with the message beside the
 * control that caused it, which is `DeleteResourceModal`'s rule.
 */
export function RoleBuilderModal({
  vocabulary,
  role,
  onClose,
}: {
  vocabulary: RoleVocabulary;
  /** Absent when creating. */
  role?: CustomRole;
  onClose: () => void;
}) {
  const create = useCreateCustomRole();
  const update = useUpdateCustomRole();

  const [name, setName] = useState(role?.role ?? "");
  const [permissions, setPermissions] = useState<RolePermissions>(
    role?.permissions ?? {},
  );
  const [refusal, setRefusal] = useState<string | null>(null);

  const pending = create.isPending || update.isPending;
  const granted = countGrants(permissions);
  const trimmed = name.trim();
  const renaming = !!role && trimmed !== role.role;

  async function submit(event: React.SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    setRefusal(null);

    if (!trimmed) {
      setRefusal("A role needs a name.");
      return;
    }

    try {
      // The third argument is the one stored key `statements` cannot filter:
      // an internal resource is declared, so it survives that filter and is
      // then the first thing `validatePermissions` refuses.
      const cleaned = pruneEmpty(
        permissions,
        vocabulary.statements,
        vocabulary.internalResources,
      );
      if (role) {
        await update.mutateAsync({
          roleName: role.role,
          newRoleName: renaming ? trimmed : undefined,
          permissions: cleaned,
        });
        toast.done(
          renaming
            ? `${role.role} is now called ${trimmed}.`
            : `${trimmed} updated.`,
        );
      } else {
        await create.mutateAsync({ roleName: trimmed, permissions: cleaned });
        toast.done(`${trimmed} created.`);
      }
      onClose();
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open wide onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={role ? `Edit ${role.role}` : "Create a role"}
        description="Every subject and action below comes from the same permission table the backend's guards check."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body className="grid gap-4">
          <Field
            name="roleName"
            label="Name"
            hint={
              renaming && role && role.memberCount > 0
                ? `Renaming also moves the ${role.memberCount} ${role.memberCount === 1 ? "member" : "members"} holding it — the name is what a member row stores.`
                : "Lower case, no spaces. owner, admin and member are reserved."
            }
          >
            <Input
              value={name}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-ui font-medium text-tx">What it allows</p>
              <p className="text-meta text-tx-2">
                <strong className="num font-semibold text-tx">{granted}</strong>{" "}
                {granted === 1 ? "grant" : "grants"}
              </p>
            </div>
            <p className="text-meta text-tx-2">
              A role with no grants is allowed nothing. Members holding it keep
              their membership and can read nothing that is checked.
            </p>
            <div className="max-h-96 overflow-y-auto rounded-lg border border-line px-3.5">
              <PermissionGrid
                vocabulary={vocabulary}
                value={permissions}
                onChange={setPermissions}
                explainBypass={false}
              />
            </div>
          </div>

          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="pri"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {role ? "Save changes" : "Create the role"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
