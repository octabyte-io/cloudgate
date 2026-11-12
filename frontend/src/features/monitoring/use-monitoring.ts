import { useMutation, useQuery } from "@tanstack/react-query";

import {
  monitoringApi,
  type MetricsConfigInput,
  type RequestsReadQuery,
  type ServiceRequestsReadQuery,
} from "@/lib/api/endpoints/monitoring";
import { settingsApi } from "@/lib/api/endpoints/settings";
import { traefikApi } from "@/lib/api/endpoints/traefik";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import { configCollects, samplingState } from "@/lib/format/sampling";

import type { ContainerTarget } from "./container-targets";
import { exclusionsFor, includedFrom } from "./setup/metrics-config-spec";

/**
 * The Monitoring and Requests screens' own reads and writes.
 *
 * The per-Server sample series is not here — it is `@/lib/api/use-server-metrics`,
 * shared with a Server's Telemetry tab, which is where F14 moved it. What is here
 * is everything only these two screens ask for, **including everything about the
 * web server**: the machine Cloudgate runs on is this screen's subject and nobody
 * else's, so its config read, its sample series and its setup mutation live here
 * rather than beside the Server hooks. If a second feature ever wants them, that
 * is the signal to move them, the way the Server series was moved.
 */

/**
 * Is this instance's Postgres and Traefik up?
 *
 * **A refusal is not a diagnosis.** The route is owner/admin only, so a member
 * gets a 403 — and the caller has to render that as a permission answer. This
 * hook therefore does not swallow the error into a status: `error` stays `error`
 * and the card says who can ask. `retry: false`, because a 403 will not become a
 * 200 by asking again, and this is a probe someone is watching.
 */
export function useInfrastructureHealth() {
  return useQuery({
    queryKey: keys.instanceHealth(),
    queryFn: () => settingsApi.infrastructureHealth(),
    retry: false,
    // The two dependencies of a running platform. Worth being fresh, not live.
    refetchInterval: 30_000,
  });
}

/**
 * Is Traefik writing an access log?
 *
 * Answers `{ present, enabled }`: `present` is whether there is a `traefik.yml`
 * on this host at all, `enabled` whether it is recording. Those were once one bare
 * `false`, which is why `useTraefikPresence` below exists — it establishes the same
 * fact by a second route, and is now redundant rather than load-bearing.
 */
export function useRequestLogging() {
  return useQuery({
    queryKey: keys.traefikRequests(),
    queryFn: () => traefikApi.haveActivateRequests(),
    retry: false,
  });
}

/**
 * Is there a Traefik installation on this host at all?
 *
 * The directory walk is the only route that can answer, because it either returns
 * a real tree or fails — unlike `haveActivateRequests`, whose `false` covers both
 * "off" and "absent". A **404 or an empty tree** is the absent case; anything else
 * is a Traefik that exists and might merely have logging switched off.
 *
 * `retry: false` and no polling: this walks a filesystem to answer a question
 * whose answer changes when somebody provisions a host, which is not often.
 */
export function useTraefikPresence() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.traefik.directories(organizationId, null),
    queryFn: () => traefikApi.directories(null),
    enabled: organizationId !== null,
    retry: false,
  });
}

/**
 * The Requests page's Server picker: every Server the caller can read a
 * Service on, or holds `server: ['read']` on, plus whether the platform host
 * is one more entry. Reaches no Server, so it is cheap and `retry: false`
 * only because a refusal will not become an answer by asking again.
 */
export function useRequestTargets() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.monitoring.requestTargets(organizationId),
    queryFn: () => monitoringApi.requestTargets(),
    enabled: organizationId !== null,
    retry: false,
  });
}

/**
 * One live read of an Access log — a Server's over SSH, or the platform
 * host's — with the table's page, the chart's hours and the totals in one
 * answer, so the three are always counted from the same read.
 *
 * **The whole query is the key** (`keys.ts` says why), and
 * `placeholderData` holds the previous answer while the next one loads, so
 * paging does not flash a skeleton. Not polled: every read is an SSH read of
 * up to 16 MiB of someone's Server, so it happens when the page asks.
 */
export function useRequestsRead(query: RequestsReadQuery, enabled = true) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.monitoring.requestsRead(organizationId, query),
    queryFn: () => monitoringApi.readRequests(query),
    enabled: enabled && organizationId !== null,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/**
 * One live read of a Service's Requests tab: its Server's Access log, found
 * by the backend from the Service, fixed to that Service. Read like
 * {@link useRequestsRead}: when asked, never polled.
 */
