import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { LiveLog, NO_LOG } from "./live-log";
import type { LiveLogSnapshot } from "./live-log";
import type { LogResumeKind } from "./log-resume";
import { gatewayUrl } from "./socket-stream-store";
import type {
  DialParams,
  SocketStatus,
  SocketStreamSnapshot,
} from "./socket-stream-store";

export type { SocketStatus, SocketStreamSnapshot };

/** Lines held before the oldest start falling off. A long build fits. */
const DEFAULT_CAP = 5_000;

export interface SocketStreamOptions {
  /** The gateway's path, e.g. `/listen-deployment`. */
  path: string;
  /** Query parameters the gateway reads off the URL. */
  params?: DialParams;
  /**
   * Added to the first dial each time the connection opens — `enabled` turning
   * on, or a change of target — and to no backoff redial after it. Read when
   * the connection opens, so a change on its own never redials.
   * `/listen-server-setup`'s start flag is the one user (ADR-0058).
   */
  firstDialParams?: DialParams;
  /**
   * `false` holds the connection closed. Use it while an id is still loading —
   * the alternative is dialling with `undefined` in the query string, which the
   * gateways answer by closing with code 4000.
   */
  enabled?: boolean;
  /**
   * What the log is — "this Deployment", "this container" — as the Live log's
   * key. A change is a different log. Defaults to the gateway URL, which makes
   * every change of `path` or `params` a different log.
   */
  logKey?: string;
  /**
   * How the log picks up after its socket drops once docked — see `LiveLog`.
   * Read once per Live log, like `cap`.
   */
  resume?: LogResumeKind;
  /** How many lines to keep. Read once per Live log. */
  cap?: number;
  /**
   * Take the frames raw instead of buffering them into lines. Terminals need
   * this (escape sequences do not survive being split), and so does anything
   * whose frames are JSON rather than text. Keep it stable — a new identity
   * re-registers the handler, though it never costs a reconnect.
   */
  onFrame?: (frame: string) => void;
}

export interface SocketStream extends LiveLogSnapshot {
  /** Write to the gateway. `false` if the socket was not open. */
  send: (data: string) => boolean;
  setFollowing: (following: boolean) => void;
  clear: () => void;
  /** Dial again now, from the top of the backoff. */
  reconnect: () => void;
  /** `reconnect`, with `params` added to that one dial only. */
  reconnectOnce: (params?: DialParams) => void;
  /**
   * The Live log this reads, `null` for the render before it is built. What a
   * Dock control hands over; the page holds it until then.
   */
  log: LiveLog | null;
}

/** A page's own log box: a {@link SocketStream} and a way to start afresh. */
export interface PageLogStream extends SocketStream {
  /**
   * Build a new Live log owned by the page, with its own connection — the
   * page note's **Read it here too** once its log has gone to the Dock. The
   * docked one is the Dock's and carries on.
   */
  readHereToo: () => void;
}

/**
 * One live connection to one gateway, held in a {@link LiveLog} the page's
 * box builds and this reads.
 *
 * The socket lives outside React, and this subscribes to it. That is not
 * ceremony: a build emits hundreds of frames a second, and driving that through
 * `setState` would re-render on every one.
 *
 * A new `logKey` is a different log, so a new Live log. Changing `path`,
 * `params` or `enabled` under the same key hangs the old socket up and dials the
 * new target into the same Live log. Unmounting disposes the Live log **only
 * while the page holds it** (`owner === "page"`): a docked log is the Dock's to
 * end, and the page leaves it alone.
 */
export function useSocketStream(options: SocketStreamOptions): PageLogStream {
  const {
    path,
    params,
    enabled = true,
    cap = DEFAULT_CAP,
    onFrame,
    firstDialParams,
    resume,
  } = options;

  // A string, so this is stable by value — the effects below act only when the
  // target genuinely changes, whatever identity `params` has this render.
  const url = gatewayUrl(path, params);
  const key = options.logKey ?? url;
  const target = enabled ? url : null;

  // `cap` is read once per Live log — a buffer that resized would have to
  // decide what to throw away, and no caller wants that decided mid-stream.
  const capRef = useRef(cap);
  const resumeRef = useRef(resume);

  // The Live log is an external resource with a teardown, so it is made in an
  // effect and not a state initialiser: React runs an initialiser twice in
  // development and keeps one, and the other would be a log nothing disposes.
  const [live, setLive] = useState<LiveLog | null>(null);
  // A new generation is a new Live log under the same key — Read it here too.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const log = new LiveLog(key, "page", {
      cap: capRef.current,
      resume: resumeRef.current,
    });
    setLive(log);
    return () => {
      if (log.owner === "page") log.dispose();
    };
  }, [key, generation]);

  useEffect(() => {
    live?.setFrameHandler(onFrame);
  }, [live, onFrame]);

  // Read through a ref, not listed as a dependency: these ride on the dial the
  // target opens with, and are no reason to open one.
  const firstDial = useRef(firstDialParams);
  useEffect(() => {
    firstDial.current = firstDialParams;
  });

  useEffect(() => {
    if (!live || live.owner !== "page") return;
    live.open(target, firstDial.current);
    return () => {
      if (live.owner === "page") live.hangUp();
    };
  }, [live, target]);

  const stream = useLiveLog(live);
  const readHereToo = useCallback(() => setGeneration((was) => was + 1), []);
  return { ...stream, readHereToo };
}

const subscribeNothing = () => () => {};
const getNothing = () => NO_LOG;
const NOOP = () => {};

/**
 * A Live log, read from React: its snapshot and its bound methods, in the
 * `SocketStream` shape every log box takes. Only reads — whoever holds the log
 * (`LiveLog.owner`) ends it.
 */
export function useLiveLog(live: LiveLog | null): SocketStream {
  const snapshot = useSyncExternalStore(
    live?.subscribe ?? subscribeNothing,
    live?.getSnapshot ?? getNothing,
    live?.getServerSnapshot ?? getNothing,
  );

  return {
    ...snapshot,
    // Bound on the instance, so these are stable across renders.
    send: live?.send ?? (() => false),
    setFollowing: live?.setFollowing ?? NOOP,
    clear: live?.clear ?? NOOP,
    reconnect: live?.reconnect ?? NOOP,
    reconnectOnce: live?.reconnectOnce ?? NOOP,
    log: live,
  };
}
