import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import type { ApplicationStatus } from '../../applications/application.schema';
import { bucketDefinition } from '../../cloud-accounts/aws/definitions/bucket-definition';
import { withImports } from '../../cloud-accounts/aws/definitions/imports';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import {
  byCloud,
  cloudOrLegacy,
  credentialOf,
  onCloud,
} from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
  PerCloud,
} from '../../cloud-accounts/cloud-provider';
import {
  bucketKeyAccountEmail,
  GCP_BUCKET_OUTPUTS,
  gcpBucketDefinition,
} from '../../cloud-accounts/gcp/definitions/bucket-definition';
import { bucketAccessGrant } from '../../cloud-accounts/gcp/plan-reader/existing-bucket';
import { GOOGLE_CLOUD_PORT } from '../../cloud-accounts/google-cloud.port';
import type { GoogleCloudPort } from '../../cloud-accounts/google-cloud.port';
import {
  accessSentence,
  checkGoogleBucketAccess,
} from '../../buckets/google-bucket-access';
import { withGoogleImports } from '../../cloud-accounts/gcp/definitions/imports';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { googleKeyLayout } from '../../buckets/google-key-layout';
import { OBJECT_STORAGE } from '../../object-storage/object-storage.port';
import type { ObjectStoragePort } from '../../object-storage/object-storage.port';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { bucket, cloudAccount, deployment } from '../../db/schema';
import type { Bucket, Deployment } from '../../db/schema';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { describeError } from '../../common/describe-error';
import type { PlanStepDeploy } from './apply.types';
import { approvedOnPlan, beforeApplyingApproved } from './approved-run';
import type { ApprovedRun } from './approved-run';
import { blameNativeAws, storedNativeAwsRefusal } from '../../native/aws-lay';
import {
  applyApprovedOnGoogle,
  googleRunProof,
  outputText,
} from './google-apply';

/**
 * **A bucket in a Cloud account is made by a Cloud run** (the AWS buckets spec
 * "Bucket on AWS"), the way a postgres on RDS is (`CloudPostgresRuns`): an S3
 * bucket on AWS, and on Google Cloud a Cloud Storage bucket with its
 * own service account and HMAC key, whose run saves the key it made. Each
 * cloud's half is chosen by the Cloud account's cloud (ADR-0043).
 *
 * An Apply that creates a cloud `bucket` writes its row (its Cloud account,
 * region and the real name the plan minted), keeps the Infrastructure state
 * its plan read against, and records the run as a Deployment whose parent is
 * the bucket (ADR-0017 extended), its log on the platform host. The run
 * writes the definition from the row — the bucket, its settings, and its
 * CORS from the origins its page holds — reads AWS again, and applies only
 * if that plan makes what the Apply approved (the AWS spec "Cloud run"). What
 * the plan adopted by tag is imported, never made twice.
 *
 * **A change is the same run.** An Apply of a CORS change (origins edited on
 * the bucket's page) or of a read that found Drift records a run that writes
 * the definition again and puts AWS back to it. Once it ends, the origins it
 * wrote are the bucket's `appliedOrigins`, which the next plan diffs the
 * page's against.
 *
 * **An existing bucket on Google Cloud** has the same run, which
 * makes only its own service account and key and saves the key; then a
 * list of one file made with that key tells its page whether the operator
 * has granted the key access yet. The bucket itself is never written.
 *
 * The bucket's status follows the run: `running`, then `done` or `error`.
 * What it does is read from the Deployment row and the plan whose Apply
 * recorded it, so a run start-up queues again runs alike.
 */
