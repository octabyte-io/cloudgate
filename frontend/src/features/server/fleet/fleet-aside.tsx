import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import type { Server } from "@/lib/api/endpoints/servers";
import { reachCounts, reachSummary } from "@/lib/design/server-mark";

import {
  declaredMissingNote,
  useRuntimeInfo,
  type RuntimeInfoQuery,
} from "../runtime-info";

/**
 * What the fleet adds up to, and what setup puts on every machine in it.
 *
 * The reference's aside (`e-console.html:2878-2915`) is four tiles, a spend chart,
 * four quick-action switches and an organization card. **Three of the four tiles
 * and all of the rest are absent**, and each absence is one thing that does not
 * exist:
 *
 * - **Spend** needs a cost per Server, which is Terraform work with no backend
 *   (locked decision 1).
 * - **Fleet CPU and Network** need a live sample from every host at once. There is
 *   no such route: telemetry is per Server and only for Servers set up for
 *   monitoring, so this pair would be a mean over an unknown subset — a confident
 *   number about the fleet computed from whichever part of it happens to be
 *   reporting. F07's `ServerTable` left the per-row CPU column out for the same
 *   reason.
 * - **Drift detection** and **auto-attach** are provisioning; **pause all
 *   deployments** has no route.
 *
 * What is left is real: how many Servers there are, how many are `active`, how the
 * fleet splits by role, and what setup installs. The last card earns its place —
 * every one of those values is what setup will *do*, so it is the honest answer to
 * "what will Run setup do to my machine", asked before anyone has opened a Server.
 * Two of the four are versions and are read from the instance rather than written
 * down here; the other two are names and stay literals.
 */

/**
 * The names setup creates. Still literals, and honestly so.
 *
 * `cloudgate-network` (`CLOUDGATE_NETWORK`, in `servers/server-audit.ts`) and
 * `/etc/cloudgate` (`REMOTE_CLOUDGATE_DIRECTORY`, in
 * `common/config/cloudgate-directory.ts`) are backend constants with no route
 * that reports them and **no version in them** — they are names, so they cannot
 * drift the way a number does, and nothing about a reader's role or a reachable
 * host changes what setup will call them. They stay written down, and stay on
 * screen whatever the query beside them does.
 */
const SETUP_NAMES = [
  { label: "Overlay network", value: "cloudgate-network" },
  { label: "Directory", value: "/etc/cloudgate" },
];

/**
 * The two rows that carry a version, read from the instance rather than typed here.
 *
 * Both numbers used to be literals and both were wrong in the same way. The
 * Traefik one was deleted rather than bumping it — it had gone on naming the
 * old pin long after `TRAEFIK_VERSION` moved, and `server-setup.ts` reads
 * that constant from the environment, so *any* literal is also wrong on any
 * install that sets it. Docker's `28.5.0` survived on a weaker argument (the
 * audit checks the real host on the Infrastructure tab), and it is gone too,
 * because the query answering Traefik answers Docker in the same document.
 *
 * **Declared only, and that is not the same choice the Server tabs made.** This
 * card is titled *What setup installs*: it describes every Server in the fleet,
 * and `runtime-info` answers about **one** host. Putting the platform host's
 * observed version here would present it as a fleet-wide fact — the same
 * category error as the literal it replaces, one level up.
 *
 * Each Server's own Infrastructure tab is where an observed reading belongs —
 * and on an instance with **no Server rows** there is no such tab, which is the
 * stock single-host state. The footer says that rather than promising a
 * screen that may not exist.
 *
 * It still does not make an observed reading right here, and the reason is
 * stronger than the fleet-vs-one-host one above: on the platform host the two
 * sides are answers to different questions. `server-setup.ts`'s `installDocker`
 * pins a Server's Docker to `DOCKER_VERSION`; `deploy/install.sh:165` installs
 * the platform host's with no `--version` at all — so `docker.drift` is true on
 * virtually every install and means nothing anyone can act on. The platform
 * host's own observed versions have no console surface today; that is a
 * Platform-screen card and its own issue, not these two rows.
 *
 * The card **does not degrade as a whole**: the route is owner/admin, and a plain
 * member keeps every row, losing only the two numbers. A refusal is not an empty
 * card.
 */
