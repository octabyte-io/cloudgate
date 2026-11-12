import { useState } from "react";

import { CopyButton } from "@/components/console/copy-button";
import { Dash } from "@/components/console/dash";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Server } from "@/lib/api/endpoints/servers";
import type { SshKeySummary } from "@/lib/api/endpoints/ssh-keys";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { timeAgo } from "@/lib/format/time";

import { useDeleteSshKey, useUpdateSshKey } from "./use-ssh-keys";

/**
 * One key, and the three things you can do with it.
 *
 * Renaming and deleting happen **in the row**, F08's `TagRow` shape and for its
 * reason: this list is already inside a dialog, and a dialog over a dialog is a
 * focus trap over a focus trap.
 *
 * **The public key is the useful half and it is here permanently, not once.** The
 * F13 brief expected a private key shown at creation and never again; that is the
 * wrong secret and the wrong moment. Cloudgate holds the private key so it can dial
 * the Server — nobody needs it in a browser — while the *public* key is the thing
 * that has to be pasted into a host's `authorized_keys`, and that is a job people
 * come back to every time they add a machine. (The "never again" premise is not
 * true of this backend either: `GET /ssh-keys` returns the private key on **every**
 * listing. The typed
 * client does not declare it, so nothing here can render it by accident.)
 *
 * Deleting **names the Servers it strands**, which is the one thing about this
 * screen that is easy to get wrong: `server.sshKeyId` is `onDelete: 'set null'`, so
 * the delete does not refuse — it succeeds, and the Servers that used the key
 * quietly become unreachable.
 */
export function SshKeyRow({
  sshKey,
  servers,
  /** Freshly created: open with the public key showing and say to install it. */
  fresh,
}: {
  sshKey: SshKeySummary;
  /** Every Server in the Organization, so the delete can name the ones it strands. */
  servers: Server[];
  fresh?: boolean;
}) {
  const [mode, setMode] = useState<"rest" | "rename" | "confirm">("rest");
  // `PATCH /ssh-keys/:id` asks for `sshKeys: ['create']` — there is no
  // `update` — and `DELETE` for `['delete']`; the base member holds neither.
  const canRename = usePermission({ sshKeys: ["create"] });
  const canDelete = usePermission({ sshKeys: ["delete"] });
  /**
   * `null` means nobody has pressed the toggle, so `fresh` decides — **derived,
   * not initialised from the prop**, and that is a fix rather than a style.
   * Found by driving it: `useState(Boolean(fresh))` never opened, because the row
   * mounts when the refetched list arrives and `setFresh` in the dialog above
   * runs *after* that. The initial state was captured as `false` a render before
   * `fresh` became true, so the one-time "install this key" prompt — the whole
   * point of marking a row fresh — was invisible every time.
   */
  const [toggled, setToggled] = useState<boolean | null>(null);
  const showKey = toggled ?? Boolean(fresh);
  const [name, setName] = useState(sshKey.name);
  const rename = useUpdateSshKey();
  const remove = useDeleteSshKey();

  const using = servers.filter((row) => row.sshKeyId === sshKey.sshKeyId);
  const pending = rename.isPending || remove.isPending;

  async function saveName() {
    const next = name.trim();
    if (next === "" || next === sshKey.name) return setMode("rest");
    try {
      await rename.mutateAsync({
        sshKeyId: sshKey.sshKeyId,
        input: { name: next },
      });
      toast.done(`Key renamed to ${next}.`);
      setMode("rest");
    } catch (error) {
      toast.error(error);
    }
  }

  async function confirmRemove() {
    try {
      await remove.mutateAsync(sshKey.sshKeyId);
      toast.done(`Key ${sshKey.name} deleted.`, {
        description:
          using.length > 0
            ? `${using.map((row) => row.name).join(", ")} ${using.length === 1 ? "has" : "have"} no key now. Choose another on each one's Access tab.`
            : "No Server was using it.",
      });
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <li className="border-b border-line px-2.5 py-2 last:border-b-0">
      {mode === "rename" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            autoFocus
            aria-label={`Rename ${sshKey.name}`}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveName();
              }
              if (event.key === "Escape") {
                setName(sshKey.name);
                setMode("rest");
              }
            }}
            className="min-w-0 flex-[1_1_160px]"
          />
          <Button size="sm" variant="pri" disabled={pending} onClick={saveName}>
            Save
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              setName(sshKey.name);
              setMode("rest");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : mode === "confirm" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-[1_1_200px] text-ui text-tx-2 wrap-anywhere">
            Delete <strong className="font-medium text-tx">{sshKey.name}</strong>?{" "}
            {using.length === 0
              ? "No Server is using it."
              : `${using.length === 1 ? "This Server has" : "These Servers have"} no other key, so nothing will be able to reach ${using.length === 1 ? "it" : "them"} until you choose one: `}
            {using.length > 0 ? (
              <strong className="font-medium text-tx">
                {using.map((row) => row.name).join(", ")}
              </strong>
            ) : null}
          </span>
          <Button
            size="sm"
            variant="dngr"
            disabled={pending || !canDelete.allowed}
            title={canDelete.allowed ? undefined : DELETE_REFUSAL}
            aria-busy={pending || undefined}
            onClick={confirmRemove}
          >
            Delete
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => setMode("rest")}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 flex-[1_1_170px]">
            <span className="block truncate text-body text-tx">
              {sshKey.name}
            </span>
            <span className="block truncate text-meta text-tx-3">
              {sshKey.description ? `${sshKey.description} · ` : ""}
              added {timeAgo(sshKey.createdAt)} ·{" "}
              {using.length === 0
                ? "no Server uses it"
                : using.length === 1
                  ? `${using[0].name} uses it`
                  : `${using.length} Servers use it`}
            </span>
          </span>
          <Button
            size="xs"
            aria-expanded={showKey}
            onClick={() => setToggled(!showKey)}
          >
            <Icon name={showKey ? "eyeOff" : "eye"} size={14} />
            Public key
          </Button>
          <Button
            size="xs"
            disabled={!canRename.allowed}
            title={canRename.allowed ? undefined : RENAME_REFUSAL}
            onClick={() => canRename.allowed && setMode("rename")}
          >
            <Icon name="pencil" size={14} />
            Rename
          </Button>
          <Button
            size="xs"
            disabled={!canDelete.allowed}
            title={canDelete.allowed ? undefined : DELETE_REFUSAL}
            onClick={() => canDelete.allowed && setMode("confirm")}
          >
            <Icon name="trash" size={14} />
            Delete
          </Button>
        </div>
      )}

      {showKey && mode === "rest" ? (
        <div className="mt-2 animate-rise rounded-lg border border-line bg-panel-2 p-2.5">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 font-mono text-meta wrap-anywhere text-tx-2">
              {sshKey.publicKey || <Dash word="Empty" />}
            </code>
            <CopyButton value={sshKey.publicKey} label="public key" />
          </div>
          <p className="mt-2 text-meta text-tx-3">
            {fresh
              ? "Add this line to the Server's ~/.ssh/authorized_keys before you add the Server, or Cloudgate cannot reach it."
              : "This line goes in the Server's ~/.ssh/authorized_keys."}
          </p>
        </div>
      ) : null}
    </li>
  );
}

const RENAME_REFUSAL = roleRefusal("rename an SSH key");
const DELETE_REFUSAL = roleRefusal("delete an SSH key");
