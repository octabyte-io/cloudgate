import { useState } from "react";

import { Menu } from "@/components/console/menu";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { DOCK_SHELLS_FULL_SENTENCE } from "@/components/shell/dock-store";
import { Button } from "@/components/ui/button";
import type { ContainerListItem } from "@/lib/api/endpoints/docker";
import { Icon } from "@/lib/design/icons";

import { useContainerActions } from "./use-server-docker";

/**
 * The five things you can do to one container, and the one that needs asking twice.
 *
 * A menu rather than five buttons per row, F12's argument unchanged: five rows of five
 * buttons is twenty-five controls competing for the eye and one of them is ever right.
 *
 * **The three tiers are the design.** Start, restart and stop are lifecycle — the
 * container survives all three. **Kill** is `SIGKILL`, so a process in the middle of a
 * write does not get to finish it, and it is separated and marked destructive.
 * **Remove** is `docker rm -f`, which is not a lifecycle change at all: the container
 * stops existing. That one gets a dialog, because its consequence depends on something
 * the row cannot tell you — a Swarm-managed container comes straight back with a new
 * name, and a hand-run one does not come back at all.
 */
export function ContainerActions({
  container,
  serverId,
  onInspect,
  onShell,
  dockFull = false,
}: {
  container: ContainerListItem;
  serverId: string;
  onInspect: (container: ContainerListItem) => void;
  onShell: (container: ContainerListItem) => void;
  /** The Dock holds `MAX_DOCK_SHELLS`, so a shell has nowhere to open. */
  dockFull?: boolean;
}) {
  const actions = useContainerActions(serverId);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const id = container.containerId;
  const name = container.name;
  const running = container.state === "running";

  async function run(
    mutation: { mutateAsync: (containerId: string) => Promise<unknown> },
    done: string,
  ) {
    setBusy(true);
    try {
      await mutation.mutateAsync(id);
      toast.done(done);
    } catch (error) {
      // The service throws docker's stderr as a bare 500, so `errorMessage` answers
      // with its generic 5xx sentence. That no longer claims nothing changed
      // — a refused `docker stop` does leave the container as it was, but
      // a 500 alone cannot tell the console so.
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Menu
        align="end"
        trigger={
          <Button
            size="xs"
            aria-label={`Actions for ${name}`}
            aria-busy={busy || undefined}
          >
            <Icon
              name={busy ? "refresh" : "cog"}
              size={14}
              className={busy ? "animate-spin" : undefined}
            />
            Actions
          </Button>
        }
      >
        <Menu.Group label={name}>
          <Menu.Item
            icon="term"
            disabled={!running || dockFull}
            title={running && dockFull ? DOCK_SHELLS_FULL_SENTENCE : undefined}
            onClick={() => onShell(container)}
          >
            {!running
              ? "Open a shell (not running)"
              : dockFull
                ? "Open a shell (the Dock is full)"
                : "Open a shell"}
          </Menu.Item>
          <Menu.Item icon="eye" onClick={() => onInspect(container)}>
            Inspect it
          </Menu.Item>
          <Menu.Item
            icon="play"
            disabled={busy || running}
            onClick={() => void run(actions.start, `${name} started.`)}
          >
            Start
          </Menu.Item>
          <Menu.Item
            icon="refresh"
            disabled={busy}
            onClick={() => void run(actions.restart, `${name} restarted.`)}
          >
            Restart
          </Menu.Item>
          <Menu.Item
            icon="stop"
            disabled={busy || !running}
            onClick={() => void run(actions.stop, `${name} stopped.`)}
          >
            Stop
          </Menu.Item>
        </Menu.Group>
        <Menu.Separator />
        <Menu.Group label="Without waiting">
          <Menu.Item
            destructive
            disabled={busy || !running}
            onClick={() =>
              void run(
                actions.kill,
                `${name} killed. Whatever it was doing was not finished.`,
              )
            }
          >
            Kill
          </Menu.Item>
          <Menu.Item
            destructive
            disabled={busy}
            onClick={() => setRemoving(true)}
          >
            Remove
          </Menu.Item>
        </Menu.Group>
      </Menu>

      <Modal open={removing} onOpenChange={setRemoving}>
        <Modal.Header
          title={`Remove ${name}?`}
          description="This is docker rm -f — the container stops and then stops existing."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            What happens next depends on what put it here, and Cloudgate cannot
            tell from this listing:
          </p>
          <ul className="flex flex-col gap-1.5 text-body text-tx-2">
            <li>
              If a Swarm service owns it, Swarm replaces it within seconds under
              a new name. Removing it is a restart with extra steps.
            </li>
            <li>
              If nothing owns it, it is gone. Anything written inside it and not
              in a volume goes with it.
            </li>
          </ul>
          <p className="text-meta text-tx-3">
            Volumes are never touched by this, whichever of the two it is.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button>Cancel</Button>} />
          <Button
            variant="dngr"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={async () => {
              setRemoving(false);
              await run(actions.remove, `${name} removed.`);
            }}
          >
            Remove it
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
