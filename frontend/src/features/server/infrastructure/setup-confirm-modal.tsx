import { CodeWell } from "@/components/console/code-well";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import type { Server } from "@/lib/api/endpoints/servers";

import type { SetupRunState } from "../use-server";

/**
 * The last thing anybody reads before installing software on somebody else's
 * computer.
 *
 * **It has to describe what will actually run.** Found by driving it: this said
 * "it installs Docker, it joins a Swarm, it publishes ports 80 and 443" to a
 * Server whose stored command does none of those — the card behind it warned
 * correctly and then the last thing anyone reads before pressing described a
 * different script. A confirmation that names the wrong consequences is worse than
 * one that names none.
 */
export function SetupConfirmModal({
  server,
  custom,
  state,
  actionLabel,
  open,
  onOpenChange,
  onConfirm,
}: {
  server: Server;
  /** The stored command, or `""` for the default six steps. */
  custom: string;
  state: SetupRunState;
  /** The words on the control that opened this dialog — an action keeps its name. */
  actionLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Run setup on ${server.name}?`}
        description={
          custom
            ? `This runs this Server's own setup command on the machine at ${server.ipAddress}.`
            : `This changes the machine at ${server.ipAddress}. It is the six steps on the tab behind this one.`
        }
      />
      <Modal.Body>
        {custom ? (
          <>
            <p className="text-body text-tx-2">
              None of the default steps run. Cloudgate executes this, as{" "}
              {server.username}, over SSH:
            </p>
            <CodeWell
              content={custom}
              label="The setup command that will run"
            />
          </>
        ) : (
          <ul className="flex flex-col gap-2 text-body text-tx-2">
            <li>
              It installs Docker by piping{" "}
              <code className="font-mono">get.docker.com</code> into{" "}
              <code className="font-mono">sh</code>, if Docker is not there.
            </li>
            <li>
              It joins the machine to a Docker Swarm as a manager, if it is not
              in one.
            </li>
            <li>
              It starts a Traefik container that{" "}
              <strong>publishes ports 80 and 443</strong> and mounts the Docker
              socket.
            </li>
            <li>
              It runs as {server.username}, using sudo where it has to, and
              creates <code className="font-mono">/etc/cloudgate</code>.
            </li>
          </ul>
        )}
        <p className="text-meta text-tx-3">
          {state === "interrupted"
            ? "Cloudgate lost the last run's output. This picks it back up if the run is still going, and starts it over if it has already finished — either is safe, because every step checks before it acts."
            : "On a machine with no Docker this takes minutes. The output appears on the card behind this one as the script writes it, so there is nothing to wait for in the dark."}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button>Cancel</Button>} />
        {/* The same words as the control that opened this dialog: an action
            keeps its name all the way through. */}
        <Button variant="pri" onClick={onConfirm}>
          {actionLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
