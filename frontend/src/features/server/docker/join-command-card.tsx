import { useState } from "react";

import { Card } from "@/components/console/card";
import { CodeWell } from "@/components/console/code-well";
import { CopyButton } from "@/components/console/copy-button";
import { Button } from "@/components/ui/button";
import { isUnreachableHost } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import { Icon } from "@/lib/design/icons";

import { useServerAudit } from "../use-server";
import { useJoinCommand } from "./use-server-docker";

/**
 * The command that adds another machine to this Swarm.
 *
 * **The endpoint audit's own note, and it changes every label on this card.**
 * `GET /cluster/add-worker` and `add-manager` **do not add anything**: they read the
 * Swarm's join token and format a string. Somebody has to run it, as root, on the
 * machine that is joining. So the button says "Show the command", the heading says
 * what a person will be doing, and nothing here is called "Add a worker" — that is a
 * label people press once and then sit waiting for a node to appear.
 *
 * **It is fetched on demand and never cached.** The command carries a live Swarm join
 * token, which is the entire credential for joining a cluster: anyone who has it can
 * put a machine of their own into this Swarm. A query would keep it under a key a
 * background refetch could reach and leave it on screen for whoever walks past. So it
 * is a mutation, it is asked for, and it is dropped when the tab is left.
 *
 * **And it is offered only once there is a Swarm to join**. On a Server
 * that was unreachable or never set up both buttons were live, pressing one
 * failed, and the pressed one turned primary-purple as though it had worked.
 * They stay off, with the reason beside them, until the readiness audit says the
 * Swarm is active; which one was pressed is `aria-pressed`, not a colour.
 */
export function JoinCommandCard({ server }: { server: Server }) {
  const { serverId, name: serverName } = server;
  const [role, setRole] = useState<"worker" | "manager" | null>(null);
  const join = useJoinCommand(serverId);
  // The same audit the aside's Swarm row reads, off the same cache key.
  const audit = useServerAudit(serverId, server.sshKeyId !== null);
  const blocked = noSwarmReason(server, audit);

  function show(next: "worker" | "manager") {
    setRole(next);
    join.mutate(next);
  }

  return (
    <Card>
      <Card.Header
        title="Add another machine to this Swarm"
        sub={`These commands are run on the new machine, not on ${serverName}.`}
        headingLevel={2}
      />
      <Card.Body>
        <p className="text-body text-tx-2">
          A <strong className="font-medium text-tx">worker</strong> takes work
          and nothing else. A{" "}
          <strong className="font-medium text-tx">manager</strong>{" "}
          also holds
          the Swarm&rsquo;s state and can schedule — Docker asks for an odd
          number of them, and one is a Swarm that stops working when that
          machine does.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            aria-pressed={role === "worker"}
            onClick={() => show("worker")}
            disabled={join.isPending || blocked !== null}
          >
            <Icon name="plus" size={14} />
            Show the worker command
          </Button>
          <Button
            size="sm"
            aria-pressed={role === "manager"}
            onClick={() => show("manager")}
            disabled={join.isPending || blocked !== null}
          >
            <Icon name="plus" size={14} />
            Show the manager command
          </Button>
        </div>

        {blocked ? <p className="text-meta text-tx-2">{blocked}</p> : null}

        {join.isPending ? (
          <p className="text-body text-tx-2">
            Reading the Swarm&rsquo;s join token.
          </p>
        ) : join.isError ? (
          <p className="text-body text-tx-2">{errorMessage(join.error)}</p>
        ) : join.isSuccess && role ? (
          <div key={role} className="animate-rise">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-ui text-tx-2">
                Run this on the machine joining as a {role}, as root. It is
                running Docker {join.data.version} here — a joining machine
                should not be far behind that.
              </p>
              <CopyButton
                value={join.data.command}
                label={`${role} join command`}
              />
            </div>
            <CodeWell
              content={join.data.command}
              label={`Swarm join command for a ${role}`}
            />
            <p className="mt-2 text-meta text-tx-2">
              Nothing has happened yet. Cloudgate has not contacted any other
              machine and no node has been added — this is a string, and running
              it is what joins. Refresh the nodes above once you have.
            </p>
          </div>
        ) : null}
      </Card.Body>
      <Card.Footer>
        The token in that command is a credential: anyone holding it can put a
        machine into this Swarm. It is not stored here — leave this tab and it
        is gone.
      </Card.Footer>
    </Card>
  );
}

/**
 * Why there is no join command to show yet, or `null` when there is a Swarm.
 * Read from the readiness audit, which reports `isSwarmActive`.
 */
function noSwarmReason(
  server: Server,
  audit: ReturnType<typeof useServerAudit>,
): string | null {
  if (server.sshKeyId === null) {
    return "There is no SSH key on this Server, so Cloudgate cannot read its Swarm. Choose a key on the Access tab.";
  }
  if (audit.isPending) return "Checking whether this Server has a Swarm.";
  if (isUnreachableHost(audit.error)) {
    return "Cloudgate could not reach this Server, so there is no Swarm it can read a join token from. Check now on the Infrastructure tab says why.";
  }
  if (audit.error) return errorMessage(audit.error);
  if (!audit.data?.isSwarmActive) {
    return "This Server has no Swarm yet. Run setup on the Infrastructure tab — it initialises one — and these commands become available.";
  }
  return null;
}
