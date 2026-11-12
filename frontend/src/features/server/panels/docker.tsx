"use client";

import { Card } from "@/components/console/card";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { isUnreachableHost } from "@/lib/api/api-error";
import type { Server } from "@/lib/api/endpoints/servers";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ContainersCard } from "../docker/containers-card";
import { JoinCommandCard } from "../docker/join-command-card";
import { SwarmNodesCard } from "../docker/swarm-nodes-card";
import { useSwarmServices } from "../docker/use-server-docker";
import { IngressRow, ingressNote, useRuntimeInfo } from "../runtime-info";
import { ServerPanel } from "../server-panel";
import { useServerAudit } from "../use-server";
import { ServerUnreachable } from "../server-unreachable";

/**
 * What Docker is doing on this machine.
 *
 * Four cards, in the order a question gets bigger: the containers on this host, the
 * Swarm services above them, the Swarm's nodes, and how to add another machine to it.
 *
 * **The endpoint audit is what shaped this tab**, and two of its answers are on
 * screen:
 *
 * 1. **`GET /docker/containers` is server-scoped by `?serverId=`** — confirmed in
 *    `docker-ops.controller.ts`, where every route takes a `ServerIdQueryDto` and
 *    `checkServerAccess` resolves it inside the caller's Organization. So the
 *    containers table can be a Server's table rather than the platform host's. That
 *    server gate is no longer the only one: a **managed** row — a container
 *    whose Docker owner labels trace back to a Service in this instance's database —
 *    is dropped when that Service belongs to another organization, because the route
 *    used to hand any owner or admin every other organization's task names, images,
 *    published ports and container ids off the shared platform host. An **unmanaged**
 *    row belongs to no Service — Traefik, the platform's own, anything an operator
 *    started by hand — and is still listed to anyone with machine-level Docker
 *    access. So the listing is *not* org-scoped outright, which is the whole point:
 *    `ContainersCard`'s header carries the same distinction on screen.
 * 2. **`add-worker` and `add-manager` return commands and perform no join.** The card
 *    says so where the command is, rather than in a footnote.
 *
 * And one route is used **nowhere**: `GET /cluster/nodes` is dockerode's raw
 * `listNodes`, a second reading of the same nodes that adds nothing this table shows
 * and *throws* off a Swarm rather than answering with nothing — so the parsed
 * `docker node ls` is the one that can tell a worker apart from a broken host.
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      aside={(server) => <DockerAside server={server} />}
    >
      {(server) => (
        <>
          <ContainersCard serverId={server.serverId} serverName={server.name} />
          <SwarmServicesCard server={server} />
          <SwarmNodesCard serverId={server.serverId} serverName={server.name} />
          <JoinCommandCard server={server} />
        </>
      )}
    </ServerPanel>
  );
}

/**
 * `docker service ls` — the Swarm services on this host.
 *
 * **Deliberately a short list and not a table**, because of what it is not. Docker
 * knows a service's name and nothing about which Project or Environment it belongs
 * to. Cloudgate's side of that join exists now — an Environment names its services
 * and each carries the `appName` Docker uses
 * — but making it here
 * means reading every Environment in the Organization to label one host's services.
 * Until that is worth paying for, a row here cannot link anywhere and a table would
 * imply it should. What it is good for is the count and the
 * replica reading: `0/1` on a service is the shape of a deploy that finished and a
 * container that will not stay up, and this is the only screen in the console that
 * shows it.
 *
 * **Three answers, not two** (X11-4). The branch below used to read
 * `services.error || services.data === null` and say *"`docker service ls` works
 * only on a manager, so a worker answers this way and so does a host with no
 * Swarm"* — a specific, plausible diagnosis, and it was what an operator got for a
 * Server that was never reached, because `GET /swarm/apps` answered `200 []` for
 * one. A Server nobody reached is now its own state and its own sentence.
 *
 * Exported for the test that pins that, and for nothing else: the card is this
 * file's and the panel it sits in needs `ServerPanel` and the tab registry to
 * render, which is a lot of machinery for one paragraph of copy. `DockerAside`
 * below is exported for the same kind of reason.
 */
