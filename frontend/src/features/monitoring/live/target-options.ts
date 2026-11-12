import type { PickerOption } from "@/components/console/picker";
import type { ContainerListItem } from "@/lib/api/endpoints/docker";

/** The gateway's own magic value for "sample the host, not a container". */
export const HOST = "cloudgate";

/**
 * What the picker can point the stream at.
 *
 * **The target is picked from Docker's own listing**, and that is still the only
 * honest source here even though an Environment can now name its services
 * This card starts from
 * a **host**, and the new read runs the other way: it answers "what is in this
 * Environment", and nothing answers "which Environment is this container in".
 * Getting from a host to a set of services would mean walking every Project and
 * every Environment in the Organization to find the ones that landed on it. So the
 * names are Docker's, with no idea which Project each belongs to — exactly as
 * F13's delete dialog says of the same read.
 *
 * `appName: "cloudgate"` is the special value that samples **the host itself**
 * rather than a container, through `HostStatsService`. That path reads
 * `/proc/stat`, `/proc/meminfo` and `/proc/diskstats` — and on a platform host
 * that is not Linux **it does not fail**. `parseServerStats` defaults every field
 * to 0, so the socket delivers a perfectly well-formed frame reporting 0% CPU and
 * 0.00GiB of 0.00GiB memory. Verified by opening the socket by hand and reading
 * the frame. `isUnmeasured` is what stops that being drawn as an idle machine.
 */
export function targetOptions(
  containers: readonly ContainerListItem[],
): PickerOption[] {
  return [
    { value: HOST, label: "This host itself" },
    ...containers
      .filter((row) => row.state === "running")
      /**
       * **The value is Docker's full name; the label is the readable part of it.**
       * A Swarm task is `redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09` — 41
       * characters, of which the service name and the replica index are the only
       * ones anyone reads. The whole string stays as the value, because that is
       * what the gateway matches on and two replicas of one service are two
       * different containers.
       *
       * **The task id is dropped from the label, and the first attempt kept it
       * and was worse than no split at all.** `Picker` renders `detail`
       * `flex-none` beside a `truncate` label, which is right for a commit sha or
       * a port — so a 39-character detail took the whole row and truncated the
       * *label* to nothing: every Swarm container read as `.1.vh5l2ai…` with no
       * name at all. The subordinate half has to be the short one. Found by
       * opening the popup and looking at it, twice.
       */
      .map((row) => {
        const [, replica] = row.name.split(".");
        return replica === undefined
          ? { value: row.name, label: serviceOf(row.name) }
          : {
              value: row.name,
              label: serviceOf(row.name),
              detail: `.${replica}`,
            };
      }),
  ];
}

/**
 * The readable half of a Docker name: the service, without the replica index and
 * the task id. `app-t64tnx.1.kyc0lqth6ncv0zuarpvdcno09` → `app-t64tnx`, and a
 * name with no dot in it is already that.
 *
 * Exported because the picker's label and the card's heading are the same
 * question asked twice, and a second spelling of this split is the shape that
 * drifted in the first place — see `liveTargetCopy`.
 */
export function serviceOf(name: string): string {
  return name.split(".")[0] || name;
}

/** Everything the live card says about what it is showing. */
export interface LiveTargetCopy {
  /** The card's heading. */
  title: string;
  /** The line under the heading. */
  sub: string;
  /** The caption under the Network tile's `in / out` pair. */
  networkDetail: string;
  /**
   * The hint under a refused stream, and under one that ended in silence —
   * where the figures would have come from, and so what to go and check.
   */
  streamHint: string;
}

/**
 * **What the card says it is showing — in one place, because it says it four
 * times**.
 *
 * The card carries three pieces of copy about its subject: a heading, the line
 * under it, and the caption on the Network tile. All three were constants
 * describing *the host*, while the picker beside them chooses between the host
 * and any container running on it — so two of the three were wrong whichever
 * target was selected:
 *
 * - On a **container** target the card still read `This host` over "The machine
 *   Cloudgate runs on", above figures that were entirely the container's.
 * - On the **host** target — the card's default — the Network pair was captioned
 *   "in / out, since this container started". There is no container: for this
 *   target the gateway takes `hostStats.collect()` rather than `docker stats`,
 *   and the pair is `/proc/net/dev` rx/tx summed across every NIC, which runs
 *   from **boot**. Measured on a box at 29 days of uptime against a four-week-old
 *   container, so the caption was out by four weeks and nothing on screen said so.
 *
 * The Disk tile is the one piece of the card that *did* branch, which is what the
 * other three drifted away from. So the target is the argument here and the
 * strings are one return value: a further site cannot fall out of step with the
 * rest, and fixing a caption without fixing the heading is no longer possible.
 *
 * **`streamHint` is the fourth**, and it is here rather than left in
 * `LiveReadings` because it was the same branch written a second way — the
 * `/proc` sentence for the host, the "the container stopped" one otherwise. It
 * was already correct, which is the point: keeping it separate meant the card
 * fetched its target-dependent copy from two places, and one of them could be
 * changed without the other. It is also what lets `LiveReadings` take the copy
 * as a prop rather than re-deriving it, so there is genuinely one call per
 * render (`live-card.tsx`).
 *
 * **The host's caption is a sentence the product already had.** `ServerFigures`
 * draws the same `/proc/net/dev` pair for a Server, on this same screen, under
 * "total since boot, not a rate". Inventing a second wording for one measurement
 * is how a reader ends up wondering whether the two cards mean different things.
 * Only the tile's `in / out` is kept in front of it, because this card shows the
 * pair in one tile where the per-Server card gives each direction its own.
 *
 * `collecting` reaches the **host** subtitle only: whether a container's samples
 * are stored is the include list's answer, and `ContainerHistory` gives it in
 * full underneath this card. A caller that only wants the caption can leave it
 * off.
 */
export function liveTargetCopy(
  target: string,
  collecting = false,
): LiveTargetCopy {
  if (target === HOST) {
    return {
      title: "This host",
      sub: collecting
        ? "The machine Cloudgate runs on — streamed live, and stored on an interval."
        : "The machine Cloudgate runs on, streamed live while this card is open.",
      networkDetail: "in / out, total since boot, not a rate",
      streamHint:
        "Sampling the host itself reads /proc/stat, /proc/meminfo and /proc/diskstats, so it only works where Cloudgate runs on Linux. A container's own figures come from docker stats and work anywhere.",
    };
  }

  return {
    title: serviceOf(target),
    // The whole Docker name, which is the one place on this card it is readable:
    // the picker's label drops the task id and two replicas of one service are
    // two different containers.
    sub: `The container ${target} on the machine Cloudgate runs on, streamed live while this card is open.`,
    networkDetail: "in / out, since this container started",
    streamHint:
      "That usually means the container stopped between this list being read and the sample being taken.",
  };
}
