"use client";

import { Card } from "@/components/console/card";
import { CodeWell } from "@/components/console/code-well";
import { KVList, KVRow } from "@/components/console/kv-list";
import type { Server } from "@/lib/api/endpoints/servers";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { installationFindings } from "../infrastructure/audit-findings";
import { FindingList } from "../infrastructure/finding-list";
import { ServerGpuSupportCard } from "../infrastructure/gpu-support-card";
import { ReachabilityCard } from "../infrastructure/reachability-card";
import { SetupCard } from "../infrastructure/setup-card";
import { IngressRow, ingressNote, useRuntimeInfo } from "../runtime-info";
import { ServerPanel } from "../server-panel";
import { useServerAudit } from "../use-server";

/**
 * What Cloudgate put on this machine, and whether it is still there.
 *
 * The reference's Infrastructure tab is a Terraform run — a plan, a resource table,
 * outputs and drift detection — and **none of it exists** (`00-INDEX.md`, locked
 * decision 1). What replaces it is the thing that does: the readiness script, read
 * as findings, beside the script that fixes them.
 *
 * The tab is three cards in the order somebody actually needs them. **Can we reach
 * it** comes first, because every other reading on this page is taken over SSH and
 * a failure here explains all of them at once. Then **what is installed**, then
 * **the setup that installs it**. GPU support comes last: it is only
 * for the machines that have one, and it needs the setup above to have run.
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      aside={(server) => <SetupAside server={server} />}
    >
      {(server) => <Infrastructure server={server} />}
    </ServerPanel>
  );
}

function Infrastructure({ server }: { server: Server }) {
  // One query, two tabs: the Access tab reads the same result for its two privilege
  // findings, off the same cache key, so opening both costs one SSH session.
  const audit = useServerAudit(server.serverId, server.sshKeyId !== null);

  return (
    <>
      <ReachabilityCard server={server} />

      <FindingList
        title="What is installed"
        lede="Read off the host by the readiness script, not from anything Cloudgate stored."
        query={audit}
        findings={installationFindings}
        footer={
          server.sshKeyId === null
            ? "There is no SSH key on this Server, so the script cannot be run at all. Choose a key on the Access tab."
            : "The two findings about what this user is allowed to do are on the Access tab."
        }
      />

      <SetupCard server={server} />

      <ServerGpuSupportCard server={server} />
    </>
  );
}

/**
 * The aside: the script Cloudgate would run, or the one it will run instead.
 *
 * A **custom setup command replaces the default entirely** —
 * `current.command || serverSetupCommand()` — so when one is set it is the single
 * most important thing on this tab and it is shown in full rather than summarised.
 * `CodeWell` rather than the editor: it is edited on the Settings tab, and a second
 * place to change the same column is a second place for the two to disagree.
 *
 * It takes the whole `Server` rather than its `command`, because the
 * `Ingress` row now reads `GET /settings/runtime-info` for *this* host and needs
 * its id — `null` there would name the platform host on every Server's tab.
 */
function SetupAside({ server }: { server: Server }) {
  const custom = server.command.trim();
  const runtime = useRuntimeInfo(server.serverId);

  return (
    <>
      <Card>
        <Card.Header title="Why Docker Swarm" headingLevel={2} />
        <Card.Body>
          <p className="text-ui text-tx-2">
            Cloudgate deploys every service as a Swarm service and routes to it
            with Traefik, over one attachable overlay network. That is why setup
            does all three together: a host with Docker but no Swarm can pull an
            image and still not run anything.
          </p>
          <KVList className="mt-3">
            <KVRow label="Runtime" value="Docker Swarm" />
            {/*
              The version is read off the machine, never written down here.
              The literal deleted from this row named an old pin while
              the container ran the current one, one screen away from the setup
              step that says why a number does not belong here — and bumping it
              was rejected, because it is wrong again on the next bump and wrong
              today on any instance that sets `TRAEFIK_VERSION` in its
              environment. `IngressRow` reads `GET /settings/runtime-info`
              instead, and shows the declared pin beside the observed version
              only when the two disagree.
            */}
            <IngressRow query={runtime} />
            <KVRow label="Network" value="cloudgate-network" mono />
            <KVRow label="Directory" value="/etc/cloudgate" mono />
          </KVList>
          <p className="mt-3 text-meta text-tx-2">{ingressNote(runtime)}</p>
        </Card.Body>
      </Card>

      {custom ? (
        <Card>
          <Card.Header
            title="This Server's own setup command"
            sub="Run instead of the default script, exactly as written."
            headingLevel={2}
          />
          <Card.Body flush>
            <CodeWell content={custom} label="Custom setup command" />
          </Card.Body>
          <Card.Footer>
            Edited on the Settings tab. Empty it there and setup goes back to
            the six default steps.
          </Card.Footer>
        </Card>
      ) : null}
    </>
  );
}
