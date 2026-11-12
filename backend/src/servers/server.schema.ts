import { relations } from 'drizzle-orm';
import { boolean, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedJson, isoTimestamp, nanoidPk } from '../db/columns';
import { user } from '../auth/auth.schema';
import { organization } from '../organizations/organizations.schema';
import { sshKey } from '../ssh-keys/ssh-key.schema';

// A Server's status, and whether it runs deployments or builds them.
export const serverStatus = pgEnum('server_status', ['active', 'inactive']);
export const serverType = pgEnum('server_type', ['deploy', 'build']);

/**
 * The metrics agent's configuration — stored through {@link encryptedJson}
 * on both tables that carry it.
 *
 * **`server.token` is a live shared secret.** An operator supplies it
 * (`POST /monitoring/servers/:id/setup`, `POST /admin/setup-monitoring`), a
 * metrics agent presents it to the unauthenticated `POST /notifications/receive`,
 * and possession of it is the whole authorization: no expiry, no second factor,
 * and on the `web_server_settings` copy the alert it buys fans out to *every*
 * organization on the instance. Cleartext at rest meant a `pg_dump`, a read
 * replica or a backup handed its reader that. ADR 0006 is the authority and
 * `encryptedJson` in `db/columns.ts` exists for exactly this shape.
 *
 * **The whole blob, and not `token` split into its own `encryptedText`
 * column** — the argument was asked for rather than the default, and it is
 * this. The two options are not distinguished by what they encrypt, because
 * they cost the same thing: AES-256-GCM under a random IV is not
 * deterministic, so *no* encrypted column can be looked up by value, and
 * `NotificationsService.receiveServerThreshold` did exactly that
 * (`metrics_config -> 'server' ->> 'token' = $1`). Either option moves that
 * comparison into the process. What separates them:
 *
 * - **This interface is a contract with four other declarations.** It is
 *   mirrored field-for-field by `frontend/src/lib/api/endpoints/servers.ts`,
 *   accepted as request bodies by `admin/dto/admin.dto.ts` and
 *   `monitoring/dto/monitoring.dto.ts`, and read as `metricsConfig.server.token`
 *   by the console's `use-server-metrics.ts` and `metrics-config-spec.ts`.
 *   `encryptedJson<MetricsConfig>` changes the *encoding* and not the shape, so
 *   every one of those keeps compiling and keeps meaning what it did. Splitting
 *   `token` out changes the shape, which is either an API break across all
 *   four or a recomposition layer over `Server` — a larger change than the one
 *   that fixes the bug.
 * - **A second column is a second source of truth.** The token is written at
 *   exactly three places and each writes the blob whole
 *   (`MonitoringService.setupMonitoring`, `AdminService.setupMonitoring`, the
 *   two column defaults). A `metricsToken` beside `metricsConfig` adds an
 *   invariant no type can enforce — that the column and the blob's
 *   `server.token` agree — and the thing that depends on it is an
 *   authentication check. A rotation that updates one and not the other is a
 *   live token that still authenticates, or a stored one that no longer does.
 * - **Nothing reaches inside the blob for anything else.** This was asked
 *   first, and the sweep found exactly one `jsonb` access in `src` and it was
 *   the token comparison above; no `->>`, no containment, no `where`, and no
 *   index on `metrics_config` in any of the 65 migrations. Every other reader
 *   takes the structure whole — `ThresholdService.evaluate`,
 *   `MonitoringService.registerTarget`, `select({ metricsConfig })` in
 *   `findWebServerMetricsConfig` — so making it opaque to SQL costs nothing
 *   that exists.
 *
 * The honest cost of choosing the blob: the refresh rates, ports, thresholds
 * and container lists in here are not secrets and are now unqueryable in SQL
 * too. A future feature that needs one of them in a `where` wants a projected
 * column, not this one back in cleartext.
 */
export interface MetricsConfig {
  server: {
    type: 'Cloudgate' | 'Remote';
    refreshRate: number;
    port: number;
    token: string;
    urlCallback: string;
    retentionDays: number;
    cronJob: string;
    thresholds: {
      cpu: number;
      memory: number;
    };
  };
  containers: {
    refreshRate: number;
    services: {
      include: string[];
      exclude: string[];
    };
  };
}

export const defaultMetricsConfig: MetricsConfig = {
  server: {
    type: 'Remote',
    refreshRate: 60,
    port: 4500,
    token: '',
    urlCallback: '',
    cronJob: '',
    retentionDays: 2,
    thresholds: {
      cpu: 0,
      memory: 0,
    },
  },
  containers: {
    refreshRate: 60,
    services: {
      include: [],
      exclude: [],
    },
  },
};

