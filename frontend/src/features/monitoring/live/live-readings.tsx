import { Dash } from "@/components/console/dash";
import { LogRefusal } from "@/components/console/log-refusal";
import { Meter } from "@/components/console/meter";
import { Skeleton } from "@/components/console/skeleton";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import { BLOCKED_SENTENCE, type DockerStatsSample } from "@/lib/realtime/gateways";
import type { SocketStatus } from "@/lib/realtime/use-socket-stream";

import type { LiveTargetCopy } from "./target-options";
import { CONNECTION, liveTone } from "./tone";
import {
  formatBytes,
  gibToBytes,
  memoryPercent,
  percent,
  readingBytes,
} from "./units";

/**
 * The **live** half of the card: one socket frame, drawn.
 *
 * ## What the socket can answer, which is narrower than the phase brief assumed
 *
 * This is `/listen-docker-stats-monitoring`:
 *
 * - **It takes no `serverId`.** The gateway's own comment says "local-host only …
 *   no serverId parameter exists". So it can only ever report on the machine
 *   Cloudgate itself runs on. A remote Server's numbers come from
 *   `GET /monitoring/metrics`, which is what `ServerCard` polls. F13 found this
 *   first and the reasoning is in `endpoints/monitoring.ts`.
 * - **It holds no history you can query.** Every 1300ms it appends to a
 *   288-entry JSON file under `<CLOUDGATE_DIRECTORY>/monitoring/<name>/` —
 *   `/etc/cloudgate` unless this instance was rooted elsewhere
 *   — and pushes back
 *   only the *newest* entry of each series (`getLast`). So there is nothing to
 *   plot from it — a plot would have to be built from frames as they arrive, and
 *   would start empty every time the card mounted. **Meters and figures are the
 *   honest form for a value with no past**, which is why this component has no
 *   chart in it and `HostHistory` next door does.
 * - **This socket raises no threshold notification**, because that is
 *   `ThresholdService` over `server_metric` rows and this writes neither. The claim
 *   is about *this stream*, not about the machine — and the merge is what lets the
 *   card be exact about that: the live meters are toned against the **stored**
 *   config's thresholds, so the number the operator watches turns amber at the
 *   number that will actually notify, and the card's footer says which half does
 *   the notifying.
 *
 * ## Every figure here belongs to the **target**, and so does the copy under it
 *
 * The picker above this chooses between the host and any container on it, and
 * the two are read by different code on the other side of the socket —
 * `hostStats.collect()` out of `/proc` for the host, `docker stats` for a
 * container. The tiles' captions therefore have to branch with the target, which
 * is why this takes the card's `copy` rather than deriving copy of its own: the
 * Network caption was a constant reading "since this container started" over the
 * host's `/proc/net/dev` totals, which run from boot
 * `liveTargetCopy`
 * holds that branch, together with the card's heading, its subtitle and the hint
 * under a refusal, because all four describe the same subject and two of them
 * had already drifted from it. `LiveCard` calls it once and passes the result
 * down — a second call here would be a second place for the branch to live, which
 * is the shape this fix exists to remove.
 */
