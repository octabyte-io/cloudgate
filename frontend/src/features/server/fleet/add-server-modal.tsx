import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormProvider } from "react-hook-form";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Segmented } from "@/components/console/segmented";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import type { ServerType } from "@/lib/api/endpoints/servers";
import { useSshKeys } from "@/lib/api/use-ssh-keys";
import {
  ServerAllowanceNotice,
  useServerAllowance,
} from "@/features/billing/server-allowance-notice";

import { useCreateServer } from "../use-server";
import { AddServerFields } from "./add-server-fields";
import {
  ROLES,
  addServerSchema,
  type AddServerValues,
} from "./add-server-values";
import { SshKeyChoice, hasNoKeys } from "./ssh-key-choice";

/**
 * Add a Server.
 *
 * The row a `POST /servers` accepts is `add-server-values.ts`, and the key choice —
 * including what to do when the Organization has none — is `ssh-key-choice.tsx`.
 * The reference's "Provision a server" flow beside this one is Terraform work with
 * no backend at all, so this dialog is the only way a Server gets here.
 *
 * **Adding a Server does not touch the machine.** The row is an insert and nothing
 * else — no SSH, no validation, no setup. That is worth saying in the dialog rather
 * than discovered afterwards, because the two things that *do* touch it are the
 * next two steps and they are on the Server's own screens. So this ends by going
 * to the new Server, where Overview says what to do next.
 */
export function AddServerModal({
  open,
  onOpenChange,
  onManageKeys,
  chosenKeyId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The way out when there is no key to choose. Opens the keys dialog, which
   * hands back here when it closes (`AddServerDialogs`).
   */
  onManageKeys: () => void;
  /** A key made on the way through the keys dialog, chosen when it arrives. */
  chosenKeyId?: string | null;
}) {
  const router = useRouter();
  const create = useCreateServer();
  const sshKeys = useSshKeys(open);
  /**
   * Held beside the form rather than in it. A `Segmented` is a button, so inside a
   * form it would want a `Controller` and a `manual` Field (F03's rule) — and this
   * is a two-way choice with a real default that nothing validates, so a piece of
   * state and one line in `onSubmit` is the honest amount of machinery.
   */
  const [role, setRole] = useState<ServerType>("deploy");

  const form = useApiForm<AddServerValues>({
    schema: addServerSchema,
    defaultValues: {
      name: "",
      description: "",
      ipAddress: "",
      // The backend's own defaults, said out loud rather than left blank: a port
      // field showing nothing looks optional, and this one has an answer.
      port: 22,
      username: "root",
      sshKeyId: "",
    },
    onSubmit: async (values) => {
      const row = await create.mutateAsync({
        name: values.name,
        // An empty optional is `undefined` when creating — `createServerSchema`
        // types `description` as `.optional()` and would refuse a null (F10's rule).
        description: values.description || undefined,
        ipAddress: values.ipAddress,
        port: values.port,
        username: values.username,
        sshKeyId: values.sshKeyId,
        serverType: role,
      });
      toast.done(`Server ${row.name} added.`, {
        description: "Nothing has been done to the machine yet.",
      });
      onOpenChange(false);
      router.push(`/servers/${row.serverId}`);
    },
    onError: (error) => toast.error(error),
  });

  /**
   * **F18's line on this screen**, and the brief asks for it by name:
   * `GET /billing/can-create-server` is surfaced where a Server is created
   * rather than only on the billing page, because the moment the answer matters
   * is the moment somebody is adding one. Off cloud it is always `true`, so this
   * renders nothing on a self-hosted instance. `blocked` is only ever true when
   * the backend would really refuse — `assertRoomFor` runs inside
   * `ServersService.create`, so this prevents a refusal rather than duplicating
   * a rule.
   */
  const allowance = useServerAllowance();

  // The key made on the trip to the keys dialog, chosen for the operator: they
  // went there to make the key this Server needs.
  const { setValue } = form;
  useEffect(() => {
    if (chosenKeyId)
      setValue("sshKeyId", chosenKeyId, { shouldValidate: true });
  }, [chosenKeyId, setValue]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Add a Server"
        description="Cloudgate reaches a Server over SSH. Adding it records the machine — it does not connect to it yet."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <AddServerFields />

            <SshKeyChoice sshKeys={sshKeys} onManageKeys={onManageKeys} />

            <Field
              name="serverType"
              label="Role"
              hint="A deploy Server runs services. A build Server only builds images for other Servers."
              manual
            >
              <Segmented<ServerType>
                label="Role"
                options={ROLES}
                value={role}
                onChange={setRole}
              />
            </Field>

            <ServerAllowanceNotice className="mt-3.5" />
            {form.rootError ? <FormError message={form.rootError} /> : null}
          </Modal.Body>
          <Modal.Footer>
            <p className="min-w-0 flex-1 text-meta text-tx-3">
              Next you will check that Cloudgate can reach it, then run setup.
            </p>
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={hasNoKeys(sshKeys) || allowance.blocked}
            >
              Add Server
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
