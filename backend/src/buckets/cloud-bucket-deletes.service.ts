import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import { CLOUD_DELETE_REFUSED_CODE } from '../applications/cloud-delete-refusal';
import { deleteReportLines } from '../cloud-accounts/aws/delete-check';
import type {
  KeptResource,
  Leftover,
} from '../cloud-accounts/aws/delete-check';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { CLOUD_NAMES, onCloud } from '../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT, CHANGED_NOTHING } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  GoogleCredential,
} from '../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import {
  GCP_BUCKET_ACCOUNT_ADDRESS,
  GCP_BUCKET_ADDRESS,
  GCP_BUCKET_BINDING_ADDRESS,
  gcpBucketDefinition,
} from '../cloud-accounts/gcp/definitions/bucket-definition';
import { destroyDefinition as googleDestroyDefinition } from '../cloud-accounts/gcp/definitions/destroy-definition';
import { GOOGLE_CLEAN_DELETE_LINE } from '../cloud-accounts/gcp/delete-check';
import { GOOGLE_CLOUD_PORT } from '../cloud-accounts/google-cloud.port';
import type { GoogleCloudPort } from '../cloud-accounts/google-cloud.port';
import type { InfrastructureState } from '../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { bucket, deployment } from '../db/schema';
import { CloudReadWorks } from '../deployment-queue/cloud-read-work';
import { NothingRemoved } from '../common/nothing-removed';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../deployment-queue/cloud-run-job.types';
import {
  CloudRunsService,
  endingDescription,
} from '../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { OBJECT_STORAGE } from '../object-storage/object-storage.port';
import type {
  BucketContents,
  ObjectStoragePort,
} from '../object-storage/object-storage.port';
import { writeKept } from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import type { PermissionCtx } from '../rbac/permission.service';
import { keepsFiles } from './bucket-files';
import type { CloudBucketKept } from './bucket-files';
import type { Bucket, BucketCloudDeleteRecord } from './bucket.schema';
import {
  bucketContents,
  destroyAndCheck,
  emptyBucket,
  ENDED_BEFORE_DESTROYING,
  keptOf,
  keptResource,
  partlyEmptied,
  placeOf,
} from './cloud-bucket-delete-steps';
import {
  bucketAccountName,
  changesAt,
  googleBucketContents,
  googleKeptOf,
  googleKeptResource,
  googlePartlyEmptied,
  NO_BUCKET_TO_EMPTY,
} from './google-bucket-delete-steps';
import { googleKeyAddresses, googleKeyLayout } from './google-key-layout';
import { leftGrantOf } from './google-bucket-access';

/**
 * How a bucket's cloud Delete began: on AWS kept and gone at once (it holds
 * files, or could not be read, and its files were not asked to go), or a
 * destroy-only Cloud run queued, whose `ended` resolves once its row is
 * written. On Google Cloud a kept bucket's key and service account still go
 * by a Cloud run, so it is `deleting` and names the bucket `kept`.
 */
export type CloudBucketDeleteStarted =
  | { readonly kind: 'kept'; readonly kept: CloudBucketKept }
  | {
      readonly kind: 'deleting';
      readonly deploymentId: string;
      readonly ended: Promise<void>;
      /** On Google Cloud, the bucket this Delete keeps while its run destroys the key. */
      readonly kept?: CloudBucketKept;
    };

/** What each cloud's half decided before a run is queued. */
type Begun =
  | { readonly kind: 'kept'; readonly kept: CloudBucketKept }
  | {
      readonly kind: 'run';
      readonly description: string;
      /** Google Cloud's kept bucket: named now, its key destroyed by the run. */
      readonly kept: { answer: CloudBucketKept; report: KeptResource } | null;
    };

