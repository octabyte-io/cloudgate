import { CodeWell } from "@/components/console/code-well";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ContainerListItem } from "@/lib/api/endpoints/docker";

import { useContainerConfig } from "./use-server-docker";

/**
 * What you open *onto* a container rather than doing *to* it.
 *
 * A dialog rather than a tab: it is about one row of a table somebody is already
 * looking at, and a route for it would need an address for a container id that
 * stops existing when the container is replaced.
 *
 * The container's shell used to be the second dialog here, and is the docked
 * terminal now:
 * a dialog hid the page you were working from, and ended the shell on Escape —
 * a key people press inside a terminal constantly. `containers-card.tsx` opens
 * it straight into the Dock.
 */

/**
 * `docker inspect`, whole.
 *
 * **Rendered as the JSON it is**, not as fields. The Engine API's container document
 * is forty keys deep and versioned by Docker; picking a dozen of them to show would
 * be this console deciding which parts of `docker inspect` matter, and being wrong
 * the first time somebody needed one of the others. What it is *for* is checking
 * something specific — a mount source, an env var, a restart count — and for that,
 * the document is the right answer.
 *
 * `getConfig` catches every failure into `undefined`, so an unknown container, an
 * unreachable host and unparsable output are one answer. The dialog says the
 * inspection came back empty rather than guessing which.
 */
export function InspectContainerModal({
  container,
  serverId,
  onOpenChange,
}: {
  container: ContainerListItem | null;
  serverId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const config = useContainerConfig(serverId, container?.containerId ?? null);

  return (
    <Modal open={container !== null} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title={container ? container.name : "Container"}
        description="docker inspect on this container, exactly as the Engine API answered it."
      />
      <Modal.Body>
        {config.isPending ? (
          <Skeleton className="h-log w-full" />
        ) : config.error ? (
          <p className="text-body text-tx-2">{errorMessage(config.error)}</p>
        ) : config.data === null || config.data === undefined ? (
          <p className="text-body text-tx-2">
            The inspection came back empty. That route swallows every kind of
            failure into the same answer, so this is either a container that is
            no longer there or a host that would not answer — the containers
            table above will say which after a refresh.
          </p>
        ) : (
          <CodeWell
            content={JSON.stringify(config.data, null, 2)}
            label={`docker inspect ${container?.name ?? ""}`}
            className="max-h-none"
          />
        )}
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button variant="pri">Close</Button>} />
      </Modal.Footer>
    </Modal>
  );
}
