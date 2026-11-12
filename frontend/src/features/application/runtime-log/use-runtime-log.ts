import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { LiveLog } from "@/lib/realtime/live-log";
import {
  useLiveLog,
  type SocketStream,
} from "@/lib/realtime/use-socket-stream";

import {
  NO_RUNTIME_LOG,
  RuntimeLogPoll,
  type RuntimeLogState,
} from "./runtime-log-poll";

/** The page card's read of a cloud Service's Runtime log. */
export interface RuntimeLog extends RuntimeLogState {
  /** The Live log's view: its following flag, live or ended, and `log`. */
  stream: SocketStream;
  /**
   * Build a new Live log owned by the page, with its own poll — the page
   * note's **Read it here too** once its log has gone to the Dock.
   */
  readHereToo: () => void;
}

/** What a cloud Service's Runtime log is, as a Live log's key. */
export function runtimeLogKey(applicationId: string): string {
  return `runtime-log:${applicationId}`;
}

const subscribeNothing = () => () => {};
const getNothing = () => NO_RUNTIME_LOG;

/**
 * A cloud Service's Runtime log, polled ({@link RuntimeLogPoll}) and held in
 * a Live log the page's card builds and this reads, as `useSocketStream` does
 * for a socket log. The page's own poll runs whether or not anyone looks —
 * only a docked log pauses off screen.
 *
 * Unmounting disposes the Live log **only while the page holds it**: a docked
 * log is the Dock's to end, and the page leaves it alone.
 */
export function useRuntimeLog(
  applicationId: string,
  enabled: boolean,
): RuntimeLog {
  const key = runtimeLogKey(applicationId);
  const [live, setLive] = useState<{
    log: LiveLog;
    poll: RuntimeLogPoll;
  } | null>(null);
  // A new generation is a new Live log under the same key — Read it here too.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const poll = new RuntimeLogPoll();
    const log = new LiveLog(key, "page", { source: poll });
    // The Live log is an external resource with a teardown, so it is made
    // here and not in a state initialiser: React runs an initialiser twice in
    // development and keeps one, and the other would be a poll nothing stops.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLive({ log, poll });
    return () => {
      if (log.owner === "page") log.dispose();
    };
  }, [key, generation]);

  const target = enabled ? applicationId : null;
  useEffect(() => {
    if (!live || live.log.owner !== "page") return;
    live.log.open(target);
    return () => {
      if (live.log.owner === "page") live.log.hangUp();
    };
  }, [live, target]);

  const state = useSyncExternalStore(
    live?.poll.subscribe ?? subscribeNothing,
    live?.poll.getState ?? getNothing,
    getNothing,
  );
  const stream = useLiveLog(live?.log ?? null);
  const readHereToo = useCallback(() => setGeneration((was) => was + 1), []);

  return { ...(enabled ? state : NO_RUNTIME_LOG), stream, readHereToo };
}
