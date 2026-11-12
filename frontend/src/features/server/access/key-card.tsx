import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Picker } from "@/components/console/picker";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import { useServers } from "@/lib/api/use-servers";
import { useSshKeys } from "@/lib/api/use-ssh-keys";
import { Icon } from "@/lib/design/icons";
import { ManageKeysModal } from "@/features/ssh-keys/manage-keys-modal";

import { useUpdateServer } from "../use-server";

/**
 * The file this Server's SSH user keeps its authorized keys in.
 *
 * `root` is the one user that does not live under `/home`, and it is also the
 * default in the Add a Server dialog — so the card named
 * `/home/root/.ssh/authorized_keys`, a path that does not exist on the install
 * most operators have, and then hedged with "or root's, if the user is root"
 * and left the reader to work out which of the two sentences applied to them.
 *
 * `~{username}/.ssh/authorized_keys` would be true for both users in one string
 * and is rejected anyway: this sentence is read by someone about to append a
 * line to that file over an existing session, and the tilde form is expanded by
 * a shell rather than by the editor or the `tee` they are pasting it into.
 */
function authorizedKeysPath(username: string) {
  return username === "root"
    ? "/root/.ssh/authorized_keys"
    : `/home/${username}/.ssh/authorized_keys`;
}

/**
 * The key this Server uses, and the way to change it.
 *
 * **The public half is on screen with a copy control**, because it is the thing that
 * has to be in the host's `authorized_keys` and that is a job people come back to.
 * The private half is never rendered: Cloudgate holds it to dial with, nobody needs it
 * in a browser, and `endpoints/ssh-keys.ts` does not declare the field so nothing here
 * *can* render it.
 *
 * **There is no rotation**, and the card says so rather than offering a control that
 * would not work: `updateSshKeySchema` takes a name and a description and nothing
 * else, so a keypair cannot be replaced in place. Changing which key a Server uses is
 * a different thing and that *is* here.
 */
export function KeyCard({ server }: { server: Server }) {
  const sshKeys = useSshKeys();
  // Every Server in the Organization, not this one: All keys is the fleet's
  // dialog, and a key another Server uses would otherwise read "no Server uses
  // it" and delete without naming the Server it strands. Nothing stands
  // in for the list: until it arrives, or if it cannot be read, the dialog does
  // not open, because a partial list is exactly the wrong answer that ticket
  // was — a delete confirm saying "No Server is using it" for a key in use.
  const fleet = useServers();
  const update = useUpdateServer(server.serverId);
  const [choosing, setChoosing] = useState(false);
  const pickerId = useId();
  const [chosen, setChosen] = useState(server.sshKeyId ?? "");
  const [managing, setManaging] = useState(false);

  const key = sshKeys.data?.find((row) => row.sshKeyId === server.sshKeyId);

  async function save() {
    if (!chosen || chosen === server.sshKeyId) return setChoosing(false);
    try {
      await update.mutateAsync({ sshKeyId: chosen });
      const name = sshKeys.data?.find((row) => row.sshKeyId === chosen)?.name;
      toast.done(`${server.name} now uses ${name ?? "that key"}.`, {
        description:
          "Its public half has to be on the machine already, or Cloudgate cannot reach it.",
      });
      setChoosing(false);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <Card>
        <Card.Header
          title="SSH"
          sub={`Cloudgate signs in as ${server.username} on ${server.ipAddress}:${server.port}.`}
          headingLevel={2}
          actions={
            <>
              <Button
                size="sm"
                onClick={() => setManaging(true)}
                disabled={!fleet.data}
                aria-busy={fleet.isPending || undefined}
              >
                <Icon name="key" size={14} />
                All keys
              </Button>
              {choosing ? null : (
                <Button size="sm" onClick={() => setChoosing(true)}>
                  Change the key
                </Button>
              )}
            </>
          }
        />
        <Card.Body>
          <KVList>
            <KVRow label="User" value={server.username} mono />
            <KVRow label="Host" value={server.ipAddress} mono />
            <KVRow label="Port" value={String(server.port)} mono />
            <KVRow
              label="Key"
              value={
                server.sshKeyId === null
                  ? "none"
                  : sshKeys.isPending
                    ? "loading"
                    : (key?.name ?? "a key this role cannot read")
              }
            />
          </KVList>

          {choosing ? (
            <div className="mt-3 flex animate-rise flex-wrap items-end gap-2 rounded-lg border border-line bg-panel-2 p-3">
              <div className="min-w-0 flex-[1_1_200px]">
                <label
                  htmlFor={pickerId}
                  className="mb-1.25 block text-meta text-tx-2 wrap-anywhere"
                >
                  Which key reaches {server.name}
                </label>
                <Picker
                  id={pickerId}
                  value={chosen}
                  onValueChange={setChosen}
                  pending={sshKeys.isPending}
                  placeholder="Choose a key"
                  options={(sshKeys.data ?? []).map((row) => ({
                    value: row.sshKeyId,
                    label: row.name,
                    detail: row.description ?? undefined,
                  }))}
                />
              </div>
              <Button
                size="sm"
                variant="pri"
                onClick={save}
                disabled={update.isPending}
                aria-busy={update.isPending || undefined}
              >
                Save
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setChosen(server.sshKeyId ?? "");
                  setChoosing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : null}

          {fleet.error ? (
            <p className="mt-3 text-meta text-tx-2">
              All keys says which Servers use each key, and the list of Servers
              could not be read: {errorMessage(fleet.error)}
            </p>
          ) : null}

          {server.sshKeyId === null ? (
            <p className="mt-3 rounded-lg border border-bad-line bg-bad-tint p-2.5 text-meta text-tx">
              {/* Deleting a key does not refuse while Servers are on it; it
                  clears their column, which is how a Server ends up here. */}
              Choose a key: this Server has none, so nothing can reach it. Its
              key was most likely deleted.
            </p>
          ) : sshKeys.error ? (
            <p className="mt-3 text-meta text-tx-2">
              {errorMessage(sshKeys.error)}
            </p>
          ) : key ? (
            <div className="mt-3 rounded-lg border border-line bg-panel-2 p-2.5">
              <p className="mb-1.5 text-meta text-tx-2">
                This key&rsquo;s public half. It has to be a line in{" "}
                <code className="font-mono">
                  {authorizedKeysPath(server.username)}
                </code>{" "}
                on the Server.
              </p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 font-mono text-meta wrap-anywhere text-tx-2">
                  {key.publicKey}
                </code>
                <CopyButton value={key.publicKey} label="public key" />
              </div>
            </div>
          ) : null}
        </Card.Body>
        <Card.Footer>
          {/* Only a key's name and description can be edited, so a keypair
              cannot be rotated in place. */}
          To replace a key, add a new one, install it on each machine that used
          the old one, and choose it here.
        </Card.Footer>
      </Card>

      {fleet.data ? (
        <ManageKeysModal
          open={managing}
          onOpenChange={setManaging}
          servers={fleet.data}
        />
      ) : null}
    </>
  );
}
