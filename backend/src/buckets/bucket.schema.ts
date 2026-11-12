import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  json,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { applicationStatusEnum } from '../applications/application.schema';
import type { CloudDeleteRecord } from '../applications/application.schema';
import type { LabelsSwarm } from '../applications/swarm.types';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { GcpBucketKeySlot } from '../cloud-accounts/gcp/definitions/bucket-definition';
import {
  configNameColumn,
  configNameConstraints,
  encryptedJson,
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../db/columns';
import { environment } from '../environments/environment.schema';
import type { NativeAwsBlock } from '../native/aws-native';
import { plan } from '../project-config/project-config.schema';
import { server } from '../servers/server.schema';

/**
 * What Cloudgate alone holds to run a bucket's Garage container (ADR-0037):
 * the RPC secret Garage's nodes share and the admin token its admin API
 * checks. Neither reaches any Service; both are made when the bucket is.
 */
export interface BucketAdminCredential {
  readonly rpcSecret: string;
  readonly adminToken: string;
}

/** A Garage key: its ID and its secret, the two a Service is handed. */
export interface BucketKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * One linking Service's redeploy in a key rotation: an Application's
 * queued Deployment, or a database's own deploy, which has no Deployment
 * row and is followed by its status.
 */
export interface KeyRotationRedeploy {
  readonly configName: string;
  readonly serviceType: 'application' | 'postgres' | 'mysql' | 'redis';
  readonly serviceId: string;
  /** The queued Deployment of an Application; `null` for a database. */
  readonly deploymentId: string | null;
  /** When it was queued or started, from which its time budget runs. */
  readonly queuedAt: string;
  /** How it ended, once it has; a refusal to queue it is `failed`. */
  readonly outcome: 'done' | 'failed' | null;
}

/**
 * Where a bucket's **Rotate key** is, or how it ended (ADR-0037).
 * Nothing secret: which Services it redeploys and how each ended. The keys
 * themselves are in {@link BucketRotationKeys}.
 *
 * - `redeploying`: the new key exists and every linking Service is being
 *   deployed with it; the old key is still valid and still stored.
 * - `putting-back`: a redeploy failed, so the Services already on the new
 *   key are deployed again with the old one before the new one is removed.
 */
export interface KeyRotation {
  readonly status: 'running' | 'done' | 'failed';
  readonly phase: 'redeploying' | 'putting-back' | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** That {@link redeploys} lists every linking Service's redeploy. */
  readonly queued: boolean;
  readonly redeploys: readonly KeyRotationRedeploy[];
  /** The put-back redeploys of a failed rotation, as {@link redeploys}. */
  readonly putBacks: readonly KeyRotationRedeploy[];
  /** The Config names whose redeploy failed: what the result names. */
  readonly failed: readonly string[];
  /** The sentence the bucket's page shows for how it ended. */
  readonly message: string | null;
}

/**
 * The keys a rotation holds apart from the bucket's own, encrypted
 * (ADR-0006): the new key while its redeploys run, and the IDs of keys
 * Cloudgate made and still has to remove from Garage — one whose removal
 * failed, or a new key a Service kept because its put-back failed. A
 * rotation that succeeds removes them, since every linking Service then
 * holds the newest key.
 */
export interface BucketRotationKeys {
  readonly newKey: BucketKey | null;
  readonly strayKeyIds: readonly string[];
}

/**
 * An existing bucket on Google Cloud's access, as its page shows it:
 * "waiting for access", ok, or "no access".
 */
export type GoogleBucketAccess = 'waiting' | 'ok' | 'no-access';

/**
 * A bucket on AWS's Delete under way or incomplete (ADR-0038): a cloud
 * Service's record, and whether that Delete asked for its files to go,
 * so its run — and a Retry — empties the bucket first.
 */
export interface BucketCloudDeleteRecord extends CloudDeleteRecord {
  readonly deleteFiles: boolean;
}

/**
 * A **Bucket** (`CONTEXT.md`): a Service written `kind: bucket` that
 * holds files and runs nothing of its own. On a Server it is its own Garage
 * Swarm service with its files on its own volume (ADR-0037).
 *
 * - **Its place** is `serverId`, the run Server (`null` is the platform
 *   host), or a Cloud account and region, where it is an S3 bucket;
 *   fixed when it is created and never read from the Environment
 *   (ADR-0035). An **existing bucket** (ADR-0033) is the third place:
 *   one made outside Cloudgate, in the Environment's Cloud account and
 *   region, which Cloudgate only looks up and never changes ({@link existing}).
 * - **`bucketName`** is the real name, Cloudgate's: minted once by the plan
 *   that creates it (`bucket-name.ts`) and never written in the config. An
 *   existing bucket's is the name the operator gave.
 * - **The key** (`accessKeyId`, `secretAccessKey`) is the one Garage key with
 *   read and write on this bucket only, never owner. Garage makes it on the
 *   first deploy, so both are `null` until then, and always together. Read
 *   back only as "set" (ADR-0019).
 *   **Rotate key** replaces it without cutting a linking Service off:
 *   the new key waits in `rotationKeys` until every linking Service runs
 *   with it, and only then is stored here and the old one removed.
 * - **`adminCredential`** is Cloudgate's own, per container. A bucket on
 *   AWS has no container and no key: its credential and volume name are
 *   made with it and never used (ADR-0032: on AWS a linking Service's task
 *   role gives access).
 *
 * Every credential is encrypted at rest (ADR-0006).
 */
export const bucket = pgTable(
  'bucket',
  {
    bucketId: nanoidPk('bucket_id'),
    /** The display name, Cloudgate's label. */
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    /** The Plan that last wrote this Service's config-owned fields. */
    configPlanId: text('config_plan_id').references(() => plan.planId, {
      onDelete: 'set null',
    }),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('bucket')),
    description: text('description'),
    bucketName: text('bucket_name').notNull(),
    accessKeyId: encryptedText('access_key_id'),
    secretAccessKey: encryptedText('secret_access_key'),
    adminCredential:
      encryptedJson<BucketAdminCredential>('admin_credential').notNull(),
    /**
     * Its Rotate key: the last one's progress or end, `null` until the
     * first. Cloudgate's alone, never the config's, with no schedule.
     */
    keyRotation: jsonb('key_rotation').$type<KeyRotation>(),
    /** A rotation's keys apart from the stored one; see {@link BucketRotationKeys}. */
    rotationKeys: encryptedJson<BucketRotationKeys>('rotation_keys'),
    /**
     * A bucket on Cloud Storage: which of its state's two HMAC key
     * slots holds the stored key. Each Rotate key that succeeds makes the
     * new key in the other slot and destroys the old one, so the key moves
     * between them; `null` is the first slot, where it is made. Always
     * `null` on a Server or on AWS.
     */
    googleKeySlot: text('google_key_slot').$type<GcpBucketKeySlot>(),
    /**
     * The web origins trusted to upload to it straight from a browser
     * each `scheme://host[:port]` (`bucket-origins.ts`). Cloudgate's,
     * never the Project config's, so a plan never reads or diffs it;
     * per Environment because the row is. Empty by default: no browser
     * uploads until the operator says so. On a Server it is the Garage
     * bucket's CORS; on AWS the S3 bucket's CORS resource is built from it.
     */
    origins: text('origins')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The origins its last Cloud run wrote to the S3 bucket's CORS:
     * what the next plan diffs {@link origins} against, so an edit on the
     * bucket's page plans as a CORS change. `null` on a Server, whose
     * Garage takes an edit at once, and until the first Cloud run ends.
     */
    appliedOrigins: text('applied_origins').array(),
    /** The Docker volume its files are on, on its run Server. */
    volumeName: text('volume_name').notNull(),
    /**
     * Its Garage service's labels on a Server: the one Swarm
     * setting a bucket's `native.docker` takes, written by a plan's Apply
     * and read by the Garage spec, so there is no second copy. Every other
     * Swarm setting of its Garage is Cloudgate's (ADR-0037). `null` is none,
     * and always `null` in a Cloud account.
     */
    labelsSwarm: json('labels_swarm').$type<LabelsSwarm>(),
    /**
     * The `native.aws` its config entry last applied (ADR-0044), as
     * written, on a bucket on S3: the next plan compares the entry's
     * against it, and each Cloud run and read for Drift lays it over
     * Cloudgate's definition. Never a record of anything Cloudgate writes
     * itself (ADR-0029). `null` when the entry has none, and off AWS.
     */
    nativeAws: jsonb('native_aws').$type<NativeAwsBlock>(),
    applicationStatus: applicationStatusEnum('application_status')
      .notNull()
      .default('idle'),
    createdAt: isoTimestamp('created_at'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
    /**
     * A bucket made in a Cloud account (ADR-0035): an S3 bucket in
     * that account and region, in its own Infrastructure state, set together
     * by the plan's Apply that creates it and never changed after. `null` on
     * a Server or the platform host.
     */
    cloudAccountId: text('cloud_account_id').references(
      () => cloudAccount.cloudAccountId,
      { onDelete: 'no action' },
    ),
    region: text('region'),
    /**
     * Its cloud Delete under way or incomplete; see
     * {@link BucketCloudDeleteRecord}. Always `null` on a Server, whose
     * Delete finishes in its request.
     */
    cloudDelete: jsonb('cloud_delete').$type<BucketCloudDeleteRecord>(),
    /**
     * An **existing bucket** (ADR-0033): one made outside Cloudgate,
     * named by the operator, in the Cloud account and region beside it,
     * fixed at creation. Every plan looks it up through a `data` source; no
     * Cloud run ever writes it, it has no Infrastructure state of its own,
     * and its Delete removes only Cloudgate's records. Its status is `done`
     * once a plan's lookup has found it, which its Outputs wait for.
     */
    existing: boolean('existing').notNull().default(false),
    /**
     * An existing bucket on Google Cloud's access check (ADR-0033 as
     * amended): whether a list of one file made with its key last
     * answered — `waiting` until it first does, `ok` once it did, `no-access`
     * when it fails after that. Set after the Cloud run that made the key,
     * at each plan and each read of its page; nothing waits on it or is
     * refused for it. `null` before its key exists, and for every other
     * bucket.
     */
    googleAccess: text('google_access').$type<GoogleBucketAccess>(),
    /** When {@link googleAccess} was last checked. */
    googleAccessCheckedAt: text('google_access_checked_at'),
    /**
     * An existing bucket on Google Cloud's own project, by the
     * number Cloud Storage answers its last lookup with: in any project, so
     * not always its Cloud account's. Its page names it. `null` before a
     * plan has looked it up, and for every other bucket.
     */
    googleProjectNumber: text('google_project_number'),
  },
  (t) => [
    ...configNameConstraints('bucket', t),
    // A Server (or the platform host) or a Cloud account + region.
    check(
      'bucket_place',
      sql`(${t.cloudAccountId} IS NULL) = (${t.region} IS NULL) AND (${t.cloudAccountId} IS NULL OR ${t.serverId} IS NULL)`,
    ),
    // An existing bucket is only ever in a Cloud account.
    check(
      'bucket_existing_in_cloud',
      sql`NOT ${t.existing} OR ${t.cloudAccountId} IS NOT NULL`,
    ),
    check(
      'bucket_key_whole',
      sql`(${t.accessKeyId} IS NULL) = (${t.secretAccessKey} IS NULL)`,
    ),
  ],
);

export const bucketRelations = relations(bucket, ({ one }) => ({
  environment: one(environment, {
    fields: [bucket.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [bucket.serverId],
    references: [server.serverId],
  }),
}));

export type Bucket = typeof bucket.$inferSelect;
