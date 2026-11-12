import { boolean, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptedJson, isoTimestamp, nanoidPk } from '../db/columns';
import { certificateTypeEnum } from '../domains/domain.schema';
import type { MetricsConfig } from '../servers/server.schema';

/**
 * The instance maximum TTL of a Requested preview until an operator changes
 * it: 24 hours. The default TTL of one request is 60 minutes and is a
 * constant, not a setting (`preview-deployments/requested-preview.ts`).
 */
export const REQUESTED_PREVIEW_MAX_TTL_DEFAULT_MINUTES = 24 * 60;

/** Cloud runs at once, install-wide, until an owner raises it. */
export const CLOUD_RUNS_CONCURRENCY_DEFAULT = 1;

/** The Cloud run time limit, in minutes, until an owner sets it. */
export const CLOUD_RUN_TIME_LIMIT_DEFAULT_MINUTES = 60;

/**
 * The web-server row's default metricsConfig: type 'Cloudgate' marks the
 * machine this instance runs on (the server table's default is 'Remote').
 */
export const defaultWebServerMetricsConfig: MetricsConfig = {
  server: {
    type: 'Cloudgate',
    refreshRate: 60,
    port: 4500,
    token: '',
    retentionDays: 2,
    cronJob: '',
    urlCallback: '',
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

/**
 * The instance's branding, as `PATCH /settings/whitelabeling` writes it and the
 * sign-in screen reads it. Instance-wide rather than per-organization: the
 * first page a white-labelled instance has to get right is reached before
 * anyone has an organization.
 *
 * Typed fields rather than an untyped blob, so the settings row keeps saying
 * what it holds — `metricsConfig` above is the precedent. Every field is
 * nullable and null means "unbranded": a fresh instance looks like Cloudgate.
 */
export interface WhitelabelingConfig {
  /** Product name in the browser title and on the sign-in screen. */
  appName: string | null;
  /** Logo shown in the console rail and on the sign-in screen. */
  logoUrl: string | null;
  faviconUrl: string | null;
  /** Brand colours, as CSS hex colours. */
  primaryColor: string | null;
  accentColor: string | null;
  /** Operator-authored CSS, injected into every console page. */
  customCss: string | null;
  /** Copy the console's error pages show instead of the stock wording. */
  errorPages: {
    notFoundMessage: string | null;
    serverErrorMessage: string | null;
    supportUrl: string | null;
  };
}

/**
 * A partial write against {@link WhitelabelingConfig}. An absent key leaves the
 * stored value alone; an explicit `null` clears it.
 */
export type WhitelabelingConfigPatch = Partial<
  Omit<WhitelabelingConfig, 'errorPages'>
> & { errorPages?: Partial<WhitelabelingConfig['errorPages']> };

/** An unbranded instance: nothing overridden. */
export const defaultWhitelabelingConfig: WhitelabelingConfig = {
  appName: null,
  logoUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
  customCss: null,
  errorPages: {
    notFoundMessage: null,
    serverErrorMessage: null,
    supportUrl: null,
  },
};

// The instance-wide web server settings singleton. It carried an
// `ssh_private_key` column until it was dropped: a private key stored with no
// reader, which leaked through three routes and dialled nothing.
// whitelabelingConfig is *not* encrypted: it is branding, and `GET /settings/whitelabeling` serves it to
// anyone.
export const webServerSettings = pgTable('web_server_settings', {
  id: nanoidPk('id'),
  // Web server configuration
  serverIp: text('server_ip'),
  certificateType: certificateTypeEnum('certificate_type')
    .notNull()
    .default('none'),
  https: boolean('https').notNull().default(false),
  host: text('host'),
  letsEncryptEmail: text('lets_encrypt_email'),
  enableDockerCleanup: boolean('enable_docker_cleanup').notNull().default(true),
  logCleanupCron: text('log_cleanup_cron').default('0 0 * * *'),
  // Metrics configuration (admin setupMonitoring writes this), `encryptedJson`
  // for the reason `MetricsConfig`'s docblock gives — and this copy is the one
  // with the wider blast radius of the two, because the token on it
  // authenticates `receiveServerThreshold`'s instance-wide branch rather than
  // one organization's. Encrypting `server` and not this row would have
  // left the larger exposure in place.
  metricsConfig: encryptedJson<MetricsConfig>('metrics_config')
    .notNull()
    .default(defaultWebServerMetricsConfig),
  // The platform host's open Server threshold breach per metric, as
  // on the `server` row.
  cpuBreachedSince: text('cpu_breached_since'),
  memoryBreachedSince: text('memory_breached_since'),
  // Concurrent builds on the local web server
  buildsConcurrency: integer('builds_concurrency').notNull().default(1),
  /**
   * The Cloud run pool limit: how many `tofu` runs the platform host runs at once, install-wide.
   * More than one needs a licence, the rule `UNLICENSED_BUILDS_CONCURRENCY` states for builds. Read
   * by `deployment-queue/cloud-runs-concurrency.provider.ts`.
   */
  cloudRunsConcurrency: integer('cloud_runs_concurrency')
    .notNull()
    .default(CLOUD_RUNS_CONCURRENCY_DEFAULT),
  /**
   * The Cloud run time limit in minutes: plan plus apply, never
   * time queued or building, one limit for deploy, network and Delete runs.
   * A run past it is interrupted, then killed 5 minutes later.
   */
  cloudRunTimeLimitMinutes: integer('cloud_run_time_limit_minutes')
    .notNull()
    .default(CLOUD_RUN_TIME_LIMIT_DEFAULT_MINUTES),
  /**
   * The longest a Requested preview may be asked or extended for, in minutes
   * (ADR-0026). Instance-wide, because the cost it bounds is the
   * Server's, and a request over it is refused rather than clamped. It caps
   * each window from now, not a preview's whole lifetime.
   */
  requestedPreviewMaxTtlMinutes: integer('requested_preview_max_ttl_minutes')
    .notNull()
    .default(REQUESTED_PREVIEW_MAX_TTL_DEFAULT_MINUTES),
  // Enterprise SSO: the login screen offers only SSO when this is on.
  enforceSSO: boolean('enforce_sso').notNull().default(false),
  // Enterprise white-labeling: instance-wide branding.
  whitelabelingConfig: jsonb('whitelabeling_config')
    .$type<WhitelabelingConfig>()
    .notNull()
    .default(defaultWhitelabelingConfig),
  createdAt: isoTimestamp('created_at'),
  updatedAt: isoTimestamp('updated_at'),
});

export type WebServerSettingsRow = typeof webServerSettings.$inferSelect;
export type WebServerSettingsUpdate = Partial<
  typeof webServerSettings.$inferInsert
>;