/**
 * **A bucket on AWS's Delete** (inside the spec's
 * cloud Delete, ADR-0038). The Server bucket's rules, applied to an S3
 * bucket:
 *
 * - **A bucket that holds files** — any object, old version or delete
 *   marker — or that cannot be read is **kept**: nothing in AWS is touched
 *   (its settings stay with it, and it keeps Cloudgate's tag), its row and
 *   Infrastructure state go at once, and it is named once, with its account
 *   and region, as *Kept*. A kept bucket is never "Delete incomplete".
 * - **An empty bucket** is destroyed by a destroy-only Cloud run, a
 *   Deployment of the bucket, checked afterwards by its state's tag.
 * - **"Also delete its files"** (`deleteFiles`, only from the bucket's own
 *   Delete or its Plan destroy) makes that run empty the bucket first, old
 *   versions and delete markers included, through the object-storage port,
 *   then destroy it. An emptying that stops partway finishes the Delete with
 *   nothing destroyed and the bucket *Left*, "partly emptied": the row stays
 *   Delete incomplete, with Retry (which empties again) and Forget.
 *
 * Whether it holds files is read through the object-storage port against
 * S3 with the deploy role's session, when the Delete is asked and again as
 * its run starts: a file written in between keeps the bucket too.
 *
 * **On Google Cloud** (spec "Bucket on Cloud Storage") the same
 * rules hold, with the check a one-result list through the Google client
 * port, and one more: **the HMAC key and the bucket's service account are
 * always destroyed**, whether the bucket is deleted, kept or left, so no
 * live key outlives Cloudgate's memory of it. A kept bucket is named at
 * once, and a destroy-only Cloud run limited to its key, account and
 * binding takes them, then the state (the bucket with it) and row go. "Also
 * delete its files" sets the provider's `force_destroy` by an apply limited
 * to the bucket, for that run only, and the destroy empties and deletes it;
 * one that stops partway leaves the bucket *Left*, "partly emptied", its key
 * already gone. See {@link CloudBucketDeletes.destroyOnGoogle}.
 */
@Injectable()
export class CloudBucketDeletes implements OnModuleInit {
  private readonly logger = new Logger(CloudBucketDeletes.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly deployments: DeploymentsService,
    private readonly auditLogs: AuditLogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('bucket-destroy', (job, control) => this.run(job, control));
  }

  /**
   * The Delete (or, `retrying`, its Retry): refused while one runs, a first
   * Delete refused once incomplete, and a Delete whose Cloud account cannot
   * be reached refused with nothing removed. A Retry empties again only if
   * the Delete it retries asked to.
   */
  async start(
    ctx: PermissionCtx,
    found: Bucket,
    options: { readonly deleteFiles: boolean; readonly retrying: boolean },
    keep: KeepConfig,
  ): Promise<CloudBucketDeleteStarted> {
    const { cloudAccountId, region } = placeOf(found);
    const record = await this.settled(found);
    if (record?.status === 'deleting') {
      throw refused(`${found.name} is already being deleted`);
    }
    if (!options.retrying && record?.status === 'incomplete') {
      throw refused(
        `${found.name} is Delete incomplete: Retry the Delete, or Forget it`,
      );
    }
    if (options.retrying && record?.status !== 'incomplete') {
      throw refused(
        `${found.name} has no Delete to retry: Retry is for a bucket whose Delete is incomplete`,
      );
    }
    const deleteFiles = options.retrying
      ? (record?.deleteFiles ?? false)
      : options.deleteFiles;

    const cloudAccountRow = await this.cloudAccounts.findForUse(cloudAccountId);
    if (!cloudAccountRow) {
      throw refused(
        'The Cloud account this bucket is in is gone. Nothing was removed',
      );
    }
    // Each cloud's half (ADR-0043).
    const begun = await onCloud<Promise<Begun>>(cloudAccountRow, {
      aws: (account) => this.beginOnAws(found, account, region, deleteFiles),
      gcp: (account) => this.beginOnGoogle(found, account, region, deleteFiles),
    });
    if (begun.kind === 'kept') {
      await this.forgetKept(found, keep);
      return begun;
    }

    const run = await this.deployments.recordBucketCloudRun({
      bucketId: found.bucketId,
      appName: found.appName,
      title: options.retrying ? 'Retry Delete' : 'Delete',
      description: begun.description,
    });
    try {
      await writeKept(
        this.db,
        keep,
        async (db) => {
          const [written] = await db
            .update(bucket)
            .set({
              cloudDelete: {
                status: 'deleting',
                deploymentId: run.deploymentId,
                retrying: options.retrying,
                deleteFiles,
                requestedBy: {
                  userId: ctx.user.id,
                  organizationId: ctx.session.activeOrganizationId,
                },
                kept: begun.kept ? [begun.kept.report] : [],
                left: record?.left ?? [],
                unfinished: null,
              },
            })
            .where(eq(bucket.bucketId, found.bucketId))
            .returning({ bucketId: bucket.bucketId });
          return written;
        },
        (written) =>
          written ? { serviceId: found.bucketId, removed: {} } : null,
      );
    } catch (error) {
      await this.db
        .delete(deployment)
        .where(eq(deployment.deploymentId, run.deploymentId));
      throw error;
    }

    const ended = this.cloudRuns
      .submit(run.deploymentId, {
        kind: 'bucket-destroy',
        stateKey: `bucket:${found.bucketId}`,
        environmentId: found.environmentId,
        touchesNetwork: false,
      })
      .then(async (ending) => {
        if (ending.kind === 'shutdown' && !ending.started) return;
        await this.endedOutside(
          found.bucketId,
          run.deploymentId,
          ending.kind === 'cancelled'
            ? null
            : (endingDescription(ending) ?? 'The Delete ended'),
        );
      })
      .catch(() => undefined);
    return {
      kind: 'deleting',
      deploymentId: run.deploymentId,
      ended,
      ...(begun.kept ? { kept: begun.kept.answer } : {}),
    };
  }