export const server = pgTable('server', {
  serverId: nanoidPk('server_id'),
  name: text('name').notNull(),
  description: text('description'),
  ipAddress: text('ip_address').notNull(),
  port: integer('port').notNull(),
  username: text('username').notNull().default('root'),
  serverStatus: serverStatus('server_status').notNull().default('active'),
  serverType: serverType('server_type').notNull().default('deploy'),
  // Custom setup script; empty means "use the default setup command".
  command: text('command').notNull().default(''),
  // Nightly docker-cleanup cron opt-in (settings router's updateDockerCleanup).
  enableDockerCleanup: boolean('enable_docker_cleanup')
    .notNull()
    .default(false),
  // Whether this Server's traefik.yml carries request metrics — the loopback
  // `metrics` entryPoint its Services' Error rate is read from (ADR-0027).
  // Stored rather than read off the Server on every read, so the Server read
  // and each collection tick stay a database read that an unreachable Server
  // cannot fail. Written at the two moments Cloudgate writes that file: set by
  // Enable request metrics, and set from the file read back after the setup
  // script ran (which writes the block only on a Server that had no
  // traefik.yml). False on every Server provisioned before ADR-0027, which is
  // right: an existing Server is opted in only by the operator.
  requestMetricsEnabled: boolean('request_metrics_enabled')
    .notNull()
    .default(false),
  sshKeyId: text('ssh_key_id').references(() => sshKey.sshKeyId, {
    onDelete: 'set null',
  }),
  // `text` at rest, holding `enc:v1:` + the blob's JSON — see MetricsConfig
  // above for why the whole structure and not `token` alone. The
  // *default* stays plain JSON, and must: a ciphertext baked into DDL would be
  // tied to whichever `APP_ENCRYPTION_SECRET` generated the migration and
  // undecryptable on every other instance. It carries no secret — a fresh
  // row's `token` is `''`, which is also what "never set up" means to
  // `registerTarget` — and `decryptValue` passes an unprefixed value through
  // (ADR 0006), so it reads back as the same object it always did.
  metricsConfig: encryptedJson<MetricsConfig>('metrics_config')
    .notNull()
    .default(defaultMetricsConfig),
  // The open Server threshold breach per metric, ISO-8601, null while none
  // is open: stored so a backend restart mid-breach does not announce
  // it again. `ThresholdService` is the only writer.
  cpuBreachedSince: text('cpu_breached_since'),
  memoryBreachedSince: text('memory_breached_since'),
  // The last time Cloudgate tried to reach this Server over SSH, and how it
  // went. Written by `validate` (Check now), by `audit` (the
  // readiness read every Server tab shows) and by `setup`, so the tabs read one
  // stored answer instead of each holding the result of its own request until
  // the operator navigates away. `reachOk` and `reachMessage` are null until
  // `reachCheckedAt` is set; the message is the refusal the console was shown
  // (SSH's own words for Check now), null when it was reached.
  reachCheckedAt: text('reach_checked_at'),
  reachOk: boolean('reach_ok'),
  reachMessage: text('reach_message'),
  // The last setup run's outcome, written when the run ends. A run in
  // flight is not stored: it lives on the gateway, and a backend that restarts
  // mid-run never learns how it ended, so the previous outcome stands.
  setupRanAt: text('setup_ran_at'),
  setupOk: boolean('setup_ok'),
  setupMessage: text('setup_message'),
  // The SSH host key this Server presented the first time Cloudgate connected,
  // as `SHA256:<base64>` (what `ssh-keygen -lf` prints). Every later connect
  // must present the same one or is refused (ADR-0074, `remote/host-key.ts`).
  // Null until the first connect, and again after Forget host key or a change
  // of address, so the next connect records it afresh. Not a secret: it is
  // a hash of a public key, and the API answers it as is.
  hostKeyFingerprint: text('host_key_fingerprint'),
  // When this Server's Maintenance began, as an ISO instant; null while it is
  // not in maintenance. While it is set nothing new starts containers on the
  // Server (`server-maintenance.ts`, spec #1420). Separate from the unused
  // `serverStatus`, which is left alone.
  maintenanceSince: text('maintenance_since'),
  // Who started it; null while not in maintenance, and once that user is gone.
  maintenanceStartedBy: text('maintenance_started_by').references(
    () => user.id,
    { onDelete: 'set null' },
  ),
  createdAt: isoTimestamp('created_at'),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
});

export const serverRelations = relations(server, ({ one }) => ({
  sshKey: one(sshKey, {
    fields: [server.sshKeyId],
    references: [sshKey.sshKeyId],
  }),
  organization: one(organization, {
    fields: [server.organizationId],
    references: [organization.id],
  }),
}));

export type Server = typeof server.$inferSelect;
