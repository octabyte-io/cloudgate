import { useCallback, useEffect, useRef, useState } from "react";

import type { TraefikPort } from "@/lib/api/endpoints/traefik";

/**
 * What Traefik's container was started with — the three things one card edits.
 */
export type ContainerSettings = {
  env: string;
  ports: TraefikPort[];
  dashboard: boolean;
};

type Field = keyof ContainerSettings;

/** How often the three reads are repeated while a recreation is awaited. */
export const RECREATION_POLL_MS = 1_500;

/**
 * How long a save waits to see its container before saying it has not. The
 * backend pulls Traefik's image before it recreates, so the ~10 s it takes with
 * the image already pulled is not the ceiling.
 */
export const RECREATION_TIMEOUT_MS = 60_000;

type Hold = {
  id: number;
  before: ContainerSettings;
  expected: Partial<ContainerSettings>;
  timedOut: boolean;
};

/**
 * A save to Traefik's container, from the moment the POST returns until a read
 * shows the container it made.
 *
 * The three routes recreate `cloudgate-traefik` **unawaited**: the request
 * answers first and the recreation lands about ten seconds later. So the
 * refetch that follows a save reads the *old* container, and a form that took
 * that as its new baseline showed the value that had just been replaced — and a
 * second Save wrote it back.
 *
 * So a save names what it expects, and each field it changes shows the
 * **expected** value until a read of that field differs from what it said
 * before the save. "Differs from before" rather than "equals what was saved",
 * because the reads do not echo a save: the environment comes back with the
 * image's own `PATH` and with `${{…}}` references resolved, and Docker orders
 * ports its own way. The only thing that changes these reads is a recreation, so
 * a change is the new container, whatever it says.
 *
 * After `RECREATION_TIMEOUT_MS` with no change the hold lets go and the form
 * shows what the container still has, with `late` set so the card can say that
 * this is not what was saved. A later read that does change clears it.
 */
export function useRecreation() {
  const [hold, setHold] = useState<Hold | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const start = useCallback(
    (before: ContainerSettings, expected: Partial<ContainerSettings>) => {
      const next: Hold = {
        id: ++nextId.current,
        before,
        expected,
        timedOut: false,
      };
      if (heldFields(next, before).length === 0) return;
      if (timer.current !== null) clearTimeout(timer.current);
      const { id } = next;
      timer.current = setTimeout(() => {
        setHold((current) =>
          current?.id === id ? { ...current, timedOut: true } : current,
        );
      }, RECREATION_TIMEOUT_MS);
      setHold(next);
    },
    [],
  );

  /**
   * What the card shows, given what the three reads said this render. Called
   * during render: a read that shows the new container ends the hold there and
   * then — adjusting state to what a render observed, React's documented
   * alternative to an effect.
   */
  function view(observed: Partial<ContainerSettings>) {
    const held = hold ? heldFields(hold, observed) : [];
    if (hold !== null && held.length === 0) setHold(null);
    const waiting = hold !== null && !hold.timedOut && held.length > 0;
    const expected = hold?.expected ?? {};

    function show<F extends Field>(field: F): ContainerSettings[F] | undefined {
      if (waiting && held.includes(field)) {
        return expected[field] as ContainerSettings[F];
      }
      return observed[field];
    }

    return {
      /** The value a field shows: the saved one while it is awaited. */
      show,
      /** A save's container has not been seen yet. Every Save waits for it. */
      recreating: waiting,
      /** The wait ran out and the container still reads as before the save. */
      late: hold !== null && hold.timedOut && held.length > 0,
    };
  }

  return {
    /** Repeat the three reads: a save is waiting for its container. */
    polling: hold !== null && !hold.timedOut,
    start,
    view,
  };
}

/**
 * The fields a save changes whose read still says what it said before the save.
 * A field with no read yet counts as still waiting.
 */
function heldFields(
  hold: Hold,
  observed: Partial<ContainerSettings>,
): Field[] {
  return (Object.keys(hold.expected) as Field[]).filter((field) => {
    const expected = hold.expected[field];
    const before = hold.before[field];
    if (expected === undefined || same(field, expected, before)) return false;
    const now = observed[field];
    return now === undefined || same(field, now, before);
  });
}

function same<F extends Field>(
  field: F,
  a: ContainerSettings[F],
  b: ContainerSettings[F],
): boolean {
  if (field === "env") return envKey(a as string) === envKey(b as string);
  if (field === "ports") {
    return portsKey(a as TraefikPort[]) === portsKey(b as TraefikPort[]);
  }
  return a === b;
}

/** Order, blank lines and comments are not part of what the container has. */
function envKey(env: string): string {
  return env
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .sort()
    .join("\n");
}

function portsKey(ports: TraefikPort[]): string {
  return ports
    .map((p) => `${p.publishedPort}:${p.targetPort}/${p.protocol}`)
    .sort()
    .join(",");
}
