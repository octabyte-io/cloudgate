"use client";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { NoListing } from "@/components/console/no-listing";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import { isUnreachableHost } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useSwarmServices } from "../docker/use-server-docker";
import { isReady } from "../infrastructure/audit-findings";
import { ServerFactsCard } from "../server-facts-card";
import { ServerPanel } from "../server-panel";
import { UtilisationCard } from "../telemetry/utilisation-card";
import { useServerAudit } from "../use-server";
import { ServerUnreachable } from "../server-unreachable";

/**
 * The Server, at a glance: is it ready, what is on it, how full is it.
 *
 * The reference's Overview leads with a CPU chart and then lists "Services on this
 * server" from a fake fixture. **Neither is available in that form**: telemetry only
 * exists for a Server set up for monitoring, and nothing indexes services *by
 * Server* — an Environment names its own and each carries a `serverId`
 * which is the wrong way
 * round for this screen. So the order is different and the reasons are on screen.
 *
 * What leads instead is **readiness**, because it is the question this screen is
 * opened to answer and the only one whose answer changes what you do next. Below it,
 * the two honest readings: what Docker says is running here, and how full the machine
 * is.
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      aside={(server) => <ServerFactsCard server={server} />}
    >
      {(server) => (
        <>
          <ReadinessCard server={server} />
          <RunningCard server={server} />
          <UtilisationCard server={server} />
        </>
      )}
    </ServerPanel>
  );
}

/**
 * What is stopping this Server taking a deployment, as things to do.
 *
 * `QARow` rather than a checklist: the Infrastructure tab already renders the audit as
 * findings, and repeating it here would be the same information twice with a different
 * shape. What belongs on an overview is the **conclusion** — ready or not — and the
 * one or two rows that are not ready, each as an action.
 */
export function ReadinessCard({ server }: { server: Server }) {
  const audit = useServerAudit(server.serverId, server.sshKeyId !== null);
  const found = audit.data;
  const ready = found ? isReady(found) : false;

  return (
    <Card>
      <Card.Header
        title="Readiness"
        sub="Whether this machine can take a deployment right now."
        headingLevel={2}
        actions={
          <LinkButton
            size="sm"
            href={`/servers/${server.serverId}/infrastructure`}
          >
            Infrastructure
          </LinkButton>
        }
      />
      <Card.Body>
        {server.sshKeyId === null ? (
          <p className="text-body text-tx">
            This Server has no SSH key, so nothing can be read from it or
            deployed to it. Choose a key on the Access tab.
          </p>
        ) : audit.isPending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        ) : isUnreachableHost(audit.error) ? (
          <ServerUnreachable
            serverId={server.serverId}
            ran="The readiness script"
          >
            nothing about whether it can take a deployment is known right now.
          </ServerUnreachable>
        ) : audit.error ? (
          // Reached, and refused: a key the host did not accept, or one that
          // cannot be read. "Could not reach" would send the operator to
          // the network when the fix is on the Access tab, so the backend's own
          // sentence — which names the key — is the reading here.
          <>
            <p className="text-body text-tx">
              Cloudgate could not check this Server, so nothing about it is
              known right now.
            </p>
            <p className="mt-1.5 text-meta text-tx-2 wrap-anywhere">
              {errorMessage(audit.error)}
            </p>
          </>
        ) : !found ? null : ready ? (
          <p className="text-body text-tx">
            Docker {found.docker.version} is running, the Swarm is active and{" "}
            <code className="font-mono">cloudgate-network</code> is there. This
            Server can take a deployment.
          </p>
        ) : (
          <QAList>
            {!found.docker.enabled ? (
              <QARow
                title="Docker is not installed"
                description="Nothing can run here until it is. Setup installs it."
                action={
                  <LinkButton
                    size="sm"
                    variant="pri"
                    href={`/servers/${server.serverId}/infrastructure`}
                  >
                    Run setup
                  </LinkButton>
                }
              />
            ) : null}
            {!found.isSwarmActive ? (
              <QARow
                title="There is no Swarm on this machine"
                description="Cloudgate deploys Swarm services, so a host with Docker but no Swarm can pull an image and still not run anything."
                action={
                  <LinkButton
                    size="sm"
                    variant="pri"
                    href={`/servers/${server.serverId}/infrastructure`}
                  >
                    Run setup
                  </LinkButton>
                }
              />
            ) : null}
            {!found.isNetworkInstalled ? (
              <QARow
                title="cloudgate-network is missing"
                description="Services join this overlay network to reach each other and to be reachable through Traefik."
                action={
                  <LinkButton
                    size="sm"
                    variant="pri"
                    href={`/servers/${server.serverId}/infrastructure`}
                  >
                    Run setup
                  </LinkButton>
                }
              />
            ) : null}
          </QAList>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * What is running here, counted.
 *
 * **The count is Docker's and the card says so**, which is the difference between this
 * and the reference's "Services on this server" table. `docker service ls` knows how
 * many Swarm services are on the host and their replica readings; it does not know
 * which Project or Environment any of them belongs to, so there is nothing to link to
 * and a table of unlinked names would be worse than the number.
 *
 * The absence is stated rather than hidden, because it is the thing somebody arriving
 * here actually wants: *which of my services are on this machine*.
 */
export function RunningCard({ server }: { server: Server }) {
  const services = useSwarmServices(server.serverId);
  const rows = services.data;
  const converged = rows?.filter((row) => {
    const [ready, wanted] = row.Replicas.split("/");
    return ready === wanted && ready !== "0";
  }).length;

  return (
    <Card>
      <Card.Header
        title="Running here"
        headingLevel={2}
        actions={
          <LinkButton size="sm" href={`/servers/${server.serverId}/docker`}>
            Docker &amp; Swarm
          </LinkButton>
        }
      />
      {services.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : isUnreachableHost(services.error) ? (
        <Card.Body>
          <ServerUnreachable
            serverId={server.serverId}
            ran={<code className="font-mono">docker service ls</code>}
          >
            that is not the same as nothing running on it.
          </ServerUnreachable>
        </Card.Body>
      ) : services.error || rows === null || rows === undefined ? (
        <Card.Body flush>
          <NoListing icon="box" title="Nothing can be counted here yet">
            Cloudgate asks Docker on this host what is running, and this host
            did not answer —{" "}
            <code className="font-mono">docker service ls</code> works only on a
            Swarm manager, and a machine with no Swarm cannot answer at all.
          </NoListing>
        </Card.Body>
      ) : (
        <>
          <Card.Body>
            <StatGrid>
              <StatTile
                label="Swarm services"
                value={rows.length}
                detail={
                  rows.length === 0
                    ? "nothing deployed here"
                    : `${converged} of ${rows.length} at their full replica count`
                }
              />
              <StatTile
                label="Role"
                value={server.serverType === "build" ? "Build" : "Deploy"}
                detail={
                  server.serverType === "build"
                    ? "takes image builds, not deployments"
                    : "takes deployments"
                }
              />
            </StatGrid>
          </Card.Body>
          <Card.Footer>
            This is Docker&rsquo;s count, not Cloudgate&rsquo;s. Nothing lists
            which Projects and Environments have services on a Server, so this
            cannot name them — the Docker &amp; Swarm tab has each
            service&rsquo;s own name and image.
          </Card.Footer>
        </>
      )}
    </Card>
  );
}