export function useServiceRequestsRead(
  serviceId: string,
  query: ServiceRequestsReadQuery,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.monitoring.serviceRequestsRead(
      organizationId,
      serviceId,
      query,
    ),
    queryFn: () => monitoringApi.readServiceRequests(serviceId, query),
    enabled: organizationId !== null,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/**
 * Turn monitoring on for a Server, or change how it samples.
 *
 * `onSettled`, not `onSuccess` — F11's rule, and it applies here for the same
 * reason: this request writes the config *and* registers the intervals inside the
 * request, so a response that never arrives does not mean nothing happened. The
 * row is re-read either way, and the token the row reports back — the value on a
 * `server` row, `hasToken` on the web server's — is what the screen believes.
 */
export function useSetupMonitoring(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (metricsConfig: MetricsConfigInput) =>
      monitoringApi.setupServer(serverId, metricsConfig),
    onSettled: () => invalidate.serverMonitoring(serverId),
  });
}

/* ------------------------------------------------------------------ *
 * The web server — the machine Cloudgate runs on
 * ------------------------------------------------------------------ */

/**
 * How this instance's own host is configured for sampling, or `null` if it never
 * has been.
 *
 * **This is `GET /settings/web-server`, keyed exactly as the Platform screen keys
 * it** (`keys.webServerSettings()`), so the two share one cache entry and one
 * fetch rather than polling the singleton twice under two names. That route is
 * open to any authenticated caller, unlike the health probe beside it — so
 * *reading* whether the host is sampled is not role-gated even though
 * `setupWebMonitoring` below is.
 *
 * **The config is read structurally rather than off the declared type.**
 * `WebServerSettings.metricsConfig` in `endpoints/settings.ts` declares only the
 * thresholds and `hasToken`, which is all the screens that added them needed; the
 * route sends the whole `metricsConfig`, the same shape a `server` row carries
 * **less the agent token**, which it projects out and reports as
 * `server.hasToken`. Narrowing it here keeps the widening in one place until a
 * second feature wants the rest — and makes the missing-field case explicit
 * instead of trusting a cast: an instance whose singleton predates the column
 * reads as "never set up", which is true.
 *
 * `collecting` is therefore `hasToken` and not a value test; `configCollects`
 * asks whichever of the two arrived, so this call site did not have to change
 * when the projection landed. `state` is the fuller answer
 * a host whose
 * history was stopped is not collecting, and is not a host that never kept one
 * either — `samplingState` says why the config can tell.
 */
export function useWebServerMonitoring() {
  const query = useQuery({
    queryKey: keys.webServerSettings(),
    queryFn: settingsApi.webServer,
  });
  const config = asMetricsConfig(query.data?.metricsConfig);
  return {
    ...query,
    config,
    collecting: configCollects(config),
    state: samplingState(config),
  };
}

/** The declared type says less than the route sends; this is the difference. */
function asMetricsConfig(value: unknown): MetricsConfig | null {
  if (value === null || typeof value !== "object") return null;
  const config = value as Partial<MetricsConfig>;
  if (!config.server || !config.containers) return null;
  return config as MetricsConfig;
}

/**
 * The web server's **stored** samples inside a time range — the other half of
 * what the live card shows.
 *
 * `serverMetrics` is called with `null`, which is how the route is asked about
 * this machine: it has no `server` row and so no id to name. Everything else
 * is `useServerMetricsInWindow`'s reasoning — bounds and no `limit`, so a bounded
 * read is uncapped, and the poll follows the host's own `refreshRate` because
 * asking more often than the backend samples just re-reads the same newest row.
 *
 * **`"web-server"` stands in for the id in the query key.** The key needs a
 * component where a Server's id goes and there is no id; a literal that no
 * generated id can collide with is the honest placeholder, and it keeps this
 * series under the same `monitoring` root that `invalidate.serverMonitoring`
 * already drops.
 *
 * **A stopped history is still read, and no longer polled**
 * The gate was
 * `configCollects`, so the samples stored before "Stop keeping a history" went
 * unread the moment it was pressed, and the card fell back to saying nothing had
 * ever been stored. They are kept until retention deletes them, so they are
 * fetched while there is any configuration at all — only a host that was never
 * set up has nothing to ask for. Nothing new arrives while stopped, so the poll
 * is off rather than re-reading a series that cannot change.
 */
export function useWebServerMetrics(
  config: MetricsConfig | null,
  bounds: { start: string; end: string },
  enabled = true,
) {
  const { organizationId } = useActiveOrganizationId();
  const refresh = Math.max(2, config?.server.refreshRate || 60);
  const state = samplingState(config);

  return useQuery({
    queryKey: keys.monitoring.serverMetrics(
      organizationId,
      WEB_SERVER_KEY,
      `${bounds.start}..${bounds.end}`,
    ),
    queryFn: () => monitoringApi.serverMetrics(null, bounds),
    enabled: enabled && state !== "never" && organizationId !== null,
    refetchInterval: state === "collecting" ? refresh * 1_000 : false,
  });
}

/**
 * Where a Server's id goes in a key, for the host that has none — the host's
 * server-level series above and its container series below. Exported so
 * the card can key its React list on the same value rather than spelling a
 * second literal that could collide with a generated id.
 */
export const WEB_SERVER_KEY = "web-server";

