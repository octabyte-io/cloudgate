import { useFormContext } from "react-hook-form";

import { Field, FormError } from "@/components/console/field";
import { Picker } from "@/components/console/picker";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { useSshKeys } from "@/lib/api/use-ssh-keys";
import { Icon } from "@/lib/design/icons";

import type { AddServerValues } from "./add-server-values";

/**
 * Which key Cloudgate dials with — and the way out when there is none.
 *
 * **The key must already reach the host.** Cloudgate uses the private half of
 * whichever key is chosen, so the public half has to be in that host's
 * `authorized_keys` first. An Organization with no keys at all is told so here
 * rather than being handed an empty picker, and the way out is one click.
 *
 * A refusal is kept separate from an empty list, which is the rule this codebase
 * keeps returning to: a 403 on `GET /ssh-keys` must not render "this Organization
 * has no SSH keys yet".
 */
export function SshKeyChoice({
  sshKeys,
  onManageKeys,
}: {
  sshKeys: ReturnType<typeof useSshKeys>;
  /** Opens the keys dialog; Add a Server comes back as it was. */
  onManageKeys: () => void;
}) {
  const form = useFormContext<AddServerValues>();
  const keys = sshKeys.data ?? [];
  const noKeys = !sshKeys.isPending && !sshKeys.error && keys.length === 0;

  return (
    <>
      {noKeys ? (
        <div className="rounded-lg border border-info-line bg-info-tint p-3">
          <p className="text-body text-tx">
            This Organization has no SSH keys yet.
          </p>
          <p className="mt-1 text-meta text-tx-2">
            A Server is reached with a key, so one has to exist before a Server
            can be added. Add a key and you come back here with it chosen and
            what you typed kept; install its public half in the host&rsquo;s{" "}
            <code className="font-mono">authorized_keys</code> before you check
            that Cloudgate can reach it.
          </p>
          <Button size="sm" className="mt-2.5" onClick={onManageKeys}>
            <Icon name="key" size={14} />
            Manage SSH keys
          </Button>
        </div>
      ) : (
        <Field
          name="sshKeyId"
          label="SSH key"
          hint="Cloudgate dials with this key's private half. Its public half has to be on the Server already."
          manual
        >
          <Picker
            value={form.watch("sshKeyId")}
            onValueChange={(next) =>
              form.setValue("sshKeyId", next, { shouldValidate: true })
            }
            pending={sshKeys.isPending}
            placeholder="Choose a key"
            options={keys.map((key) => ({
              value: key.sshKeyId,
              label: key.name,
              detail: key.description ?? undefined,
            }))}
          />
        </Field>
      )}

      {sshKeys.error ? (
        <FormError
          message={`The SSH keys could not be read, so there is nothing to choose. ${errorMessage(sshKeys.error)}`}
        />
      ) : null}
    </>
  );
}

/** Whether the dialog can be submitted at all — no key, no Server. */
export function hasNoKeys(sshKeys: ReturnType<typeof useSshKeys>): boolean {
  return (
    !sshKeys.isPending && !sshKeys.error && (sshKeys.data ?? []).length === 0
  );
}
