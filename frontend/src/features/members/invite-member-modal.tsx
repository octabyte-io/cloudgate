import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLicenseStatus } from "@/features/enterprise/use-license";
import type { Invitation } from "@/lib/api/endpoints/organizations";
import { useRoleVocabulary } from "@/lib/api/use-role-vocabulary";

import { roleHint } from "./role-hint";
import { RoleLicenceNotices } from "./role-licence-notices";
import { roleOptions } from "./role-options";
import { useCustomRoles, useInviteMember, useTeams } from "./use-members";

/**
 * `inviteMemberSchema`'s email, in the console's words. Submit is
 * always on: an empty or malformed address is refused under Email, where the
 * button used to sit disabled and the browser's own "Please include an '@'"
 * bubble answered a malformed one.
 */
const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter the address they will sign in with.")
    .pipe(
      z
        .email("That is not an email address. It needs an @ and a domain.")
        .max(255, "An address is at most 255 characters."),
    ),
});
type Values = z.infer<typeof schema>;

/**
 * Invite somebody, and then hand you the link — because **nothing sends it**.
 *
 * `auth.config.ts` registers the organization plugin with no
 * `sendInvitationEmail`, exactly as it registers `emailAndPassword` with no
 * `sendResetPassword`.
 * The row is created, the invitation is real and `/accept-invitation/<id>`
 * works — and if this dialog closed on a toast saying "invitation sent", the
 * invitee would wait for an email that was never written. So the second state of
 * this dialog is the link, with the same "copy this now" treatment the API key
 * gets, for the same reason: it is the only place it appears.
 *
 * The backend *has* a `MailService` with SMTP and Resend senders, and `createAuth`
 * is simply never handed one.
 *
 * **The hint under Role is `roleHint`, not a sentence**
 * a literal here
 * described Admin whichever role was selected, so the default — Member — was
 * given a description of the role it is not. That module carries the rest of
 * the reasoning, including why the sentence it returns is checked against the
 * served vocabulary before it is shown.
 *
 * **Owner is not offered**, and that is the DTO rather than a design choice:
 * `inviteMemberSchema` refuses it. The owner role is non-delegable in this
 * product, so there is no combination of screens that produces a second owner.
 *
 * **The Organization's custom roles are offered, as they are in Change role**
 * from the same
 * `roleOptions` and under the same `RoleLicenceNotices`. Before, the picker
 * held Member and Admin only, so the one way onto a custom role was to join as
 * Member and be moved afterwards — holding Member's grant, restoring backups and
 * deleting volumes included, in between. The invitation now carries the custom
 * role, and accepting it creates the membership on that role. Unlicensed they
 * are withheld, and the notice says so rather than leaving the list short.
 *
 * The team picker is offered only when the Organization has teams. An empty
 * select that says "no teams" on a dialog about inviting a person is a control
 * asking a question with no answers.
 */
export function InviteMemberModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invite = useInviteMember();
  const teams = useTeams();
  const vocabulary = useRoleVocabulary();
  const customRoles = useCustomRoles();
  const license = useLicenseStatus();
  const [role, setRole] = useState("member");
  const [teamId, setTeamId] = useState("");
  const [created, setCreated] = useState<Invitation | null>(null);

  const teamRows = teams.data ?? [];
  const custom = customRoles.data ?? [];
  /** `undefined` while the licence read is in flight or has failed. */
  const licensed = license.data?.licensed;

  const form = useApiForm<Values>({
    schema,
    defaultValues: { email: "" },
    onSubmit: async ({ email }) => {
      setCreated(
        await invite.mutateAsync({
          email,
          role,
          teamId: teamId === "" ? undefined : teamId,
        }),
      );
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange} keepOpen={created !== null}>
      <Modal.Header
        title={created ? "Send them this link" : "Invite someone"}
        description={
          created
            ? "Cloudgate does not send email, so passing this on is your job."
            : "They will need an account, or they can create one from the invitation."
        }
      />

      {created ? (
        <>
          <Modal.Body>
            <div className="rounded-lg border border-warn-line bg-warn-tint p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-body font-medium text-tx">
                  The invitation for {created.email}
                </p>
                <CopyButton
                  value={invitationLink(created.id)}
                  label="invitation link"
                />
              </div>
              <p className="mt-1 text-meta text-tx-2">
                This instance has no mail sender configured, so nothing was
                sent. The link is in the pending list below if you close this
                now.
              </p>
              <code className="mt-2.5 block rounded-md bg-panel px-2.5 py-2 font-mono text-ui wrap-anywhere text-tx">
                {invitationLink(created.id)}
              </code>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Button
              type="button"
              variant="pri"
              onClick={() => onOpenChange(false)}
            >
              Done
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit}>
            <Modal.Body>
              <Field
                name="email"
                label="Email"
                hint="The address they will sign in with."
              >
                <Input type="email" autoComplete="off" />
              </Field>
              <Field
                name="role"
                label="Role"
                manual
                hint={roleHint(role, vocabulary.data)}
              >
                <Picker
                  value={role}
                  onValueChange={setRole}
                  options={roleOptions({ custom, licensed })}
                />
              </Field>
              <RoleLicenceNotices
                licensed={licensed}
                chosenRole={role}
                name="the person you invite"
                customCount={custom.length}
              />
              {teamRows.length > 0 ? (
                <Field name="team" label="Team" optional manual>
                  <Picker
                    value={teamId}
                    onValueChange={setTeamId}
                    placeholder="No team"
                    options={[
                      { value: "", label: "No team" },
                      ...teamRows.map((team) => ({
                        value: team.id,
                        label: team.name,
                      })),
                    ]}
                  />
                </Field>
              ) : null}
              <FormError message={form.rootError} />
            </Modal.Body>
            <Modal.Footer>
              <Modal.Gap />
              <Modal.Close render={<Button type="button">Cancel</Button>} />
              <SubmitButton pending={form.formState.isSubmitting}>
                Create invitation
              </SubmitButton>
            </Modal.Footer>
          </form>
        </FormProvider>
      )}
    </Modal>
  );
}

/**
 * The address an invitee opens.
 *
 * Built from `window.location.origin` rather than from a configured public URL,
 * because there is no route that reliably answers with one:
 * `webServerSettings.host` is empty until somebody uses **Assign domain**, and a
 * link built from an unset column would be `https://null/accept-invitation/…`.
 * The origin the operator is looking at is the one they reached the console on,
 * which is the best available answer and is usually the right one.
 */
export function invitationLink(invitationId: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/accept-invitation/${invitationId}`;
}