@Injectable()
export class CloudBucketRuns implements OnModuleInit {
  private readonly logger = new Logger(CloudBucketRuns.name);
  /** What each Apply approved for the run it recorded, until the run reads it. */
  private readonly approved = new Map<string, ApprovedRun>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('bucket', (job, control) => this.run(job, control));
  }

  /**
   * The create's or change's run, recorded and submitted to the pool: the
   * step's result names its Deployment, whose log the operator follows.
   * Answers once the run waits, not once it ends.
   */
  async start(
    made: { bucketId: string; appName: string; configName: string },
    environmentId: string,
    approved: PlanReading & { readonly stateId: string },
    change: boolean,
  ): Promise<PlanStepDeploy> {
    const [placed] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(bucket)
      .leftJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, bucket.cloudAccountId),
      )
      .where(eq(bucket.bucketId, made.bucketId));
    const product = byCloud(cloudOrLegacy(placed?.cloud), BUCKET_PRODUCT);
    const record = await this.deployments.recordBucketCloudRun({
      bucketId: made.bucketId,
      appName: made.appName,
      title: `${change ? 'Change' : 'Create'} ${made.configName} on ${product}`,
      description: `Applied from a plan, into Infrastructure state ${approved.stateId}`,
    });
    this.approved.set(record.deploymentId, { reading: approved, change });
    await this.setStatus(made.bucketId, 'running');
    void this.cloudRuns
      .submit(record.deploymentId, {
        kind: 'bucket',
        stateKey: `bucket:${made.bucketId}`,
        environmentId,
        touchesNetwork: false,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Cloud run ${record.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return { status: 'queued', deploymentId: record.deploymentId };
  }

  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.bucketId) throw new Error('This Cloud run records no bucket');
    try {
      await this.make(row, row.bucketId, control);
      await this.setStatus(row.bucketId, 'done');
    } catch (error) {
      await this.setStatus(row.bucketId, 'error').catch(() => undefined);
      throw error;
    } finally {
      this.approved.delete(row.deploymentId);
    }
  }

  private async make(
    row: Deployment,
    bucketId: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const [found] = await this.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    if (!found) throw new Error('The bucket is gone');
    const name = found.configName;
    if (!found.cloudAccountId || !found.region) {
      throw new Error(`${name} is not in a Cloud account`);
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      found.cloudAccountId,
    );
    if (!cloudAccountRow)
      throw new Error('The Cloud account this bucket is in is gone');
    const state = await this.states.findForBucket(bucketId);
    if (!state) throw new Error(`${name} has no Infrastructure state`);
    const approved =
      this.approved.get(row.deploymentId) ??
      (await approvedOnPlan(this.db, row.deploymentId, name));
    if (!approved) {
      throw new Error(
        'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
      );
    }
    const run: BucketRun = {
      found: { ...found, region: found.region },
      stateId: state.infrastructureStateId,
      approved,
      control,
      log,
    };
    // Each cloud's half (ADR-0043): S3, or Cloud Storage.
    await onCloud(cloudAccountRow, {
      aws: (account) => this.makeOnS3(run, account),
      gcp: (account) => this.makeOnCloudStorage(run, account),
    });
  }

  /** A bucket's Cloud run on S3. */
  private async makeOnS3(
    { found, stateId, approved, control, log }: BucketRun,
    account: AwsCloudAccount,
  ): Promise<void> {
    const name = found.configName;
    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);

    // The origins read now, so the run writes what the bucket's page holds;
    // a later edit is the next plan's CORS change.
    const origins = found.origins;
    // Its stored `native.aws`, refused whole, before anything
    // changes, when it now holds a value locked since it was applied.
    const refusedNative = storedNativeAwsRefusal(
      name,
      'bucket',
      found.nativeAws,
      { linkedKinds: [], existing: false, browserOrigins: origins.length > 0 },
    );
    if (refusedNative) throw new Error(refusedNative);
    const definition = bucketDefinition({
      configName: name,
      bucketName: found.bucketName,
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: found.region,
      environmentId: found.environmentId,
      stateId,
      origins,
      // What its last Apply laid, over Cloudgate's definition.
      native: found.nativeAws,
    });
    await log(
      `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} the S3 bucket ${found.bucketName} for ${name} in Cloud account ${account.name} in ${found.region}, Infrastructure state ${stateId}`,
    );

    await log('Reading AWS again before applying');
    const applied = await this.states.apply({
      stateId,
      credential,
      definition: withImports(definition, approved.reading.adopt),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: beforeApplyingApproved(approved, log, control),
    });
    // A value only AWS can judge names the native path it refused.
    if (!applied.ok) {
      throw new Error(blameNativeAws(applied.message, found.nativeAws));
    }
    await this.db
      .update(bucket)
      .set({ appliedOrigins: [...origins] })
      .where(eq(bucket.bucketId, found.bucketId));
    await log(madeLine(found.bucketName, approved.change, origins));
  }

  /**
   * A bucket's Cloud run on Cloud Storage: the bucket, its own
   * service account, that account's binding on it and its HMAC key, applied
   * with the run's own proof (S16) only if Google read again makes what the
   * Apply approved; what the plan adopted by name is imported, never made
   * twice. Then the key is saved on the bucket's row, encrypted (ADR-0006):
   * what every linking Service's next deploy is handed, and what the
   * bucket's page shows only as set (ADR-0019).
   */
  private async makeOnCloudStorage(
    { found, stateId, approved, control, log }: BucketRun,
    account: GcpCloudAccount,
  ): Promise<void> {
    const name = found.configName;
    const proof = await googleRunProof(this.cloudAccounts, account);
    // An existing bucket's CORS is the operator's: none is written.
    const origins = found.existing ? [] : found.origins;
    const definition = gcpBucketDefinition({
      serviceId: found.bucketId,
      bucketName: found.bucketName,
      cloudAccountId: account.cloudAccountId,
      projectId: account.cloudId,
      region: found.region,
      environmentId: found.environmentId,
      stateId,
      origins,
      // The keys its state holds: the live one, and a rotation's
      // spare beside it, so a run never destroys a key a rotation holds.
      keys: googleKeyLayout(found),
      existing: found.existing,
    });
    await log(
      found.existing
        ? `☁️ [Cloud run] ${approved.change ? 'Putting back' : 'Making'} ${name}'s own service account and HMAC key for the existing bucket ${found.bucketName} in Cloud account ${account.name}, Infrastructure state ${stateId}; the bucket itself is used as given`
        : `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} the Cloud Storage bucket ${found.bucketName} for ${name} in Cloud account ${account.name} in ${found.region}, Infrastructure state ${stateId}`,
    );
    const outputs = await applyApprovedOnGoogle(
      this.states,
      account,
      proof,
      { approved, control, log },
      {
        stateId,
        definition: withGoogleImports(definition, approved.reading.adopt),
      },
    );
    const output = (key: string) => outputText(outputs, key);
    const accessKeyId = output(GCP_BUCKET_OUTPUTS.accessKeyId);
    const secretAccessKey = output(GCP_BUCKET_OUTPUTS.secretAccessKey);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `${found.bucketName} is ${approved.change ? 'changed' : 'made'}, but Google did not answer its key. Check for changes, then apply the new plan`,
      );
    }
    await this.db
      .update(bucket)
      .set({ accessKeyId, secretAccessKey, appliedOrigins: [...origins] })
      .where(eq(bucket.bucketId, found.bucketId));
    if (!found.existing) {
      await log(madeLine(found.bucketName, approved.change, origins));
      return;
    }
    await this.checkExistingAccess(
      { ...found, accessKeyId, secretAccessKey },
      account,
      log,
    );
  }

  /**
   * An existing bucket's access, checked once its key is made: the
   * log names the grant the operator adds while the key has none. Linked
   * Services deploy regardless; the page keeps the status.
   */
  private async checkExistingAccess(
    found: Bucket,
    account: GcpCloudAccount,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const status = await checkGoogleBucketAccess(
      this.db,
      this.objectStorage,
      found,
    );
    const grant = bucketAccessGrant(
      found.bucketName,
      bucketKeyAccountEmail(found.bucketId, account.cloudId),
    );
    await log(
      status === 'ok'
        ? `${found.configName}'s key is made, and it lists ${found.bucketName}: its linked Services reach it`
        : `${found.configName}'s key is made. ${accessSentence(status ?? 'waiting', found, grant)}`,
    );
  }

  private async setStatus(
    bucketId: string,
    status: ApplicationStatus,
  ): Promise<void> {
    await this.db
      .update(bucket)
      .set({ applicationStatus: status })
      .where(eq(bucket.bucketId, bucketId));
  }
}

/** The product a bucket is made on, by its cloud (ADR-0043), as a run's title names it. */
const BUCKET_PRODUCT: PerCloud<string> = {
  aws: 'S3',
  gcp: 'Cloud Storage',
};

/** What one bucket run holds: its row, its state, the approved read, its control and log. */
interface BucketRun {
  readonly found: Bucket & { readonly region: string };
  readonly stateId: string;
  readonly approved: ApprovedRun;
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
}

/** The run's last line: the bucket made or changed, and who may upload from a browser. */
function madeLine(
  bucketName: string,
  change: boolean,
  origins: readonly string[],
): string {
  return (
    `${bucketName} is ${change ? 'changed' : 'made'}; ` +
    (origins.length === 0
      ? 'no origin may upload to it from a browser'
      : `${origins.length === 1 ? 'one origin' : `${origins.length} origins`} may upload to it from a browser`)
  );
}