export function SwarmServicesCard({ server }: { server: Server }) {
  const services = useSwarmServices(server.serverId);
  const rows = services.data ?? [];

  return (
    <Card>
      <Card.Header
        title="Swarm services"
        sub="What docker service ls reports here. Cloudgate's own services are filtered out."
        headingLevel={2}
        actions={
          // The same Refresh its two neighbours on this tab have.
          <Button
            size="sm"
            onClick={() => void services.refetch()}
            disabled={services.isFetching}
            aria-busy={services.isFetching || undefined}
          >
            <Icon name="refresh" size={14} />
            Refresh
          </Button>
        }
      />
      <Card.Body>
        {services.isPending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
          </div>
        ) : isUnreachableHost(services.error) ? (
          <ServerUnreachable
            serverId={server.serverId}
            ran={<code className="font-mono">docker service ls</code>}
          >
            this is not the same as no Swarm services running on it.
          </ServerUnreachable>
        ) : services.error || services.data === null ? (
          <p className="text-body text-tx-2">
            This host cannot list Swarm services.{" "}
            <code className="font-mono">docker service ls</code> works only on a
            manager, so a worker answers this way and so does a host with no
            Swarm.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-body text-tx-2">
            No Swarm services are running here. Anything Cloudgate deploys
            becomes one, so an Environment pointed at this Server has not
            deployed yet.
          </p>
        ) : (
          <KVList>
            {rows.map((service) => (
              <KVRow
                key={service.ID}
                label={service.Name}
                value={
                  <span className="flex flex-wrap items-baseline justify-end gap-x-2">
                    <span className="num">{service.Replicas}</span>
                    <span className="font-mono text-meta text-tx-3">
                      {service.Image}
                    </span>
                  </span>
                }
                title={service.Image}
              />
            ))}
          </KVList>
        )}
      </Card.Body>
      {rows.length > 0 ? (
        <Card.Footer>
          This is Docker&rsquo;s answer, not Cloudgate&rsquo;s. Nothing here
          says which Project or Environment a service belongs to, and a service
          deployed as a plain container is not in this list at all.
        </Card.Footer>
      ) : null}
    </Card>
  );
}

/**
 * The Docker facts the audit already found, so this tab does not ask a second time.
 *
 * **The one exception is the `Ingress` row**, and it is an exception because the
 * readiness script does not report Traefik's version at all — so filling that row
 * means a second route rather than a second reading of the same answer.
 * There is deliberately no second *Docker* version row: `Version` above is the
 * audit's, off the SSH session this tab already paid for, and a second reading of
 * the same number from a second route is a disagreement waiting to be rendered.
 *
 * That exception is also why the `Ingress` row is rendered **outside** the audit's
 * pending branch. `useServerAudit` is disabled while `sshKeyId` is null, and a
 * disabled query is `isPending` forever — so a Server with no key held the
 * skeleton permanently, and a row reading a different route was never reached
 * while the paragraph below went on describing it. The three rows above it are
 * the audit's and correctly wait for it; this one has nothing to wait for.
 *
 * Exported for that test alone — the placement is the thing that regressed, and
 * placement is invisible to a test of `IngressRow` on its own.
 */
export function DockerAside({ server }: { server: Server }) {
  const audit = useServerAudit(server.serverId, server.sshKeyId !== null);
  const runtime = useRuntimeInfo(server.serverId);
  const found = audit.data;

  return (
    <Card>
      <Card.Header title="Docker on this host" headingLevel={2} />
      <Card.Body>
        {server.sshKeyId === null ? (
          /*
            A disabled query is `isPending` forever, so without this branch the
            three audit rows below skeleton permanently on a Server with no key —
            a loading state that never ends reads as broken rather than as
            unavailable. The Infrastructure tab already says why in the same
            situation ("There is no SSH key on this Server, so the script cannot
            be run at all"); this card said nothing, and the Ingress row —
            which does not read the audit and renders regardless — put a live
            value beside the permanent skeleton, which made the silence louder.
          */
          <p className="text-body text-tx-2">
            There is no SSH key on this Server, so the readiness script cannot
            be run and these rows cannot be read. Choose a key on the Access
            tab.
          </p>
        ) : audit.isPending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        ) : (
          <KVList>
            <KVRow
              label="Version"
              value={
                found?.docker.enabled && found.docker.version !== "0.0.0" ? (
                  found.docker.version
                ) : (
                  <Dash word={found ? "Not installed" : "Unknown"} />
                )
              }
              mono
            />
            <KVRow
              label="Swarm"
              value={
                found ? (
                  found.isSwarmActive ? (
                    "active"
                  ) : (
                    "not initialised"
                  )
                ) : (
                  <Dash word="Unknown" />
                )
              }
            />
            <KVRow
              label="Overlay network"
              value={
                found ? (
                  found.isNetworkInstalled ? (
                    "cloudgate-network"
                  ) : (
                    "missing"
                  )
                ) : (
                  <Dash word="Unknown" />
                )
              }
              mono={found?.isNetworkInstalled}
            />
          </KVList>
        )}
        {/*
          The one row here the audit cannot answer, and the one that is not read
          by the readiness script at all: it reports Docker, Swarm, the network
          and the directory, never Traefik's version. This row was emptied
          rather than bumping the literal, which had gone on naming an old
          pin while the container ran the current one with nothing on the tab
          contradicting it. It is now filled from
          `GET /settings/runtime-info` — a second route, and therefore a second
          SSH answer, which is why the paragraph below no longer claims every
          row on this card came from the readiness script.

          Outside the branch above on purpose: it does not read the audit, so
          gating it on the audit hid it forever on a Server with no SSH key.
        */}
        <KVList>
          <IngressRow query={runtime} />
        </KVList>
        <p className="mt-3 text-meta text-tx-2">
          Every row above the last is read by the same readiness script the
          Infrastructure tab runs, off the same answer — opening both tabs costs
          one SSH session, not two. {ingressNote(runtime)}
        </p>
      </Card.Body>
    </Card>
  );
}