export function LiveReadings({
  sample,
  status,
  closeReason,
  closeCode,
  ended,
  unmeasured,
  copy,
  thresholds,
}: {
  sample: DockerStatsSample | null;
  status: SocketStatus;
  closeReason: string | null;
  /** The close code beside it, because `4010` is a different ending. */
  closeCode: number | null;
  /** Silence has outlasted its grace period — see `live-card.tsx`. */
  ended: boolean;
  /** `isUnmeasured` on the current frame, computed once by the card. */
  unmeasured: boolean;
  /** What this card says about the target the picker is on — one call, above. */
  copy: LiveTargetCopy;
  thresholds: { cpu: number; memory: number } | null;
}) {
  const cpu = percent(sample?.cpu?.value);
  const memory = sample?.memory?.value ?? null;
  const disk = sample?.disk?.value ?? null;

  /**
   * **A refusal is the gateway's sentence, and the hint under it has to be able
   * to be true**.
   *
   * This branch used to read `The stats stream was refused: <reason>, and no
   * sample arrived.` for *every* close that carried a reason, followed by a fixed
   * guess about `/proc` or a container that stopped. On a `4010` every clause of
   * that is wrong: an authorization lease is armed at connect and renewed on a
   * clock, so it can only end after authorization has already succeeded — the
   * stream was delivering samples up to the moment it was refused. "No sample
   * arrived" sends the operator hunting a collection problem that does not exist,
   * and neither `/proc` nor a stopped container is the cause.
   *
   * `LogRefusal` is that distinction, and it is imported rather than repeated:
   * the three log views draw the same two paragraphs from the same component, and
   * a fourth spelling of it is how five `owned-server` lookups drifted apart.
   * Its shape is a callout rather than this card's body prose, which is
   * right here for the same reason it is right there — the gateway's words are
   * quoted, not written by the console (ADR-0012's "one reason on the wire").
   *
   * `ended` keeps a sentence of its own because it is the case where nothing
   * arrived and nothing said so: silence outlasting its grace period, with no
   * close reason to quote. `useLiveStream` only sets it when `sample === null`,
   * so "before any sample arrived" is true there by construction.
   */
  if (closeReason) {
    return (
      <LogRefusal reason={closeReason} code={closeCode} hint={copy.streamHint} />
    );
  }

  if (status === "blocked") {
    // Before `ended`, which waits out a grace period: this one is known at
    // once, and is not a stream that closed.
    return (
      <p className="text-body text-tx-2">
        {BLOCKED_SENTENCE} Live readings need it; the stored figures on this page
        do not.
      </p>
    );
  }

  if (ended) {
    return (
      <p className="text-body text-tx-2">
        The stats stream closed before any sample arrived. {copy.streamHint}
      </p>
    );
  }

  if (unmeasured) {
    /* **A sample of zeros is not a reading, and this is the whole reason
       the card checks.** `HostStatsService` parses `/proc` with a parser
       that defaults every field to 0, so on a platform host that is not
       Linux the socket delivers a *valid-looking* frame reporting 0% CPU
       and 0.00GiB of 0.00GiB memory. Rendering that draws three bars at
       zero and says this machine is completely idle — the exact lie the
       per-Server cards refuse to tell about an unmonitored host, arriving
       through a different door. A host with no memory at all is not a
       host. Found by opening the socket and reading the frame. */
    return (
      <p className="text-body text-tx-2">
        This host reported a sample in which every total is zero — no memory
        fitted, no disk. That is not an idle machine, it is an unmeasured one:
        these figures come from <code className="font-mono">/proc</code>, and on a
        platform host that is not Linux there is nothing there to read, so the
        parser returns zeros rather than failing. Pick a container above for real
        figures, which come from <code className="font-mono">docker stats</code>{" "}
        and work anywhere.
      </p>
    );
  }

  if (sample === null) {
    return (
      <div className="grid gap-3.5" aria-busy="true">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <p className="text-meta text-tx-3">{CONNECTION[status]}</p>
      </div>
    );
  }

  return (
    <>
      <Meter
        label="CPU"
        // `live` on the figure, so a number that ticks in place does not
        // shuffle the words beside it (`StatTile`'s own rule).
        value={sample.cpu ? sample.cpu.value : <Dash word="Unknown" />}
        percent={cpu ?? 0}
        tone={cpu === null ? "mute" : liveTone(cpu, thresholds?.cpu ?? 0)}
        note={
          cpu === null
            ? "not reported"
            : thresholds && thresholds.cpu > 0
              ? `notifies above ${thresholds.cpu}%`
              : undefined
        }
      />
      {memory ? (
        <Meter
          label="Memory"
          value={`${readingBytes(memory.used)} of ${readingBytes(memory.total)}`}
          // `docker stats` reports memory as used/total strings with their
          // own units and no percentage in this frame, so the bar is
          // computed from the pair — and when the units differ there is
          // nothing honest to compute, so the meter goes `mute`.
          percent={memoryPercent(memory) ?? 0}
          tone={
            memoryPercent(memory) === null
              ? "mute"
              : liveTone(memoryPercent(memory) ?? 0, thresholds?.memory ?? 0)
          }
          note={
            memoryPercent(memory) === null
              ? "reported in units that cannot be compared"
              : thresholds && thresholds.memory > 0
                ? `notifies above ${thresholds.memory}%`
                : undefined
          }
        />
      ) : null}
      <StatGrid>
        <StatTile
          live
          label="Network"
          value={
            sample.network
              ? `${readingBytes(sample.network.value.inputMb)} / ${readingBytes(sample.network.value.outputMb)}`
              : "—"
          }
          // The caption branches with the target, as the Disk tile below it
          // does: this pair is `docker stats` NetIO for a container and
          // `/proc/net/dev` for the host, and those cover different windows.
          // `liveTargetCopy` is the branch, and its docblock is why.
          detail={copy.networkDetail}
        />
        <StatTile
          live
          label="Block IO"
          value={
            sample.block
              ? `${readingBytes(sample.block.value.readMb)} / ${readingBytes(sample.block.value.writeMb)}`
              : "—"
          }
          detail="read / written"
        />
        {disk ? (
          <StatTile
            live
            label="Disk"
            value={disk.diskUsedPercentage}
            unit="% used"
            detail={`${formatBytes(gibToBytes(disk.diskFree))} free of ${formatBytes(gibToBytes(disk.diskTotal))}`}
          />
        ) : (
          <StatTile
            label="Disk"
            value={<Dash word="None" />}
            detail="a container has no disk series — only the host does"
          />
        )}
      </StatGrid>
    </>
  );
}

