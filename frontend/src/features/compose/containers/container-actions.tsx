import { useState } from "react";

import { Menu } from "@/components/console/menu";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";

import { useContainerActions, type StackContainer } from "./use-stack-containers";

/**
 * Start, restart, stop or kill one container of a stack.
 *
 * A menu rather than four buttons per row, because four rows of four buttons is
 * sixteen controls competing for the eye and only one of them is ever the right
 * one. **Kill is separated and marked destructive**: stop is `SIGTERM` and a chance
 * to shut down, kill is `SIGKILL` — a database in the middle of a write does not
 * get to finish it.
 *
 * A row with no container gets no menu. There is nothing to aim these at: the
 * lifecycle routes take a container id, and the container this row is about does
 * not exist. Deploying the stack is what creates it, and the tab says so.
 *
 * **A stack on its own Stack VM gets no menu either** (ADR-0070, #1357
 * review). The container routes take a Server, and a Stack VM is never one:
 * with no Server they would reach this Cloudgate host's daemon, not the
 * stack's. Its containers restart together, through its tunnel, with the
 * stack's own Restart, which this row points at instead.
 */
export function ContainerActions({
  container,
  serverId,
  onStackVm = false,
  onLogs,
}: {
  container: StackContainer;
  serverId: string | null;
  /** The stack runs on its own Stack VM, which these routes cannot reach. */
  onStackVm?: boolean;
  /** Open this container's output. The Logs tab is where it streams. */
  onLogs: (container: StackContainer) => void;
}) {
  const actions = useContainerActions();
  const [running, setRunning] = useState<string | null>(null);

  if (onStackVm) {
    return (
      <span className="text-meta text-tx-3">Restart the stack instead</span>
    );
  }

  if (container.containerId === null) {
    return (
      <span className="text-meta text-tx-3">
        Deploy the stack
      </span>
    );
  }

  const containerId = container.containerId;
  const busy = running !== null;
  const name = container.service ?? container.name;

  const run = async (
    verb: string,
    mutation: {
      mutateAsync: (input: {
        containerId: string;
        serverId: string | null;
      }) => Promise<unknown>;
    },
    done: string,
  ) => {
    setRunning(verb);
    try {
      await mutation.mutateAsync({ containerId, serverId });
      toast.done(done);
    } catch (error) {
      // The backend throws docker's stderr as a 500, so `errorMessage` answers
      // with its generic 5xx sentence. That no longer claims nothing changed
      // — a refused `docker stop` does leave the container as it was, but
      // a 500 alone cannot tell the console so.
      toast.error(error);
    } finally {
      setRunning(null);
    }
  };

  return (
    <Menu
      align="end"
      trigger={
        <Button
          size="xs"
          aria-label={`Actions for ${name}`}
          aria-busy={busy || undefined}
        >
          <Icon name={busy ? "refresh" : "cog"} size={14} className={busy ? "animate-spin" : undefined} />
          Actions
        </Button>
      }
    >
      <Menu.Group label={container.name}>
        <Menu.Item icon="term" onClick={() => onLogs(container)}>
          View its output
        </Menu.Item>
        <Menu.Item
          icon="play"
          disabled={busy}
          onClick={() =>
            void run("start", actions.start, `${name} started.`)
          }
        >
          Start
        </Menu.Item>
        <Menu.Item
          icon="refresh"
          disabled={busy}
          onClick={() =>
            void run("restart", actions.restart, `${name} restarted.`)
          }
        >
          Restart
        </Menu.Item>
        <Menu.Item
          icon="stop"
          disabled={busy}
          onClick={() =>
            void run("stop", actions.stop, `${name} stopped.`)
          }
        >
          Stop
        </Menu.Item>
      </Menu.Group>
      <Menu.Separator />
      <Menu.Group label="Immediately">
        <Menu.Item
          destructive
          disabled={busy}
          onClick={() =>
            void run(
              "kill",
              actions.kill,
              `${name} killed. Whatever it was doing was not finished.`,
            )
          }
        >
          Kill
        </Menu.Item>
      </Menu.Group>
    </Menu>
  );
}
