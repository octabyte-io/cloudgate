import type { MetricsConfig, Server } from "@/lib/api/endpoints/servers";
import { samplingState } from "@/lib/format/sampling";

import { includedFrom } from "./setup/metrics-config-spec";

/**
 * A host container samples are collected for: a `server` row, or the machine
 * Cloudgate itself runs on, whose id is `null`.
 *
 * **`id: null` is the platform host, and that is the convention the whole
 * surface already uses** — ADR-0008 states it outright ("no server row to check"
 * is the deliberate contract for the platform host across the whole HTTP
 * surface), `monitoringApi.containerMetrics` takes `string | null | undefined`,
 * and `useWebServerMetrics` already reads the host's server-level series that
 * way. So the target is not a `Server` and must not be faked into one: a
 * synthetic row was decided against, and ADR-0010 and the Monitoring screen's own
 * strap both turn on the host genuinely not having one.
 */
export type ContainerTarget = {
  id: string | null;
  name: string;
  config: MetricsConfig | null;
};

/**
 * What the screen calls the platform host — the same two words the live card's
 * heading uses, rather than a synthetic Server name that would read as a row
 * somebody could open.
 */
export const HOST_TARGET_NAME = "this host";

/**
 * Every host the Containers card should draw, host first.
 *
 * **This function is the fix.** The card used to take `Server[]` and filter it, so
 * the platform host — which has no `server` row — could never be in the list:
 * container samples taken for it were collected, served over
 * `GET /monitoring/metrics/containers` with no `serverId`, and drawn nowhere. On
 * a default single-box install *every* Application has `serverId: null`, so that
 * made the card unreachable for all of them: `POST /admin/setup-monitoring`
 * answered 200 with 79 samples while the console showed no Containers card at
 * all. The workaround on the box — setting monitoring up a second time on a
 * Server row pointing at the same machine over SSH — is a second collector
 * sampling the same containers, not a fix.
 *
 * **The filter is both halves of "is anything actually stored", not just the
 * switch.** A host that was never set up has stored nothing, and an empty include list means
 * `collectContainerMetrics` returns before it shells out — there is no value
 * meaning "everything" — so a host set up with the defaults collects host
 * metrics and no container metrics, for ever. A card for it would be a chart
 * that can never fill. Both predicates take a config rather than a `Server`,
 * because only the config shape can describe a host with no row (§1.4).
 *
 * **A stopped host stays in the list**.
 * This filtered on `configCollects`, so pressing "Stop keeping a history" made
 * the whole "Containers on this host" card vanish while its samples were still
 * stored and still inside their retention. The test is `samplingState` now:
 * anything but `never` has stored under the include list it still carries, and
 * the card says the collection is stopped rather than disappearing.
 *
 * An empty result is how "nothing is collecting anywhere" reaches the card, and
 * the card renders nothing for it — not an empty card and not a "no data"
 * placeholder, because neither is true: nobody has asked for container samples.
 */
export function containerTargets(
  host: MetricsConfig | null,
  servers: readonly Server[],
): ContainerTarget[] {
  const targets: ContainerTarget[] = [
    { id: null, name: HOST_TARGET_NAME, config: host },
    ...servers.map((server) => ({
      id: server.serverId,
      name: server.name,
      config: server.metricsConfig,
    })),
  ];

  return targets.filter(
    (target) =>
      samplingState(target.config) !== "never" &&
      includedFrom(target.config).length > 0,
  );
}

/**
 * What to call a target inside a sentence.
 *
 * The vocabulary keeps **Server** for a `server` row and does not use "host" for
 * one (CONTEXT.md's *Avoid* on Server names host, node and machine), while the
 * machine Cloudgate runs on is "this host" everywhere on this screen. One card
 * component now renders both, so the noun has to come from the target rather
 * than be written into the copy.
 *
 * `components/console/terminal.tsx` has a `targetNoun` of its own, answering
 * this same question for `TerminalTarget` — which also has a container arm, so
 * it has a third answer. The two are deliberately not merged: a shared shape for
 * two unrelated unions would cost more than the six lines it saves. Change one
 * and read the other.
 */
export function targetNoun(target: ContainerTarget): string {
  return target.id === null ? "this host" : "this Server";
}
