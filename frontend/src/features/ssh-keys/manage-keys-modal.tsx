import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Segmented } from "@/components/console/segmented";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api/error-message";
import type { SshKeyType } from "@/lib/api/endpoints/ssh-keys";
import type { Server } from "@/lib/api/endpoints/servers";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { SshKeyRow } from "./ssh-key-row";
import { useCreateSshKey, useSshKeys } from "./use-ssh-keys";
import { example } from "@/components/console/form-spec";

/**
 * The Organization's SSH keys, managed in one place.
 *
 * **It is a dialog on the fleet screen rather than a page**, and that is F08's
 * argument about Tags applied unchanged: a key here has exactly one use — reaching
 * a Server — and the route tree has no `/ssh-keys` and no rail row for one
 * (`nav.ts`, which F07 owns). Managing them where they are used also puts the key
 * list one click from the dialog that asks which key a new Server should use,
 * instead of a screen away.
 *
 * The form asks **how** before it asks for anything, because the two answers need
 * different fields. Pasting asks for both halves and marks neither optional: the
 * backend refuses a body with one half (it used to generate a fresh pair and
 * throw the paste away), and refuses a pair it cannot use — a half that is not a
 * key, a passphrase-protected private key, halves of two different pairs — with
 * a 400 naming the field. `useApiForm` puts that sentence beside the
 * textarea it is about, which is where the person has to fix it.
 */

const HOW = [
  { value: "generate" as const, label: "Generate one" },
  { value: "paste" as const, label: "Paste one I have" },
];

const TYPES = [
  { value: "ed25519" as const, label: "ed25519" },
  { value: "rsa" as const, label: "RSA 4096" },
];

const schema = z.object({
  name: z.string().trim().min(1, "A key needs a name."),
  description: z.string().trim(),
  publicKey: z.string().trim(),
  privateKey: z.string().trim(),
});
type Values = z.infer<typeof schema>;

export function ManageKeysModal({
  open,
  onOpenChange,
  onCreated,
  servers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A key was added — Add a Server chooses it when this was opened from there. */
  onCreated?: (sshKeyId: string) => void;
  /** So a delete can name the Servers it strands. See `SshKeyRow`. */
  servers: Server[];
}) {
  const [how, setHow] = useState<"generate" | "paste">("generate");
  const [type, setType] = useState<SshKeyType>("ed25519");
  const [fresh, setFresh] = useState<string | null>(null);

  const list = useSshKeys();
  const create = useCreateSshKey();
  // `POST /ssh-keys` is `sshKeys: ['create']`, which the base member does not
  // hold. The form stays readable; Add key says why it is off.
  const canCreate = usePermission({ sshKeys: ["create"] });

  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "", description: "", publicKey: "", privateKey: "" },
    onSubmit: async (values) => {
      // Enter in a field submits whatever the button says.
      if (!canCreate.allowed) {
        form.setError("root", { type: "manual", message: CREATE_REFUSAL });
        return;
      }
      // The two halves travel together or not at all — see the note above.
      const pasted =
        how === "paste"
          ? { publicKey: values.publicKey, privateKey: values.privateKey }
          : { type };

      if (how === "paste" && (!values.publicKey || !values.privateKey)) {
        form.setError(!values.publicKey ? "publicKey" : "privateKey", {
          type: "manual",
          message: "Both halves are needed.",
        });
        return;
      }

      const created = await create.mutateAsync({
        name: values.name,
        // An empty optional is `undefined` when creating — the create schema
        // types `description` as `.optional()` and refuses a null (F10's rule).
        description: values.description || undefined,
        ...pasted,
      });

      toast.done(`Key ${created.name} added.`);
      setFresh(created.sshKeyId);
      onCreated?.(created.sshKeyId);
      form.reset({ name: "", description: "", publicKey: "", privateKey: "" });
      // Back to the field, not left on the button — F08's defect, and keys are
      // added in runs of two or three the same way tags are.
      form.setFocus("name");
    },
    onError: (error) => toast.error(error),
  });

  const rows = list.data ?? [];

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="SSH keys"
        description="A key is how Cloudgate reaches a Server. Keys belong to the Organization and any Server in it can use one."
      />
      <Modal.Body>
        <FormProvider {...form}>
          <form
            method="post"
            noValidate
            onSubmit={form.submit}
            className="grid gap-3 rounded-lg border border-line bg-panel-2 p-3"
          >
            <div className="flex flex-wrap items-end gap-2">
              <Field
                name="name"
                label="Name"
                className="min-w-0 flex-[1_1_180px]"
              >
                <Input placeholder={example("production-hosts")} autoComplete="off" />
              </Field>
              <Field
                name="description"
                label="Description"
                optional
                className="min-w-0 flex-[1_1_180px]"
              >
                <Input placeholder={example("Reaches the EU hosts")} autoComplete="off" />
              </Field>
            </div>

            <Field name="how" label="Where the key comes from" manual>
              <Segmented
                label="Where the key comes from"
                options={HOW}
                value={how}
                onChange={setHow}
              />
            </Field>

            {how === "generate" ? (
              <Field
                name="type"
                label="Type"
                hint="Cloudgate makes the pair and keeps the private half. You install the public half on each Server."
                manual
              >
                <Segmented
                  label="Key type"
                  options={TYPES}
                  value={type}
                  onChange={setType}
                />
              </Field>
            ) : (
              <>
                <Field
                  name="publicKey"
                  label="Public key"
                  hint="One line, starting ssh-ed25519 or ssh-rsa."
                >
                  <Textarea rows={2} className="font-mono text-meta" />
                </Field>
                <Field
                  name="privateKey"
                  label="Private key"
                  hint="Both halves are needed. Cloudgate encrypts this at rest and uses it to dial the Server."
                >
                  <Textarea rows={4} className="font-mono text-meta" />
                </Field>
              </>
            )}

            {form.rootError ? <FormError message={form.rootError} /> : null}
            <div>
              <SubmitButton
                pending={form.formState.isSubmitting}
                disabled={!canCreate.allowed}
                title={canCreate.allowed ? undefined : CREATE_REFUSAL}
              >
                Add key
              </SubmitButton>
            </div>
          </form>
        </FormProvider>

        {list.error ? (
          <FormError message={errorMessage(list.error)} />
        ) : list.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-ctl" />
            <Skeleton className="h-ctl" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-body text-tx-2">
            Add a key above, and every Server in this Organization can use
            it.
          </p>
        ) : (
          <ul className="flex flex-col rounded-lg border border-line">
            {rows.map((sshKey) => (
              <SshKeyRow
                key={sshKey.sshKeyId}
                sshKey={sshKey}
                servers={servers}
                fresh={sshKey.sshKeyId === fresh}
              />
            ))}
          </ul>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button variant="pri">Done</Button>} />
      </Modal.Footer>
    </Modal>
  );
}

const CREATE_REFUSAL = roleRefusal("add an SSH key");
