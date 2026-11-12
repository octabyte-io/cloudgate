import type { Column } from "@/components/console/data-table";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { StatusPill } from "@/components/console/status-pill";
import { containerMark, type Mark } from "@/lib/design/status";

import type { StackContainer } from "./use-stack-containers";

/**
 * One container of a stack, as a table row.
 *
 * **Service first, container second.** A compose stack's container name is
 * `<appName>-<service>-1` — the same prefix on every row, and the part that
 * differs buried in the middle. What the operator is
 * looking for is the service, so that is the key column and the container name is
 * the detail under it.
 *
 * Three columns are honest about where they came from:
 *
 * - **State** is Docker's own word, through `containerMark`, so a state Docker
 *   adds later shows its own name rather than "undefined".
 * - **Image** comes from the whole-host listing, which is a different route with a
 *   different permission. When that read is refused the column says so rather than
 *   showing a dash, because a dash here would read as "no image".
 * - **Node** exists only for a Swarm stack, so the column is only passed then.
 */
export function containerColumns({
  swarm,
  imagesUnavailable,
  action,
}: {
  swarm: boolean;
  imagesUnavailable: boolean;
  action: (row: StackContainer) => React.ReactNode;
}): Column<StackContainer>[] {
  const columns: Column<StackContainer>[] = [
    {
      id: "service",
      head: "Service",
      tone: "key",
      className: "font-mono",
      // A Swarm task's name — `<stack>_<service>.1.<task id>` — was 370px on its
      // own and put the row's Actions behind the scroll at 1512px. The
      // column takes what the others leave and both lines end in an ellipsis.
      truncate: true,
      compare: (a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name),
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate" title={row.service ?? row.name}>
            {row.service ?? row.name}
          </span>
          {row.service ? (
            <span className="truncate text-meta text-tx-3" title={row.name}>
              {row.containerId ? row.name : "nothing running"}
            </span>
          ) : (
            // No declared service matched this container's name — the file may not
            // be readable, or the container may be a leftover from an older
            // deploy. Either way, saying so beats attributing it to a guess.
            <span className="text-meta text-tx-3">not matched to a service</span>
          )}
        </span>
      ),
    },
    {
      id: "state",
      head: "State",
      compare: (a, b) => a.state.localeCompare(b.state),
      cell: (row) =>
        row.containerId === null ? (
          <StatusPill mark={NOT_RUNNING} />
        ) : (
          <span className="flex flex-col gap-1">
            <StatusPill mark={containerMark(row.state)} />
            {row.status ? (
              <span className="text-meta text-tx-3">{row.status}</span>
            ) : null}
          </span>
        ),
    },
    {
      id: "image",
      head: "Image",
      tone: "wrap",
      className: "font-mono",
      cell: (row) =>
        row.image ? (
          <span className="wrap-anywhere">{row.image}</span>
        ) : imagesUnavailable ? (
          <span className="text-meta text-tx-3">Not listed</span>
        ) : (
          <Dash word="None" />
        ),
    },
    {
      id: "ports",
      /**
       * **`Ports`, not `Published ports`**.
       *
       * The cell is Docker's own `ports` string, verbatim, and that string is
       * not a list of published ports: for a container that publishes nothing
       * it is the *exposed* ones. `redis:7-alpine` reads `6379/tcp` while
       * nothing on the host is listening on 6379, and under the old heading
       * that read as "this cache is on the host's 6379" — the belief the ports
       * finding shows is expensive to get wrong.
       *
       * The alternative was to keep the heading and filter the string down to
       * the `0.0.0.0:x->y/tcp` entries. That is rejected: it would throw away
       * the exposed ports, which are the useful answer to "what can the rest of
       * the stack reach this on", and it would mean this screen parsing a
       * string Docker formats for people rather than for programs. `docker ps`
       * heads exactly this string `PORTS` for the same reason, so the honest
       * fix is the heading, with the notation spelled out where it is read.
       */
      head: (
        <span title="Docker's own PORTS string. host:port->container/proto is published on the host; a bare port/proto is only reachable inside the stack's network.">
          Ports
        </span>
      ),
      className: "font-mono",
      cell: (row) =>
        row.ports ? (
          <span
            className="wrap-anywhere text-meta"
            title={
              row.ports.includes("->")
                ? "An entry with -> is published on the host. One without is only exposed inside the stack's network."
                : "Exposed only — nothing here is published on the host."
            }
          >
            {row.ports}
          </span>
        ) : (
          <Dash word="None" />
        ),
    },
  ];

  if (swarm) {
    columns.push({
      id: "node",
      head: "Node",
      cell: (row) =>
        row.node ? (
          <span className="inline-flex flex-col gap-1">
            <Chip variant="mono">{row.node}</Chip>
            {row.taskError ? (
              <span className="text-meta text-bad wrap-anywhere">
                {row.taskError}
              </span>
            ) : null}
          </span>
        ) : (
          <Dash word="Unscheduled" />
        ),
    });
  }

  columns.push({
    id: "action",
    head: <span className="sr-only">Actions</span>,
    tone: "num",
    cell: action,
  });

  return columns;
}

/**
 * A service the file declares with nothing running for it.
 *
 * A literal `Mark` rather than a key, because it is **not** one of Docker's
 * states: Docker has nothing to say about a container that does not exist. `mute`
 * and not `bad` — a stack that has never been deployed is in this state for every
 * service, and red would send someone looking for an outage.
 */
const NOT_RUNNING: Mark = {
  glyph: "○",
  tone: "mute",
  label: "not running",
};
