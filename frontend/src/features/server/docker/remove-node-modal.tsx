import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { SwarmNode } from "@/lib/api/endpoints/docker";

/**
 * Draining a node out of the Swarm, with the three consequences that are actually
 * different from each other.
 *
 * **Draining reschedules, it does not preserve.** Tasks move to the remaining nodes
 * if there is room for them and do not if there is not, which is the one sentence
 * somebody needs before pressing this on a two-node cluster.
 *
 * **The machine itself is untouched** — Docker stays installed and anything not
 * managed by this Swarm keeps running. And if it is also a Server in Cloudgate, this
 * does not delete it: it stays in the fleet, no longer taking work from this Swarm.
 * Both are said because "remove" reads like more than it is.
 */
export function RemoveNodeModal({
  node,
  pending,
  onClose,
  onRemoved,
  remove,
}: {
  node: SwarmNode | null;
  pending: boolean;
  onClose: () => void;
  /** Called after a successful removal, so the listing can be re-read. */
  onRemoved: () => void;
  remove: (nodeId: string) => Promise<unknown>;
}) {
  return (
    <Modal open={node !== null} onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={node ? `Remove ${node.Hostname} from the Swarm?` : ""}
        description="Cloudgate drains the node first, then force-removes it."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          Draining reschedules every task on{" "}
          <strong className="font-medium text-tx">{node?.Hostname}</strong> onto
          the remaining nodes, so services stay up if there is room for them
          elsewhere — and do not if there is not.
        </p>
        <p className="text-body text-tx-2">
          The machine itself is untouched. Docker stays installed on it and any
          container not managed by this Swarm keeps running. It stops being part
          of the cluster, so nothing new is scheduled there.
        </p>
        <p className="text-meta text-tx-3">
          If that machine is also a Server in Cloudgate, this does not delete it
          — it will still be in the fleet, no longer taking work from this
          Swarm.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button>Cancel</Button>} />
        <Button
          variant="dngr"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            if (!node) return;
            const hostname = node.Hostname;
            try {
              await remove(node.ID);
              toast.done(`${hostname} removed from the Swarm.`);
              onClose();
              onRemoved();
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          Drain and remove
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
