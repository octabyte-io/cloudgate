import {
  TerminalChannel,
  containerTerminalUrl,
  serverTerminalUrl,
} from "@/lib/realtime/gateways";

import { TerminalEmulator, type XtermKit } from "./terminal-emulator";
import { terminalLabel, type TerminalTarget } from "./terminal-target";

/**
 * Who holds a live session: the page that opened it, or the Dock.
 *
 * The holder is the one that ends it. A page's terminal disposes its session
 * when it unmounts — unless the session has been docked, in which case the page
 * lets go and the Dock ends it when its Close is pressed, or when the console
 * layout itself goes.
 */
export type TerminalOwner = "page" | "dock";

let sequence = 0;

/**
 * One shell session — a socket and the emulator showing it — as a thing that
 * can change hands.
 *
 * Built by whoever opens a shell, `start`ed once, and `dispose`d by whoever
 * holds it last. Nothing here touches React; `use-live-terminal.ts` reads it.
 * Docking is setting `owner` and showing `emulator` in another frame — the
 * socket, the scrollback and whatever the shell is running do not notice.
 */
export class LiveTerminal {
  readonly id = `terminal-${++sequence}`;
  readonly channel = new TerminalChannel();
  readonly emulator: TerminalEmulator;
  owner: TerminalOwner;
  private ended = false;

  constructor(
    readonly target: TerminalTarget,
    owner: TerminalOwner,
    options: { kit?: () => Promise<XtermKit> } = {},
  ) {
    this.owner = owner;
    this.emulator = new TerminalEmulator(this.channel, {
      label: terminalLabel(target),
      kit: options.kit,
    });
  }

  /** Dial the gateway. */
  start(): void {
    if (this.ended) return;
    this.channel.open(terminalUrl(this.target));
  }

  /**
   * End the session: the socket closes, and the gateway reaps the shell's
   * processes behind it — exactly what the container-shell dialog's
   * Close used to do.
   */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    this.channel.close();
    this.emulator.dispose();
  }

  get disposed(): boolean {
    return this.ended;
  }
}

/** The gateway a target dials, or `null` for one that cannot be dialled. */
export function terminalUrl(target: TerminalTarget): string | null {
  if (target.kind === "container") {
    return containerTerminalUrl({
      containerId: target.containerId,
      serverId: target.serverId,
      composeId: target.composeId,
      shell: target.shell,
    });
  }
  const local = target.serverId === "local" ? localDial(target.address) : null;
  return serverTerminalUrl({
    serverId: target.serverId,
    port: local?.port,
    username: local?.username,
  });
}

/**
 * The local Server's dial parameters, read off the address the frame is
 * already showing.
 *
 * `serverId=local` is the one target with no Server row behind it, so the
 * gateway cannot look up a port and an SSH user and requires the caller to send
 * both — it closes `4400 port and username are required for serverId=local`
 * without them, which is why the local terminal was unreachable from this
 * console until then. A port that is present and out of range is that same
 * `4400`, in its own words — which is why the bound below is the gateway's
 * bound and not a looser one.
 *
 * They are taken from `target.address` rather than from fields of their own
 * because that address is the terminal's whole description of the session, is
 * documented as `user@host:port`, and is on screen above the cursor: derived
 * from it, the shell cannot sign in as a user other than the one the frame
 * names. Only the user and the port are read — the *address* of "this host" is
 * the gateway's to resolve, and it does.
 *
 * `null` for anything that is not that shape, which leaves the socket closed
 * rather than dialling one the gateway will refuse.
 */
export function localDial(
  address: string,
): { username: string; port: number } | null {
  const at = address.indexOf("@");
  const colon = address.lastIndexOf(":");
  if (at < 1 || colon <= at + 1) return null;

  const username = address.slice(0, at);
  const port = Number(address.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { username, port };
}
