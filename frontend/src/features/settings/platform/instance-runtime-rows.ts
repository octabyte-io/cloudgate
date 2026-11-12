import type { Probe, RuntimeInfo } from "@/lib/api/endpoints/settings";

/**
 * `GET /settings/runtime-info` for the platform host, folded into rows.
 *
 * Its own module for the reason `swarm-values.ts` is: this is a **table**
 * rather than a component — ten readings as data, the two groups they fall
 * into, and the three pure functions that word them — and `instance-runtime-
 * card.tsx` beside it is the component that draws them. Keeping them in one
 * file put a card over §1.5's 400 lines with nothing in it that was a card.
 *
 * ## The grouping is the payload's, not this file's
 *
 * Every probe carries `scope`, because a Server whose every shell
 * probe timed out still answered a confident `postgres.observed` — a positive
 * signal pointing at the wrong machine, which is worse than a missing one. The
 * guarantee that buys is that **no consumer carries a list of which keys are
 * the exceptions**, and `reading()` below is where this file keeps it: the
 * `scope` on every row is copied off the probe it read.
 *
 * The literal `scope` on each `ROWS` entry is the fallback for the **one state
 * that has no document**: a 403 refuses before anything is probed, so there is
 * no payload to ask and the card's own layout is all that is left to lay the
 * rows out by. `read()` overwrites it the moment a document exists.
 *
 * ## `docker.drift` is true on virtually every install and means nothing
 *
 * `server-setup.ts`'s `installDocker` pins a Server's Docker with
 * `--version $DOCKER_VERSION`;
 * `deploy/install.sh:177` installs **this** machine's with a bare
 * `curl … | sh` and no `--version` at all. So `docker.declared` is not a
 * declaration about the host these rows describe, and rendering the drift the
 * payload reports would put a warning on nearly every instance that nobody can
 * act on — the fastest way to teach a reader that this card's warnings are
 * decoration.
 *
 * Rejected: suppressing it silently (the reader is then owed an explanation the
 * screen never gives), and dropping the Docker row (it is the first reading
 * the shared read names). What happens instead is that Docker goes through
 * `reading` and not `compared`, so it has **no declared side at all**, and the
 * card's footer says why — the row has nothing to compare against, which is a
 * fact about the install rather than a value withheld.
 *
 * **Traefik is the opposite, and the asymmetry is the proof this is not
 * laziness.** `install.sh:33` and `server-setup.ts`'s exported
 * `TRAEFIK_VERSION` read the *same* environment variable, and `install.sh:534`
 * starts the container from it — so a Traefik drift on this host is a real,
 * actionable disagreement (the pin moved, the container was never recreated) and
 * is the one row that renders one.
 *
 * ## What is deliberately not a row
 *
 * `cloudgate.version` and `cloudgate.releaseTag` are the identity card's, one
 * card up, off `/settings/version` and `/settings/release-tag`. A second
 * reading of the same constant from a second route is a disagreement waiting to
 * be rendered — `DockerAside` states that rule for the Docker version and it
 * applies here. `directory` is the maintenance section's disk-usage card, and
 * it is also the one member of the payload with no `scope`: it scopes itself by
 * publishing its `path`, so it has no group to sit in on a card built out of
 * this distinction.
 */

export type Scope = "host" | "process";

/**
 * The two groups, in the order they are read.
 *
 * The heading is what makes `scope` visible; the gloss under it is what makes
 * it *mean* something. "The same whichever Server you open" is the sentence a
 * reader needs in order not to take `Postgres` for a database on this machine,
 * which is the misreading this guards against.
 */
export const GROUPS: ReadonlyArray<{
  scope: Scope;
  heading: string;
  gloss: string;
}> = [
  {
    scope: "host",
    heading: "This machine",
    gloss:
      "Read off the platform host itself — the machine Cloudgate is installed on.",
  },
  {
    scope: "process",
    heading: "The Cloudgate process",
    gloss:
      "About the backend answering this page rather than the machine under it, and the same whichever Server you open.",
  },
];

/** One row: what it is called, which machine it is about, and its reading. */
export type Row = {
  label: string;
  scope: Scope;
  /** The reading in words, or null — nothing observed, or nothing asked. */
  observed: string | null;
  /** The pin to print beside it, only where the two disagree. */
  drift: string | null;
  /** A literal worth copying — a version, a kernel string, a name. */
  mono?: boolean;
};

type RowSpec = Omit<Row, "observed" | "drift"> & {
  read: (
    info: RuntimeInfo,
  ) => Pick<Row, "scope" | "observed" | "drift"> & Partial<Pick<Row, "mono">>;
};

