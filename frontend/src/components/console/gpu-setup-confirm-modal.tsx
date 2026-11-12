import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";

/**
 * The last thing read before GPU setup restarts Docker on a machine.
 *
 * **It names the restart and what it costs**, because that is not visible from
 * the card: setup rewrites `/etc/docker/daemon.json` and restarts the Docker
 * daemon, and every Service on that machine stops while it comes back.
 * Cloudgate never runs this by itself — not on upgrade, not on deploy — so this
 * dialog is the only way it happens.
 */
export function GpuSetupConfirmModal({
  machineName,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** "the platform host", or the Server's name. */
  machineName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Run GPU setup on ${machineName}?`}
        description="This restarts Docker on that machine. Every Service on that machine stops for a moment while Docker comes back."
      />
      <Modal.Body>
        <ul className="flex flex-col gap-2 text-body text-tx-2">
          <li>
            It writes <code className="font-mono">/etc/docker/daemon.json</code>{" "}
            with the NVIDIA runtime as Docker&rsquo;s default, and lists each
            GPU to Swarm by its own card ID, read from{" "}
            <code className="font-mono">nvidia-smi</code>.
          </li>
          <li>
            It tells the NVIDIA runtime to take the cards Swarm assigns each
            task, so a task sees only its own cards.
          </li>
          <li>
            It <strong>restarts the Docker daemon</strong>. Containers on this
            machine are stopped and started again; Swarm brings every Service
            back once Docker is up.
          </li>
        </ul>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button type="button" variant="pri" onClick={onConfirm}>
          Run GPU setup
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
