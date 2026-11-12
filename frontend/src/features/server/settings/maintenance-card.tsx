import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import {
  SERVER_UPDATE_REFUSAL,
  useEndMaintenance,
  useStartMaintenance,
} from "../use-server";

/**
 * Start and End **Maintenance** (spec #1420). While a Server is in
 * maintenance nothing new starts containers on it; what already runs keeps
 * running.
 *
 * Starting asks first, naming the Server, because it refuses every teammate's
 * deploys until someone ends it. Ending does not: it only lets work through
 * again. Both routes are `server: ['create']`, as Forget host key is, so a role
 * without it sees the control off with the same sentence.
 */
export function MaintenanceCard({ server }: { server: Server }) {
  const start = useStartMaintenance(server.serverId);
  const end = useEndMaintenance(server.serverId);
  const canChange = usePermission({ server: ["create"] });
  const [confirming, setConfirming] = useState(false);
  const refusalId = useId();
  const inMaintenance = server.maintenanceSince !== null;

  async function confirmStart() {
    try {
      await start.mutateAsync();
      toast.done(`${server.name} is in maintenance.`);
      setConfirming(false);
    } catch (error) {
      toast.error(error);
    }
  }

  async function endIt() {
    try {
      await end.mutateAsync();
      toast.done(`${server.name} is out of maintenance.`);
    } catch (error) {
      toast.error(error);
    }
  }

  // The words of the refusal; each control states its own `disabled`, so the
  // census in `gated-controls.test.ts` reads the verdict at every site.
  const gate = {
    title: canChange.allowed ? undefined : SERVER_UPDATE_REFUSAL,
    "aria-describedby": canChange.allowed ? undefined : refusalId,
  };

  return (
    <>
      <Card>
        <Card.Header
          title="Maintenance"
          sub="Nothing new starts on a Server in maintenance, and what already runs keeps running."
          headingLevel={2}
          actions={
            inMaintenance ? (
              <Button
                size="sm"
                {...gate}
                disabled={!canChange.allowed || end.isPending}
                aria-busy={end.isPending || undefined}
                onClick={() => void endIt()}
              >
                End maintenance
              </Button>
            ) : (
              <Button
                size="sm"
                {...gate}
                disabled={!canChange.allowed}
                onClick={() => setConfirming(true)}
              >
                Start maintenance
              </Button>
            )
          }
        />
        {canChange.allowed ? null : (
          <Card.Body>
            <p id={refusalId} className="text-meta text-tx-2">
              {SERVER_UPDATE_REFUSAL}
            </p>
          </Card.Body>
        )}
      </Card>

      <Modal open={confirming} onOpenChange={setConfirming}>
        <Modal.Header
          title={`Start maintenance on ${server.name}?`}
          description="Deploys, redeploys, rebuilds, rollbacks, Starts, restarts and Run now on it are refused until it is ended."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            Builds already queued for it are refused when picked up. What is
            running keeps running; scheduled Cron service runs, backups and
            Uptime checks carry on, and so does Server setup.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button>Cancel</Button>} />
          <Button
            variant="pri"
            onClick={() => void confirmStart()}
            disabled={!canChange.allowed || start.isPending}
            aria-busy={start.isPending || undefined}
          >
            Start maintenance
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
