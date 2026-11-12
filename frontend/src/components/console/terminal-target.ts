import type { ContainerShell } from "@/lib/realtime/gateways";

/**
 * What a terminal is attached to — re-exported from `terminal.tsx`, and here
 * rather than there so the Dock, which is not behind the terminal's
 * lazy boundary, can name a session without importing it.
 *
 * A terminal is a privileged surface, so naming the target is the component's
 * rule and not the caller's: it names its host or container **at all times**,
 * in a page's frame and in the Dock's header alike.
 */
export type TerminalTarget =
  | {
      kind: "server";
      /** `"local"` reaches the host the platform itself runs on. */
      serverId: string;
      name: string;
      /** `user@host:port`. On screen permanently — see above. */
      address: string;
    }
  | {
      kind: "container";
      containerId: string;
      /** The Server it is on, or `null` for the platform's own host. */
      serverId: string | null;
      /**
       * The stack whose Stack VM it is on (ADR-0070), reached by the stack
       * rather than a Server; absent everywhere else.
       */
      composeId?: string;
      name: string;
      /** What to call the machine in the frame: a Server's name, or "this host". */
      host: string;
      /** `sh` unless the caller knows better. The gateway rejects anything else. */
      shell?: ContainerShell;
      /**
       * The Service this container runs, when the shell was opened from it —
       * the Service's Shell tab. The Dock's header then names the Service the way
       * the console does everywhere else (`storefront · production · Demo
       * Shop`) rather than by a Swarm task name like `app-9uiusu.1.…`, which
       * changes on every deploy.
       */
      service?: { name: string; environment: string; project: string };
    };

/**
 * What to call this session's far end inside a sentence.
 *
 * `CONTEXT.md` keeps **Server** for a `server` row and lists *host* under its
 * *Avoid*, while the machine Cloudgate runs on is "this host" everywhere it
 * appears — `local-shell-card.tsx`'s own card header says so. `TerminalStatus`
 * is shared by both branches and hardcoded "the Server", so a refused session on
 * the *This host* card read "The Server refused this session" directly under a
 * heading saying the machine has no Server row (the same rule
 * `features/monitoring/container-targets.ts`'s `targetNoun` states).
 *
 * That other `targetNoun` stays where it is: it answers the same question for a
 * different type (`ContainerTarget`, `id === null`), and merging the two would
 * mean inventing a shared shape for two unrelated unions. Two three-line
 * functions stating one rule, each next to its own type, is the right amount of
 * duplication — which is why each cites the other.
 */
export function targetNoun(target: TerminalTarget): string {
  if (target.kind === "container") return "the container";
  return target.serverId === "local" ? "this host" : "the Server";
}

/**
 * The session's name in a line of its own — the Dock's tab and its `+`
 * menu.
 *
 * A Service as `storefront · production · Demo Shop` (Service · Environment ·
 * Project, the order the scope rail reads them in), a container as `container
 * <name> on <host>`, a Server as `Server <name>`, and the platform's own as
 * "This host" — never "Server", since it has no Server row.
 */
export function terminalTitle(target: TerminalTarget): string {
  if (target.kind === "container") {
    const { service } = target;
    if (service) {
      return `${service.name} · ${service.environment} · ${service.project}`;
    }
    return `container ${target.name} on ${target.host}`;
  }
  return target.serverId === "local" ? "This host" : `Server ${target.name}`;
}

/** The emulator's accessible name: "Shell on web-1", "Shell inside api.1.x". */
export function terminalLabel(target: TerminalTarget): string {
  return target.kind === "server"
    ? `Shell on ${target.name}`
    : `Shell inside ${target.name}`;
}

/**
 * One string per distinct session a target asks for. A change of it tears a
 * page's session down rather than re-pointing a live emulator at another
 * machine — a terminal that kept its scrollback across a change of machine
 * would show one host's output under another host's name.
 */
export function terminalKey(target: TerminalTarget): string {
  return target.kind === "server"
    ? `server:${target.serverId}:${target.address}`
    : `container:${target.serverId ?? "local"}:${target.containerId}:${target.shell ?? "sh"}`;
}
