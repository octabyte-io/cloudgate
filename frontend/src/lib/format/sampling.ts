import type { MetricsConfig } from "@/lib/api/endpoints/servers";

import { counted } from "./plural";

/**
 * Where a host's sampling stands, read off its stored `metricsConfig`, and how
 * long what it stored is kept.
 *
 * Moved out of `features/monitoring/setup/metrics-config-spec.ts` under the
 * promotion rule (CODING_STANDARDS §1.4): a Server's Telemetry tab in
 * `features/server/` asks the same three-state question the Monitoring screen
 * does, and `lib/api/use-server-metrics.ts` had grown a third inline spelling of
 * it to gate its query. One function now, whichever of them is asking — the
 * same move `deployment-facts.ts` made into this folder.
 *
 * Everything here takes the config rather than a `Server` row, because the web
 * server has no row and only the config shape can describe it.
 */

/**
 * Whether a stored config would collect anything at all. "A token is set" is
 * the switch: `registerServer` returns early without one.
 *
 * **It asks whichever of the two fields arrived**, because that is what keeps
 * this one predicate serving both shapes. A route that projects the credential
 * out sends `hasToken` in its place (`MetricsConfig`, ADR-0019), and that wins
 * when it is there; a route that still sends the value falls back to the value.
 * Deriving it only from the value would have read a projected config as "never
 * set up" — the switch failing silently in exactly the direction nobody would
 * notice.
 */
export function configCollects(config: MetricsConfig | null): boolean {
  if (!config) return false;
  const { hasToken, token } = config.server;
  if (typeof hasToken === "boolean") return hasToken;
  return (token ?? "").trim() !== "";
}

/**
 * **Three states, and the token is only one bit of them**.
 *
 * `configCollects` says whether a host is being sampled *now*. Read as the only
 * question, it put a host whose collection had just been stopped back into the
 * never-set-up state — "there are no samples and there never will be" beside
 * rows that were still stored, and "not set up" beside a config that was still
 * whole. Stopping clears the token and nothing else, so the rest of the config
 * is what tells the two apart, and `cronJob` is the field that does it cleanly:
 * both declared defaults ship it `''` and both setup routes refuse an empty one
 * (`min(1)`), so it is non-empty exactly when a setup has been saved. It is also
 * the retention cleanup's own schedule, which the backend keeps registered for a
 * stopped host (`registerTarget`) — so "stopped" here is precisely "no longer
 * collecting, and what it stored still expires on schedule".
 *
 * - **`collecting`** — the token is set.
 * - **`stopped`** — set up once, token cleared since: samples kept until
 *   retention deletes them, config intact, and starting again resumes it.
 * - **`never`** — nothing was ever set up, so nothing was ever stored.
 */
export type SamplingState = "collecting" | "stopped" | "never";

export function samplingState(config: MetricsConfig | null): SamplingState {
  if (configCollects(config)) return "collecting";
  return (config?.server.cronJob ?? "").trim() !== "" ? "stopped" : "never";
}

/**
 * How long a host's samples are kept, as words: `"2 days"`.
 *
 * `0` and a missing config read as 2, the backend's own default
 * (`web_server_settings`' declared `retentionDays`); both setup routes refuse
 * anything below 1, so a stored 0 is a config nobody saved.
 */
export function retentionSpan(config: MetricsConfig | null): string {
  return counted(config?.server.retentionDays || 2, "day", "days");
}

/**
 * The clause every stopped-state screen says about the samples it still shows
 * they are not kept for ever, and what deletes them is still running.
 *
 * One string rather than JSX around an interpolated count, because the JSX
 * version shipped **"more than 2 daysold"** on a stopped Server's card: the
 * text node after `{days === 1 ? "day" : "days"}` began with its space and also
 * carried an `&rsquo;`, and the build drops a multi-line text node's leading
 * space when it has an entity to decode (`jsx-inline-element-spacing`).
 * A sentence built here has no text node to lose one from.
 */
export function retentionDeletion(config: MetricsConfig | null): string {
  return `deleted once it is more than ${retentionSpan(config)} old, by the retention cleanup that goes on running`;
}