  /**
   * AWS's half of the Delete's start: reached with the deploy role,
   * and a bucket not asked to lose its files that holds any is kept at once.
   */
  private async beginOnAws(
    found: Bucket,
    account: AwsCloudAccount,
    region: string,
    deleteFiles: boolean,
  ): Promise<Begun> {
    const session = await this.cloudAccounts.deployRoleSession(account);
    if (!session.ok) throw refused(`${session.refusal}. Nothing was removed`);

    // Not asked to delete its files: one that holds any is kept, at once.
    if (!deleteFiles) {
      const files = await bucketContents(
        this.objectStorage,
        this.logger,
        found,
        region,
        session.session,
      );
      if (keepsFiles(files)) {
        return { kind: 'kept', kept: keptOf(found, account, region, files) };
      }
    }
    return {
      kind: 'run',
      kept: null,
      description: deleteFiles
        ? `Empties the S3 bucket ${found.bucketName}, then destroys everything in its Infrastructure state in ${region}`
        : `Destroys the empty S3 bucket ${found.bucketName} and everything in its Infrastructure state in ${region}`,
    };
  }

  /**
   * Google Cloud's half of the Delete's start: reached with the
   * Cloud account's run session, and a bucket not asked to lose its files
   * that holds any is named kept now, while its run destroys its key. An
   * existing bucket's files are never read: its run destroys only
   * its key and account.
   */
  private async beginOnGoogle(
    found: Bucket,
    account: GcpCloudAccount,
    region: string,
    deleteFiles: boolean,
  ): Promise<Begun> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) throw refused(`${session.refusal}. Nothing was removed`);
    if (found.existing) {
      return {
        kind: 'run',
        kept: null,
        description: `Destroys the HMAC key and service account Cloudgate made for the existing bucket ${found.bucketName}, and leaves ${found.bucketName} and its files as they were`,
      };
    }
    if (!deleteFiles) {
      const files = await googleBucketContents(
        this.google,
        this.logger,
        found,
        session.token,
      );
      if (files !== 'empty') {
        return {
          kind: 'run',
          kept: {
            answer: googleKeptOf(found, account, region, files),
            report: googleKeptResource(found, account, region),
          },
          description: `Keeps the Cloud Storage bucket ${found.bucketName}, which ${files === 'unknown' ? 'could not be read' : 'holds files'}, and destroys its HMAC key and service account in ${region}`,
        };
      }
    }
    return {
      kind: 'run',
      kept: null,
      description: deleteFiles
        ? `Empties the Cloud Storage bucket ${found.bucketName}, then destroys everything in its Infrastructure state in ${region}`
        : `Destroys the empty Cloud Storage bucket ${found.bucketName} and everything in its Infrastructure state in ${region}`,
    };
  }

  /**
   * Whether it holds files, for its destroy row in a plan:
   * through the port against S3 with the deploy role's session. Never
   * throws: an account that cannot be reached is `unknown`, can't tell.
   */
  async filesOf(found: Bucket): Promise<BucketContents> {
    const { cloudAccountId, region } = placeOf(found);
    const cloudAccountRow = await this.cloudAccounts.findForUse(cloudAccountId);
    if (!cloudAccountRow) return 'unknown';
    return onCloud<Promise<BucketContents>>(cloudAccountRow, {
      aws: async (account) => {
        const session = await this.cloudAccounts
          .deployRoleSession(account)
          .catch(() => null);
        if (!session?.ok) return 'unknown';
        return bucketContents(
          this.objectStorage,
          this.logger,
          found,
          region,
          session.session,
        );
      },
      // Through the Google client port, with the run session's token.
      gcp: async (account) => {
        const session = await this.cloudAccounts
          .googleRunSession(account)
          .catch(() => null);
        if (!session?.ok) return 'unknown';
        return googleBucketContents(
          this.google,
          this.logger,
          found,
          session.token,
        );
      },
    });
  }

  /**
   * Forget: the row and state dropped with what is left still in AWS, the
   * list written into the audit entry (ADR-0038).
   */
  async forget(ctx: PermissionCtx, found: Bucket) {
    const record = await this.settled(found);
    if (record?.status !== 'incomplete') {
      throw refused(
        record?.status === 'deleting'
          ? `${found.name} is being deleted; Forget is for a Delete that is incomplete`
          : `${found.name} has no incomplete Delete to forget`,
      );
    }
    await this.drop(found.bucketId);
    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId: ctx.session.activeOrganizationId },
      {
        action: 'delete',
        resourceType: 'bucket',
        resourceId: found.bucketId,
        resourceName: found.name,
        metadata: {
          cloudDelete: 'forgotten',
          left: record.left,
          ...(record.unfinished ? { unfinished: record.unfinished } : {}),
        },
      },
    );
    return { bucketId: found.bucketId, forgotten: record.left };
  }

  /**
   * An incomplete Delete forgotten as part of its Environment's Forget
   * the state and row dropped, answering what was left.
   */
  async discard(found: Bucket): Promise<Leftover[]> {
    const record = await this.settled(found);
    await this.drop(found.bucketId);
    return [...(record?.left ?? [])];
  }

  /**
   * The record as it stands. A `deleting` whose run is no longer queued or
   * running was cut off by a restart: it reads as incomplete, so Retry and
   * Forget reach it.
   */
  async settled(found: Bucket): Promise<BucketCloudDeleteRecord | null> {
    const record = found.cloudDelete;
    if (record?.status !== 'deleting') return record;
    const [run] = await this.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.deploymentId, record.deploymentId));
    if (run && (run.status === 'pending' || run.status === 'running')) {
      return record;
    }
    return {
      ...record,
      status: 'incomplete',
      unfinished:
        record.unfinished ?? 'The Delete was cut off before it finished',
    };
  }

  /** A kept bucket's row and state go; nothing in AWS is touched. */
  private async forgetKept(found: Bucket, keep: KeepConfig): Promise<void> {
    const state = await this.states.findForBucket(found.bucketId);
    if (state) await this.states.remove(state.infrastructureStateId);
    await writeKept(
      this.db,
      keep,
      (db) => db.delete(bucket).where(eq(bucket.bucketId, found.bucketId)),
      () => ({ serviceId: found.bucketId, removed: {} }),
    );
  }

  /** The state and the row (its Deployments with it). */
  private async drop(bucketId: string): Promise<void> {
    const state = await this.states.findForBucket(bucketId);
    if (state) await this.states.remove(state.infrastructureStateId);
    await this.db.delete(bucket).where(eq(bucket.bucketId, bucketId));
  }

  /** The run, as the pool runs it. */
  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.bucketId) throw new Error('This Cloud run records no bucket');
    const [found] = await this.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, row.bucketId));
    const record = found?.cloudDelete;
    if (!found?.cloudAccountId || !found.region || !record) {
      throw new Error('This bucket has no Delete under way');
    }
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    try {
      await this.destroy(found, record, control, log);
    } catch (error) {
      if (error instanceof NothingRemoved) {
        await log(`❌ [Cloud run] ${error.message}`);
        await this.revert(found.bucketId, record, error.message);
      }
      throw error;
    }
  }

  private async destroy(
    found: Bucket,
    record: BucketCloudDeleteRecord,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const { cloudAccountId } = placeOf(found);
    const cloudAccountRow = await this.cloudAccounts.findForUse(cloudAccountId);
    if (!cloudAccountRow) {
      throw new NothingRemoved(
        'The Cloud account this bucket is in is gone. Nothing was removed',
      );
    }
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) => this.destroyOnAws(found, record, account, control, log),
      gcp: (account) =>
        this.destroyOnGoogle(found, record, account, control, log),
    });
  }

  /** A bucket on AWS's run: kept, emptied, or destroyed and checked by its tag. */
  private async destroyOnAws(
    found: Bucket,
    record: BucketCloudDeleteRecord,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const { region } = placeOf(found);
    const reached = await this.cloudAccounts.deployRoleSession(account);
    if (!reached.ok) {
      throw new NothingRemoved(`${reached.refusal}. Nothing was removed`);
    }
    const state = await this.states.findForBucket(found.bucketId);
    await log(
      `🗑️ [Cloud run] Deleting bucket ${found.name} (${found.bucketName}) from Cloud account ${account.name} in ${region}`,
    );

    // Its files, read again now: the Delete never loses them by accident.
    const files = await bucketContents(
      this.objectStorage,
      this.logger,
      found,
      region,
      reached.session,
    );
    if (keepsFiles(files) && !record.deleteFiles) {
      const kept = keptResource(found, account, region);
      await log(
        `${found.bucketName} ${files === 'unknown' ? 'could not be read' : 'holds files'}, so it is kept and nothing in AWS was destroyed`,
      );
      for (const line of deleteReportLines({ kept: [kept], left: [] })) {
        await log(line);
      }
      await this.finish(found, record, [kept]);
      return;
    }
    if (keepsFiles(files)) {
      await log(
        `🧹 [Cloud run] Emptying ${found.bucketName}: every object, old version and delete marker`,
      );
      const emptied = await emptyBucket(
        this.objectStorage,
        found,
        region,
        reached.session,
      );
      if (!emptied.ok) {
        // Partly emptied: it still holds files, so nothing is destroyed and
        // the bucket is left, which keeps the row (ADR-0038).
        await log(
          `⚠️ [Cloud run] Emptying ${found.bucketName} stopped partway: ${emptied.message}`,
        );
        const left: Leftover[] = [partlyEmptied(found, region, state)];
        await this.incomplete(
          found,
          record,
          left,
          null,
          log,
          'Retry empties it again, then destroys it',
          CLOUD_NAMES.aws,
        );
        return;
      }
      await log(`${found.bucketName} is empty`);
    }

    const { unfinished, left } = await destroyAndCheck(
      {
        states: this.states,
        cloudAccounts: this.cloudAccounts,
        cloud: this.cloud,
      },
      { found, account, region, state, control, log },
    );

    if (unfinished === null && left.length === 0) {
      for (const line of deleteReportLines({ kept: [], left })) {
        await log(line);
      }
      await this.finish(found, record, []);
      return;
    }
    await this.incomplete(
      found,
      record,
      left,
      unfinished,
      log,
      'Retry destroys again from the kept state',
      CLOUD_NAMES.aws,
    );
  }

  /**
   * A bucket on Google Cloud's run. Its files are read again now,
   * unless its Delete already named it kept. Then, in order:
   *
   * 1. **The key first**, whenever the bucket may stay (it holds files, or
   *    could not be read): a destroy limited to the HMAC key, the bucket's
   *    service account and its binding, so no live key outlives the Delete
   *    whether the bucket is kept, emptied or left.
   * 2. **Kept**: the state, the bucket in it, and the row go; nothing else
   *    is touched, and the bucket keeps Cloudgate's labels.
   * 3. **"Also delete its files"**: an apply limited to the bucket sets
   *    `force_destroy` in the state, for this run only.
   * 4. **The destroy** of everything the state holds, which empties the
   *    bucket first when `force_destroy` is set. One that fails with the
   *    bucket still holding files leaves it *Left*, "partly emptied", and
   *    the row Delete incomplete for Retry, which empties again, or Forget.
   */
  private async destroyOnGoogle(
    found: Bucket,
    record: BucketCloudDeleteRecord,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const { region } = placeOf(found);
    const where = CLOUD_NAMES.gcp;
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) {
      throw new NothingRemoved(`${session.refusal}. Nothing was removed`);
    }
    const state = await this.states.findForBucket(found.bucketId);
    await log(
      `🗑️ [Cloud run] Deleting bucket ${found.name} (${found.bucketName}) from Cloud account ${account.name} in ${region}`,
    );
    if (!state) {
      await log(
        `${found.name} has no Infrastructure state: nothing was made for it in Google Cloud`,
      );
      await this.finish(found, record, record.kept);
      return;
    }
    if (found.existing) {
      await this.destroyExistingOnGoogle(found, record, account, {
        state,
        credential: session.credential,
        control,
        log,
      });
      return;
    }
    const files =
      record.kept.length > 0
        ? 'holds-files'
        : await googleBucketContents(
            this.google,
            this.logger,
            found,
            session.token,
          );
    const said = (message: string) =>
      googleRefusalReason(message, account.cloudId);

    // 1. The key and its account, before anything touches the bucket.
    let changed = false;
    if (keepsFiles(files)) {
      await log(
        `🔑 [Cloud run] Destroying ${found.bucketName}'s HMAC key and its service account ${bucketAccountName(found)}`,
      );
      const key = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: session.credential,
        definition: googleDestroyDefinition(account.cloudId, region),
        // Whichever slots hold a key: a rotation may have moved
        // the live one, or hold a spare beside it.
        targets: [
          GCP_BUCKET_BINDING_ADDRESS,
          ...googleKeyAddresses(googleKeyLayout(found)),
          GCP_BUCKET_ACCOUNT_ADDRESS,
        ],
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () =>
          control.beginApply() ? null : ENDED_BEFORE_DESTROYING,
      });
      if (!key.ok) {
        if (CHANGED_NOTHING.has(key.reason)) {
          throw new NothingRemoved(`${key.message} Nothing was removed`);
        }
        await this.incomplete(
          found,
          record,
          [],
          `${found.bucketName}'s HMAC key and service account ${bucketAccountName(found)} were not destroyed: ${said(key.message)}`,
          log,
          'Retry destroys them again from the kept state',
          where,
        );
        return;
      }
      changed = true;
      await log(
        `${found.bucketName}'s HMAC key and service account are destroyed`,
      );
    }

    // 2. Kept: the bucket is taken out of the state with the state itself.
    if (keepsFiles(files) && !record.deleteFiles) {
      const kept =
        record.kept.length > 0
          ? record.kept
          : [googleKeptResource(found, account, region)];
      await log(
        `${found.bucketName} ${files === 'unknown' ? 'could not be read' : 'holds files'}, so it is kept with Cloudgate's labels; only its key and service account were destroyed`,
      );
      for (const line of deleteReportLines(
        { kept, left: [] },
        GOOGLE_CLEAN_DELETE_LINE,
      )) {
        await log(line);
      }
      await this.finish(found, record, kept);
      return;
    }

    // 3. "Also delete its files": force_destroy, for this run only.
    if (keepsFiles(files)) {
      await log(
        `🧹 [Cloud run] Emptying ${found.bucketName}: its destroy deletes every object first, for this run only`,
      );
      const forced = await this.forceDestroyIn(found, account, {
        state,
        credential: session.credential,
        control,
        log,
      });
      if (!forced.ok) {
        await this.incomplete(
          found,
          record,
          [],
          `${said(forced.message)} Its key and service account are destroyed; the bucket was not emptied`,
          log,
          'Retry empties it again, then destroys it',
          where,
        );
        return;
      }
    }

    // 4. The destroy of everything in the state.
    await log(
      `Destroying everything in Infrastructure state ${state.infrastructureStateId}`,
    );
    let began = false;
    const outcome = await this.states.destroy({
      stateId: state.infrastructureStateId,
      credential: session.credential,
      definition: googleDestroyDefinition(account.cloudId, region),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: () => {
        if (control.beginApply()) {
          began = true;
          return null;
        }
        return ENDED_BEFORE_DESTROYING;
      },
    });
    if (outcome.ok) {
      for (const line of deleteReportLines(
        { kept: [], left: [] },
        GOOGLE_CLEAN_DELETE_LINE,
      )) {
        await log(line);
      }
      await this.finish(found, record, []);
      return;
    }
    if (CHANGED_NOTHING.has(outcome.reason) && !changed) {
      throw new NothingRemoved(`${outcome.message} Nothing was removed`);
    }
    // Emptying that stopped partway: the bucket still holds files.
    if (record.deleteFiles && keepsFiles(files)) {
      const still = await googleBucketContents(
        this.google,
        this.logger,
        found,
        session.token,
      );
      if (keepsFiles(still)) {
        await log(
          `⚠️ [Cloud run] Emptying ${found.bucketName} stopped partway: ${said(outcome.message)}`,
        );
        await this.incomplete(
          found,
          record,
          [googlePartlyEmptied(found, region, state)],
          null,
          log,
          'Retry empties it again, then destroys it',
          where,
        );
        return;
      }
    }
    await this.incomplete(
      found,
      record,
      [],
      began
        ? said(outcome.message)
        : `${said(outcome.message)} The run ended before it destroyed anything`,
      log,
      'Retry destroys again from the kept state',
      where,
    );
  }

  /**
   * An existing bucket on Google Cloud's run (ADR-0033 as
   * amended): its state holds only its own service account and key, so a
   * destroy of the whole state takes them, and the bucket and its files are
   * never touched. The grant the operator added is theirs and stays,
   * naming a service account that is gone; the log names the line that
   * removes it.
   */
  private async destroyExistingOnGoogle(
    found: Bucket,
    record: BucketCloudDeleteRecord,
    account: GcpCloudAccount,
    run: {
      readonly state: InfrastructureState;
      readonly credential: GoogleCredential;
      readonly control: CloudRunControl;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<void> {
    const { region } = placeOf(found);
    const { state, control, log } = run;
    await log(
      `🔑 [Cloud run] Destroying the HMAC key and service account ${bucketAccountName(found)} Cloudgate made for the existing bucket ${found.bucketName}; ${found.bucketName} and its files are left as they were`,
    );
    let began = false;
    const outcome = await this.states.destroy({
      stateId: state.infrastructureStateId,
      credential: run.credential,
      definition: googleDestroyDefinition(account.cloudId, region),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: () => {
        if (control.beginApply()) {
          began = true;
          return null;
        }
        return ENDED_BEFORE_DESTROYING;
      },
    });
    if (!outcome.ok) {
      if (CHANGED_NOTHING.has(outcome.reason)) {
        throw new NothingRemoved(`${outcome.message} Nothing was removed`);
      }
      const said = googleRefusalReason(outcome.message, account.cloudId);
      await this.incomplete(
        found,
        record,
        [],
        began
          ? `${found.bucketName}'s HMAC key and service account ${bucketAccountName(found)} were not destroyed: ${said}`
          : `${said} The run ended before it destroyed anything`,
        log,
        'Retry destroys them again from the kept state',
        CLOUD_NAMES.gcp,
      );
      return;
    }
    const grant = leftGrantOf(found, account.cloudId);
    await log(
      `${found.bucketName} was left as it was, files and all. The grant you added on it is left too, naming ${grant.serviceAccount}, which is gone; remove it with \`${grant.command}\``,
    );
    for (const line of deleteReportLines(
      { kept: [], left: [] },
      GOOGLE_CLEAN_DELETE_LINE,
    )) {
      await log(line);
    }
    await this.finish(found, record, []);
  }

  /**
   * The apply before a Google bucket's emptying, limited to the
   * bucket: its definition as last applied with `force_destroy` on, which
   * changes only what the state holds. A plan that would make the bucket
   * (the state no longer holds it) has nothing to empty and is not applied;
   * one that would replace or remove it stops the Delete, since a destroy is
   * the only thing that removes.
   */
  private async forceDestroyIn(
    found: Bucket,
    account: GcpCloudAccount,
    run: {
      readonly state: InfrastructureState;
      readonly credential: GoogleCredential;
      readonly control: CloudRunControl;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { region } = placeOf(found);
    const { state, control, log } = run;
    const definition = gcpBucketDefinition({
      serviceId: found.bucketId,
      bucketName: found.bucketName,
      cloudAccountId: account.cloudAccountId,
      projectId: account.cloudId,
      region,
      environmentId: found.environmentId,
      stateId: state.infrastructureStateId,
      origins: found.appliedOrigins ?? [],
      keys: googleKeyLayout(found),
      forceDestroy: true,
    });
    let absent = false;
    const outcome = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential: run.credential,
      definition,
      targets: [GCP_BUCKET_ADDRESS],
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: (show) => {
        const actions = changesAt(show, GCP_BUCKET_ADDRESS);
        if (actions.includes('create') && !actions.includes('delete')) {
          absent = true;
          return NO_BUCKET_TO_EMPTY;
        }
        if (actions.includes('delete') || actions.includes('create')) {
          return {
            ok: false,
            reason: 'failed',
            message: `Google Cloud no longer matches ${found.name}'s state: emptying it would replace it. Check for changes, then Retry the Delete.`,
          };
        }
        return control.beginApply() ? null : ENDED_BEFORE_DESTROYING;
      },
    });
    if (absent) {
      await log(
        `Infrastructure state ${state.infrastructureStateId} holds no bucket: there is nothing to empty`,
      );
      return { ok: true };
    }
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  }

  /** Delete incomplete: the row kept with what is left, and the run failed. */
  private async incomplete(
    found: Bucket,
    record: BucketCloudDeleteRecord,
    left: Leftover[],
    unfinished: string | null,
    log: (line: string) => Promise<void>,
    retry: string,
    where: string,
  ): Promise<never> {
    for (const line of deleteReportLines({ kept: [], left })) await log(line);
    await this.db
      .update(bucket)
      .set({
        cloudDelete: { ...record, status: 'incomplete', left, unfinished },
      })
      .where(eq(bucket.bucketId, found.bucketId));
    const summary = `Delete incomplete: ${
      left.length > 0
        ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in ${where}`
        : unfinished
    }. ${retry}`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /** A finish with nothing left: the state and row dropped, the Delete audited. */
  private async finish(
    found: Bucket,
    record: BucketCloudDeleteRecord,
    kept: readonly KeptResource[],
  ): Promise<void> {
    await this.drop(found.bucketId);
    const asked = record.requestedBy;
    if (!asked) return;
    await this.auditLogs.audit(asked, {
      action: 'delete',
      resourceType: 'bucket',
      resourceId: found.bucketId,
      resourceName: found.name,
      metadata: {
        cloudDelete: 'finished',
        ...(kept.length > 0 ? { kept } : {}),
      },
    });
  }

  /** Back to how the bucket was before this run: nothing was removed. */
  private async revert(
    bucketId: string,
    record: BucketCloudDeleteRecord,
    why: string,
  ): Promise<void> {
    await this.db
      .update(bucket)
      .set({
        cloudDelete: record.retrying
          ? { ...record, status: 'incomplete', unfinished: why }
          : null,
      })
      .where(eq(bucket.bucketId, bucketId));
  }

  /**
   * A run's ending its handler did not record: a Cancel before it began
   * (`why` null) puts the bucket back; anything else that left it
   * `deleting` leaves it incomplete.
   */
  private async endedOutside(
    bucketId: string,
    deploymentId: string,
    why: string | null,
  ): Promise<void> {
    const [found] = await this.db
      .select({ cloudDelete: bucket.cloudDelete })
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    const record = found?.cloudDelete;
    if (!record || record.deploymentId !== deploymentId) return;
    if (why === null) {
      await this.revert(bucketId, record, 'The Delete was cancelled');
      return;
    }
    if (record.status !== 'deleting') return;
    await this.db
      .update(bucket)
      .set({
        cloudDelete: { ...record, status: 'incomplete', unfinished: why },
      })
      .where(eq(bucket.bucketId, bucketId));
  }
}

function refused(message: string): ConflictException {
  return new ConflictException({ message, code: CLOUD_DELETE_REFUSED_CODE });
}
