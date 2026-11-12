import type { SocketStatus } from "@/lib/realtime/use-socket-stream";

import { thresholdTone } from "../stored-samples";

/**
 * What tone a live percentage wears.
 *
 * **With a stored threshold, the threshold wins** — that is the number that
 * actually notifies, and a bar that turned amber somewhere else would disagree
 * with the alert the operator receives. With none (`0`, or a host with no stored
 * config at all) there is no notification coming, so the fixed ladder is what is
 * left: a reading aid that promises nothing.
 */
export function liveTone(
  percent: number,
  threshold: number,
): "brand" | "warn" | "alarm" {
  if (threshold > 0) return thresholdTone(percent, threshold);
  return percent >= 90 ? "alarm" : percent >= 75 ? "warn" : "brand";
}

/** What the card says while no frame has arrived yet, per socket state. */
export const CONNECTION: Record<SocketStatus, string> = {
  connecting: "Opening the stats stream…",
  open: "Waiting for the first sample…",
  closed: "The stats stream closed.",
  refused: "The stats stream was refused.",
  reconnecting: "Reconnecting to the stats stream…",
  blocked: "The stats stream could not be opened.",
};
