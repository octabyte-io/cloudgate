import { useSyncExternalStore } from "react";

import { useTerminalChannel, type TerminalStream } from "@/lib/realtime/gateways";

import type { LiveTerminal } from "./live-terminal";
import type { EmulatorSnapshot } from "./terminal-emulator";

const NOT_READY: EmulatorSnapshot = { ready: false, grid: null };

/**
 * A live session, read from React: its socket's state and its emulator's grid.
 * Only reads — whoever holds the session (`LiveTerminal.owner`) ends it.
 */
export function useLiveTerminal(session: LiveTerminal): {
  stream: TerminalStream;
  grid: EmulatorSnapshot["grid"];
} {
  const stream = useTerminalChannel(session.channel);
  const { grid } = useSyncExternalStore(
    session.emulator.subscribe,
    session.emulator.getSnapshot,
    () => NOT_READY,
  );
  return { stream, grid };
}
