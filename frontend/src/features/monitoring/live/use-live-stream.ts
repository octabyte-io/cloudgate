import { useEffect, useState } from "react";

import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import { useDockerStats } from "@/lib/realtime/gateways";

import { HOST } from "./target-options";
import { isUnmeasured } from "./units";

/**
 * The live half's own state: which target the picker is on, the socket pointed at
 * it, and the two readings the card cannot take straight from a frame — whether
 * silence has lasted long enough to count as an ending, and whether the frame is a
 * measurement at all.
 *
 * It is a hook rather than lines in the card because both of those are about
 * *time*, and both were defects before they were code.
 */
export function useLiveStream(config: MetricsConfig | null) {
  const [target, setTarget] = useState<string>(HOST);

  const stats = useDockerStats({
    appName: target,
    // `docker-compose` matches the container by **name**, which is what the
    // container listing gives us. The other two match Swarm labels, and a label is
    // not something the picker knows. For the host the type is ignored.
    appType: "docker-compose",
    enabled: target !== "",
  });

  const sample = stats.sample;
  const unmeasured = sample !== null && isUnmeasured(sample);

  /**
   * **`closed` means two things and the snapshot cannot tell them apart.** The
   * store's initial state *is* `closed` — its own comment says "finished, or
   * nothing to connect to" — so a card that reads `status === "closed"` as an
   * ended stream renders "the stream closed and no sample arrived" on its very
   * first paint, before anything has been dialled. Found by driving it: the
   * ended state appeared instantly and permanently, on a socket that worked.
   *
   * The fix is to give the dial a grace period rather than to latch it: "closed
   * and nothing arrived" only counts once this target has had longer than a
   * sampling interval to produce something. Held as *which target* has settled,
   * so switching target makes `settled` false again with no reset to write — no
   * clock read during render, no state written synchronously from an effect, and
   * it covers what a latch would not, a socket that closes and reopens.
   */
  const [settledFor, setSettledFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettledFor(target), GRACE_MS);
    return () => clearTimeout(timer);
  }, [target]);

  const settled = settledFor === target;
  const ended =
    settled &&
    sample === null &&
    (stats.status === "closed" || stats.status === "refused");

  /**
   * The thresholds the live meters are toned against — **the stored config's, and
   * only for the host.** They are what `ThresholdService` compares each stored
   * sample against, so toning the live number at the same percentage is the one
   * place the two stores usefully agree: the bar the operator is watching turns at
   * the number that will notify. A container has none, because thresholds are
   * evaluated over host samples only.
   */
  const thresholds =
    target === HOST ? (config?.server.thresholds ?? null) : null;

  return {
    target,
    setTarget,
    isHost: target === HOST,
    status: stats.status,
    closeReason: stats.closeReason,
    /**
     * **The close code travels with the reason**.
     * This hook forwarded `closeReason` alone, so every refusal reached the card
     * as one undifferentiated ending and the card said "no sample arrived" about
     * all of them. A `4010` is by construction a socket that *was* streaming —
     * the lease is armed at connect and renewed on a clock, so it can only end
     * after authorization has already succeeded at least once (ADR-0012) — and
     * that is a fact only the code carries. The store already exposes it; the
     * gap was here.
     */
    closeCode: stats.closeCode,
    sample,
    unmeasured,
    ended,
    thresholds,
  };
}

/**
 * How long a dial gets before silence counts as an ending.
 *
 * The gateway samples every 1300ms, so a little over two ticks: long enough that
 * a slow first `docker stats` is still a wait, short enough that nobody watches
 * skeletons on a socket that is never coming back.
 */
const GRACE_MS = 3_000;
