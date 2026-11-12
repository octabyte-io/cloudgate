import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { SERVER_UPDATE_REFUSAL, useForgetHostKey } from "../use-server";

/**
 * Which machine Cloudgate trusts to be this Server (ADR-0074).
 *
 * The fingerprint is on screen so an operator can compare it with
 * `ssh-keygen -lf` on the Server. **Forget host key is the only way past a
 * refused, changed key**, so it asks first and says what it gives up: the next
 * connect records whatever key answers, which is exactly what an interceptor
 * would want if the Server was not in fact reinstalled.
 */
export function HostKeyCard({ server }: { server: Server }) {
  const forget = useForgetHostKey(server.serverId);
  // `POST /servers/:id/forget-host-key` is `server: ['create']`, as PATCH is.
  const canForget = usePermission({ server: ["create"] });
  const [confirming, setConfirming] = useState(false);
  const refusalId = useId();
  const fingerprint = server.hostKeyFingerprint;

  async function confirm() {
    try {
      await forget.mutateAsync();
      toast.done(`Cloudgate forgot the host key of ${server.name}.`, {
        description:
          "The next time it connects, it records the key the Server presents.",
      });
      setConfirming(false);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <Card>
        <Card.Header
          title="Host key"
          sub="The key this Server presented the first time Cloudgate connected. Cloudgate refuses to connect if it presents another."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              variant="dngr"
              onClick={() => setConfirming(true)}
              disabled={!canForget.allowed || fingerprint === null}
              title={canForget.allowed ? undefined : SERVER_UPDATE_REFUSAL}
              aria-describedby={canForget.allowed ? undefined : refusalId}
            >
              Forget host key
            </Button>
          }
        />
        <Card.Body>
          <KVList>
            <KVRow
              label="Fingerprint"
              value={fingerprint ?? "not recorded yet"}
              mono={fingerprint !== null}
              title={fingerprint ?? undefined}
              action={
                fingerprint ? (
                  <CopyButton value={fingerprint} label="fingerprint" />
                ) : undefined
              }
            />
          </KVList>
          {canForget.allowed ? null : (
            <p id={refusalId} className="mt-3 text-meta text-tx-2">
              {SERVER_UPDATE_REFUSAL}
            </p>
          )}
        </Card.Body>
        <Card.Footer>
          Compare it with{" "}
          <code className="font-mono">
            ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
          </code>{" "}
          on the Server. With none recorded, Cloudgate records the key on its
          next connection.
        </Card.Footer>
      </Card>

      <Modal open={confirming} onOpenChange={setConfirming}>
        <Modal.Header
          title={`Forget the host key of ${server.name}?`}
          description="Do this only after reinstalling the Server or replacing its SSH host keys."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            The next time Cloudgate connects, it trusts whichever key the
            Server presents and records it. If the Server was not reinstalled,
            a changed key can mean something is intercepting the connection:
            check the fingerprint on the Server first.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button>Cancel</Button>} />
          <Button
            variant="dngr"
            onClick={confirm}
            disabled={forget.isPending}
            aria-busy={forget.isPending || undefined}
          >
            Forget host key
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