function DeclaredVersionRow({
  label,
  /** What is installed, where that has a name of its own. */
  name,
  version,
  query,
}: {
  label: string;
  name?: string;
  version: string | null;
  query: RuntimeInfoQuery;
}) {
  const missing = declaredMissingNote(query);

  // Terminal-state order: the refusal and the failure are already folded into
  // `missing`, and both are answered before the pending bar — a 403 that came
  // back is not still loading.
  if (missing !== null) {
    return (
      <KVRow
        label={label}
        value={
          <span className="flex flex-wrap items-baseline justify-end gap-x-2">
            {name ? <span>{name}</span> : null}
            <span className="text-meta text-tx-3">{missing}</span>
          </span>
        }
      />
    );
  }

  if (query.isPending) {
    return (
      <KVRow
        label={label}
        aria-busy="true"
        value={<Skeleton className="ml-auto w-20" />}
      />
    );
  }

  if (version === null) {
    // The document arrived and nothing pins this one. Not a failure, and not a
    // blank cell either — a row with no value and no word is a row that looks
    // broken.
    return (
      <KVRow
        label={label}
        value={
          <span className="flex flex-wrap items-baseline justify-end gap-x-2">
            {name ? <span>{name}</span> : null}
            <span className="text-meta text-tx-3">no version pinned</span>
          </span>
        }
      />
    );
  }

  return (
    <KVRow label={label} mono value={name ? `${name} ${version}` : version} />
  );
}

export function FleetAside({
  servers,
  pending,
}: {
  servers: Server[];
  pending: boolean;
}) {
  const reach = reachCounts(servers);
  const build = servers.filter((row) => row.serverType === "build").length;
  // `null` is the platform host, which is where this instance's own pins live —
  // and they are the same pins whichever Server setup is about to run on.
  const runtime = useRuntimeInfo(null);

  return (
    <>
      <Card>
        <Card.Header title="This fleet" headingLevel={2} />
        <Card.Body>
          <StatGrid>
            {/* A figure still in flight is a dash carrying its word, never a
                confident `0` — F07's first defect, on this same shape of tile. */}
            <StatTile
              label="Servers"
              value={pending ? "—" : servers.length}
              detail={
                pending
                  ? "Unknown"
                  : build === 0
                    ? "all of them deploy"
                    : `${servers.length - build} deploy · ${build} build`
              }
            />
            <StatTile
              label="Reachable"
              value={pending ? "—" : reach.reachable}
              detail={pending ? "Unknown" : reachSummary(reach)}
            />
          </StatGrid>
        </Card.Body>
        <Card.Footer>
          {/* "Reachable" is the last attempt, whichever it was — Check now,
              the readiness read on a tab, or a setup run. */}
          Reachable is each Server&rsquo;s last attempt; Check now on its
          Infrastructure tab tries again.
        </Card.Footer>
      </Card>

      <Card>
        <Card.Header title="What setup installs" headingLevel={2} />
        <Card.Body>
          <KVList>
            <DeclaredVersionRow
              label="Docker"
              version={runtime.data?.docker.declared ?? null}
              query={runtime}
            />
            <DeclaredVersionRow
              label="Ingress"
              name="Traefik"
              version={runtime.data?.traefik.declared ?? null}
              query={runtime}
            />
            {SETUP_NAMES.map((row) => (
              <KVRow key={row.label} label={row.label} value={row.value} mono />
            ))}
          </KVList>
        </Card.Body>
        <Card.Footer>
          Every Server gets the same setup: Docker, a Swarm, one attachable
          overlay network, and Traefik publishing 80 and 443. These are the
          versions setup pins, not a reading off any machine.{" "}
          {/* Terminal-state order, the same rule the tiles above follow: while
              the list is in flight, do not claim there are none. And the
              Infrastructure tab only exists under a Server, so with zero rows
              the old sentence pointed at a screen there is no route to.
             */}
          {pending || servers.length > 0
            ? "Each Server’s Infrastructure tab checks what is really there."
            : "Nothing has been set up yet — once a Server is added, its Infrastructure tab is where a reading off a real machine appears."}
        </Card.Footer>
      </Card>
    </>
  );
}
