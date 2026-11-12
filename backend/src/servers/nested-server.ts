import type { MetricsConfig } from './server.schema';
import type { Server } from './server.schema';

/**
 * `metricsConfig` as the API may answer with it: the agent token projected out
 * and replaced, **in the position it was projected from**, by whether one is
 * set.
 *
 * `token` non-empty is the collection switch — `MonitoringService.registerTarget`
 * returns early without one, `configCollects` in the console is that same test,
 * and both declared defaults (`defaultWebServerMetricsConfig`,
 * `defaultMetricsConfig` on a `server` row) ship `''` for "never set up" — so
 * the switch is the only thing a screen ever read the value for, and `hasToken`
 * is that switch with the credential removed. Putting the flag where the field
 * was rather than beside a row-level flag is deliberate: the rule is *"replace
 * a secret with its presence"* (ADR 0019), and applying it at the depth the
 * secret lives at is what lets one predicate in the console serve every shape
 * of this config without threading a second argument through nine call sites.
 *
 * **It serves every route that answers with either copy of this blob, which is
 * why it lives here and not in `settings.service.ts`.** One fix projected the
 * `web_server_settings` copy; a later one projected the copy on a `server` row —
 * through the nested `server` relation of a service read, and through
 * `POST /monitoring/servers/:serverId/setup`, whose docblock carries why that
 * one was sanitized rather than argued as an exception.
 *
 * **`GET /servers` and `GET /servers/:id` are the one asymmetry left, and the
 * two conditions that make them one.** They answer with the raw `token`
 * because they are `server:read` — which `permission.service.ts` bypasses for
 * owner/admin only — *and* because the console's setup form has nowhere else
 * to read the value it must re-submit: `toMetricsConfig` sends a stored token
 * back unchanged so that saving a threshold tweak does not rotate a token an
 * operator configured an external agent with. Both halves are load-bearing.
 * The second is what would have to be replaced first — by the omitted-means-keep
 * write these two setup routes now carry — before the read could join the rest,
 * and that is the shape of the work rather than a promise it will be done.
 * Every other route, including every route a **base member** reaches, sends
 * `hasToken`; `test/servers/nested-server-secrets.e2e-spec.ts` pins the split
 * from both sides.
 */
export type SanitizedMetricsConfig = Omit<MetricsConfig, 'server'> & {
  server: Omit<MetricsConfig['server'], 'token'> & { hasToken: boolean };
};

/**
 * The one projection of {@link MetricsConfig}, shared by the singleton's
 * `sanitizeWebServerSettings` and by {@link nestedServer}.
 *
 * One function rather than two spellings of the same destructure, because the
 * two copies of this blob are the same shape holding the same credential, and
 * the lesson was that a projection spelled per-site is a projection that
 * gets forgotten at the next site.
 */
export function sanitizeMetricsConfig(
  config: MetricsConfig,
): SanitizedMetricsConfig {
  const { token, ...server } = config.server;
  return { ...config, server: { ...server, hasToken: Boolean(token) } };
}

/**
 * A `server` row as a **nested relation** on a service read may carry it.
 *
 * See `common/service-read-relations.ts` for the rule this is the one exception
 * to: every other secret a nested relation would carry is withheld as a whole
 * column, because the whole column *is* the secret. `metricsConfig` is not —
 * the blob is the host's sampling configuration (refresh rates, ports,
 * thresholds, retention, the container include/exclude lists) and only
 * `server.token` authenticates anything — so the column is returned and the
 * field is withheld at its own depth, which is also the only depth ADR 0019
 * permits its presence flag to stand at.
 */
export type NestedServer = Omit<Server, 'metricsConfig'> & {
  metricsConfig: SanitizedMetricsConfig;
};

/**
 * Project a `server` relation for a service read. `null` — the platform host,
 * which has no `server` row at all — passes through, because "no Server"
 * and "a Server with no token" are different facts and the console's
 * `isCollecting` only ever asks the second one.
 */
export function nestedServer(row: Server): NestedServer;
export function nestedServer(row: Server | null): NestedServer | null;
export function nestedServer(row: Server | null): NestedServer | null {
  if (row === null) return null;
  return { ...row, metricsConfig: sanitizeMetricsConfig(row.metricsConfig) };
}
