import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import type { LiveTerminal } from "./live-terminal";

/**
 * The well a session's emulator is shown in — on a page, or in the Dock.
 *
 * Behind the terminal's lazy boundary, and the reason the stylesheet is
 * imported here: xterm's CSS is part of what opening a Server must not
 * download (`terminal.tsx`). The Dock reaches it through `next/dynamic` too.
 *
 * **The frame's height comes from CSS** — the caller's `className` — because
 * the grid is measured off this box, and a box the terminal sized would feed
 * its own observer (`terminal-emulator.ts`). Mounting is lending the emulator's
 * element to this frame; unmounting hands it back without ending anything, which
 * is what lets the Dock take a page's session with its scrollback.
 */
export default function TerminalWell({
  session,
  className,
}: {
  session: LiveTerminal;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!frame.current) return;
    return session.emulator.mount(frame.current);
  }, [session]);

  // The well, in both themes.
  return (
    <div
      ref={frame}
      className={cn("overflow-hidden bg-well p-2.5", className)}
    />
  );
}