export const ROWS: readonly RowSpec[] = [
  {
    label: "Docker",
    scope: "host",
    mono: true,
    // `reading`, not `compared`: nothing declares this machine's Docker, so the
    // payload's `drift` is not a disagreement anyone can act on. The footer is
    // where the reader is told that, not this comment.
    read: (info) => reading(info.docker, (version) => version),
  },
  {
    label: "Ingress",
    scope: "host",
    // Named the way the two Server tabs name it, so a reader moving between
    // screens meets the same row rather than a second vocabulary for Traefik.
    read: (info) =>
      compared(
        info.traefik,
        (version) => `Traefik ${version}`,
        (version) => version,
      ),
  },
  {
    label: "Swarm",
    scope: "host",
    read: (info) => reading(info.swarm, (state) => state),
  },
  {
    label: "Overlay network",
    scope: "host",
    read: (info) => ({
      // `false` is a reading and not a missing one — the network is *known* to
      // be absent, which is a different sentence from "not known".
      ...reading(info.cloudgateNetwork, (there) =>
        there ? "cloudgate-network" : "not created",
      ),
      // The name is a literal worth copying; "not created" is a sentence.
      mono: info.cloudgateNetwork.observed === true,
    }),
  },
  {
    label: "Operating system",
    scope: "host",
    read: (info) => reading(info.operatingSystem, (name) => name),
  },
  {
    label: "Kernel",
    scope: "host",
    mono: true,
    read: (info) => reading(info.kernel, (name) => name),
  },
  {
    label: "Up for",
    scope: "host",
    read: (info) => reading(info.uptimeSeconds, upFor),
  },
  {
    label: "Node",
    scope: "process",
    mono: true,
    read: (info) => ({
      scope: info.cloudgate.scope,
      observed: info.cloudgate.node,
      drift: null,
    }),
  },
  {
    label: "Postgres",
    scope: "process",
    mono: true,
    read: (info) => reading(info.postgres, (version) => version),
  },
  {
    // The same label as the machine's, one group down, and that is the point: a
    // backend two hours old on a host up six weeks is two true answers to what
    // looks like one question. It is the last row of each group so the two land
    // next to each other rather than a column apart.
    label: "Up for",
    scope: "process",
    read: (info) => ({
      scope: info.cloudgate.scope,
      observed: upFor(info.cloudgate.uptimeSeconds),
      drift: null,
    }),
  },
];

/** The rows for a document, or the same rows emptied when there is none. */
export function rowsOf(info: RuntimeInfo | undefined): Row[] {
  return ROWS.map(({ read, ...row }) =>
    info ? { ...row, ...read(info) } : { ...row, observed: null, drift: null },
  );
}

/** One probe, with no declared side to compare it against. */
function reading<T>(
  probe: Probe<T>,
  read: (value: T) => string,
): Pick<Row, "scope" | "observed" | "drift"> {
  return {
    // The payload's, always — never inferred from which key this came out of.
    scope: probe.scope,
    observed: probe.observed === null ? null : read(probe.observed),
    drift: null,
  };
}

/** One probe whose declared side is a claim about *this* host, so it counts. */
function compared<T>(
  probe: Probe<T>,
  read: (value: T) => string,
  /**
   * The declared side, worded for the note it sits in rather than for the row.
   * Separate from `read` because the note already follows the word "declared"
   * and the value has already been named: `declared Traefik 3.6.7` says Traefik
   * twice, which is how the first draft of this rendered.
   */
  pin: (value: T) => string,
): Pick<Row, "scope" | "observed" | "drift"> {
  return {
    ...reading(probe, read),
    // Only where both sides are known and disagree — the backend never guesses
    // `drift`, so the null check is for the type rather than for the logic.
    // Printing "declared 3.6.7" beside an observed 3.6.7 is noise on every
    // healthy install, and it is what stops the one row that matters being
    // scannable.
    drift: probe.drift && probe.declared !== null ? pin(probe.declared) : null,
  };
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "41d 6h", "6h 20m", "20m 04s", "45s" — how long something has been up.
 *
 * `lib/format/time.ts`'s `timeTaken` is the same shape and is deliberately not
 * reused: it takes two stamps rather than a count of seconds, and it tops out
 * at hours, which reads "984h 12m" for a machine up six weeks — the single
 * figure the `Up for` row exists to show. Two units at most and padded minutes
 * are that file's rules, kept here.
 *
 * `lib/api/use-server-metrics.ts`'s `uptimeReading` is the closer sibling —
 * seconds in, uptime words out, already on `lib/`'s shelf and already read by
 * two features — and it is not reused for one reason: it returns a *single*
 * unit ("41 days", "2 hours"). That is right where it is used, a figure beside
 * a chart, and wrong here. This row's whole job is to be read against the row
 * one group down, and "41 days" against "2 hours" loses the contrast that "41d
 * 6h" against "2h 00m" makes immediately. Widening `uptimeReading` with a mode
 * flag was the alternative: it would change a function two other features
 * render, to serve a third, and a boolean parameter that switches a format is
 * the shape §1.4 is trying to prevent rather than an instance of the reuse it
 * asks for.
 *
 * It stays in this feature because one feature reads it; §1.4's promotion rule
 * is about the *second* one.
 */
function upFor(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < MINUTE) return `${whole}s`;
  if (whole < HOUR) {
    return `${Math.floor(whole / MINUTE)}m ${pad(whole % MINUTE)}s`;
  }
  if (whole < DAY) {
    return `${Math.floor(whole / HOUR)}h ${pad(Math.floor((whole % HOUR) / MINUTE))}m`;
  }
  return `${Math.floor(whole / DAY)}d ${Math.floor((whole % DAY) / HOUR)}h`;
}

/** So a column of durations lines up rather than jittering by a character. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
