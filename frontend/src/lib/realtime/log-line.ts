/**
 * One line of a log as it is drawn — the shape `LogWell` renders and a Live
 * log's source hands over already toned. Here, not beside the well, because
 * the Live log in `lib/realtime` holds lines and must not reach into
 * `components/` for their type (CODING_STANDARDS §3.1); `log-well.tsx`
 * re-exports both types for the boxes that draw them.
 */
export type LogTone = "ok" | "warn" | "bad" | "hl" | "dim";

export type LogLine = {
  /** The timestamp column, already written out. This renders; it does not parse. */
  ts?: string;
  text: string;
  tone?: LogTone;
};