/**
 * One service's stored container samples on one host, inside a time range.
 *
 * **Keyed on a collection target rather than on a `server` row.** This
 * lived in
 * `lib/api/use-server-metrics.ts` and took a `Server`, so `server.serverId` was
 * the target and `server.metricsConfig` the config — and the machine Cloudgate
 * runs on has no row to supply either. It is here rather than there for the
 * reason this file's header gives: container samples are read by this screen and
 * no other, and everything about the web server already lives here. Its gates
 * are the config-shaped `samplingState`/`includedFrom`, which are the only
 * shape a host with no row can be described in. `lib/api/use-server-metrics.ts`
 * keeps the `Server`-shaped `isCollecting` for the Server reads that still need
 * it, and `lib/` imports from `features/` nowhere in this tree.
 *
 * **`target.id` goes to the route untouched, `null` included** — that is how the
 * route is asked about this machine (`endpoints/monitoring.ts`: nothing means the
 * web server), and the client drops a null query parameter rather than sending
 * the string. In the key it becomes `WEB_SERVER_KEY`, because a key component
 * cannot be absent.
 *
 * **The container series has its own refresh rate**, which is why this is a
 * separate hook rather than a parameter on the server-level read:
 * `metricsConfig.containers.refreshRate` is what the collector samples
 * containers at, so it is what this polls at.
 *
 * Disabled unless the target has been set up **and** its `include` list would have
 * matched something — `collectContainerMetrics` returns before it shells out when
 * that list is empty, so with the default config this route can only ever answer
 * `[]`, and a query that asks anyway spends a request to be told nothing on
 * every poll.
 *
 * **An excluded name is the third gate, and it is the same argument**
 * An exclusion is
 * checked before the include list and beats it, so a name in both lists is never
 * sampled and this route can only refuse it — once per poll, every poll, at the
 * container refresh rate. The card explains that row from the config instead
 * (`ContainerMetricsCard`), so the refusal it would be explaining is not worth
 * fetching. A series already in the cache is still returned while it is there,
 * which is why the card keeps its own `samples.length === 0` guard: an exclusion
 * added to a name that has samples on screen must not blank a chart that is
 * still true.
 *
 * **A stopped target is read and not polled**, for `useWebServerMetrics`'
 * reason: what
 * it stored is kept until retention, and nothing new is coming.
 */
export function useContainerMetrics(
  target: ContainerTarget,
  appName: string | null,
  bounds: { start: string; end: string },
) {
  const { organizationId } = useActiveOrganizationId();
  const refresh = Math.max(2, target.config?.containers.refreshRate || 60);
  const state = samplingState(target.config);

  return useQuery({
    queryKey: keys.monitoring.containerMetrics(
      organizationId,
      target.id ?? WEB_SERVER_KEY,
      appName ?? "",
      `${bounds.start}..${bounds.end}`,
    ),
    queryFn: () =>
      monitoringApi.containerMetrics(target.id, appName ?? "", bounds),
    enabled:
      organizationId !== null &&
      appName !== null &&
      state !== "never" &&
      includedFrom(target.config).length > 0 &&
      exclusionsFor(target.config, appName).length === 0,
    refetchInterval: state === "collecting" ? refresh * 1_000 : false,
  });
}

/**
 * Turn sampling on for this instance's own host, or change how it samples.
 *
 * `onSettled` rather than `onSuccess`, for the same reason the per-Server
 * mutation uses it: the request writes the config *and* registers the intervals
 * inside itself, so a response that never arrives does not mean nothing happened.
 *
 * **`instanceSettings` is the whole fan-out, and that is not an oversight** —
 * `serverMonitoring` drops the sample subtree as well, and this deliberately does
 * not need to. The web server's series is gated on the config that was just
 * refetched: turning sampling on for the first time *enables* a query that was
 * not running, which fetches fresh; stopping it only switches the poll off,
 * because the window it holds is still exactly what is stored; starting
 * it again switches the poll back on, so the next interval appends to that same
 * window; and a changed refresh rate only changes how often the same live poll
 * repeats. There is no case where a cached window is shown as current after
 * this.
 *
 * **Owner or admin only**; a member's Save is a 403, which the dialog surfaces as
 * the refusal it is rather than as a failed write.
 */
export function useSetupWebMonitoring() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (metricsConfig: MetricsConfigInput) =>
      monitoringApi.setupWebServer(metricsConfig),
    onSettled: () => invalidate.instanceSettings(),
  });
}

/** Switch Traefik's access log on or off. See `endpoints/traefik.ts` first. */
export function useToggleRequestLogging() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (enable: boolean) => traefikApi.toggleRequests(enable),
    onSettled: () => invalidate.traefikRequests(),
  });
}

/** Restart Traefik, so a static-config change takes effect. */
export function useReloadTraefik() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => traefikApi.reloadTraefik(null),
    onSettled: () => invalidate.traefikRequests(),
  });
}
