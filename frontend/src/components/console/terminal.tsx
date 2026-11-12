import dynamic from "next/dynamic";

import { Skeleton } from "@/components/console/skeleton";

import { terminalKey, type TerminalTarget } from "./terminal-target";

export type { TerminalTarget } from "./terminal-target";
export { targetNoun } from "./terminal-target";

/**
 * **One terminal, two gateways.** A shell on a Server (`/terminal`) and a
 * `docker exec` inside a container (`/docker-container-terminal`) differ in the
 * socket's URL and in the words naming the target, and in nothing else — which
 * is the F13 brief's instruction and is also just true of them.
 *
 * This file is the `next/dynamic` boundary and `ssr: false` is load-bearing twice
 * over: xterm touches `document` while it is being constructed, and it is by far
 * the largest thing in the console at roughly a quarter of a megabyte. Behind this
 * split, **opening a Server does not download its terminal** — the same promise
 * F12 made for the compose editor and verified in a production build.
 *
 * A session is a `LiveTerminal` (`live-terminal.ts`): a `TerminalChannel` for the
 * socket and a `TerminalEmulator` for xterm, both owned outside React so the
 * session can change hands. `terminal-session.tsx` holds a page's, and gives it
 * a **Dock** control that moves it — same socket, same scrollback — into the
 * console layout's docked panel. `terminal-view.tsx` is the frame,
 * `terminal-well.tsx` the box the emulator is shown in, and `terminal-theme.ts`
 * turns our `oklch()` tokens into colours xterm can parse. Read the note at the
 * top of the emulator before changing the grid: it is whatever the frame holds,
 * and the Server is told so over the socket's one control frame.
 *
 * A terminal is a privileged surface, so two rules are the component's and not the
 * caller's: it names its host or container **at all times** (`terminal-target.ts`),
 * and a session that has ended says so where the cursor was rather than sitting
 * there looking idle.
 */

const TerminalSession = dynamic(() => import("./terminal-session"), {
  ssr: false,
  loading: () => <TerminalPending />,
});

/**
 * The frame before the session's chunk has arrived: the well at exactly the
 * height the emulator will be — the same expression the view gives the frame —
 * so nothing jumps when it arrives. A terminal box that grows under the pointer
 * is one people click through, and here it would also change the grid it lands
 * on.
 */
export function TerminalPending() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-panel">
      <Skeleton className="h-thead w-full rounded-none" />
      <div className="h-[min(65vh,28rem)] bg-well" aria-busy="true" />
    </div>
  );
}

export function Terminal({
  target,
  footer,
}: {
  target: TerminalTarget;
  /** Replaces the default sentence under a connected session. */
  footer?: React.ReactNode;
}) {
  // Keyed on the target, so pointing this at a different host tears the old
  // session down and builds a new one rather than re-attaching the emulator
  // (`terminalKey` says why).
  return (
    <TerminalSession key={terminalKey(target)} target={target} footer={footer} />
  );
}
