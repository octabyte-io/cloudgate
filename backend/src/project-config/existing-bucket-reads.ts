import { and, eq } from 'drizzle-orm';

import { bucket } from '../buckets/bucket.schema';
import { existingBucketLookup } from '../cloud-accounts/aws/definitions/existing-bucket-lookup';
import {
  foundBucket,
  judgeBucketLookup,
} from '../cloud-accounts/aws/plan-reader/existing-bucket';
import { readPlan } from '../cloud-accounts/aws/plan-reader/read-plan';
import { credentialOf, onCloud } from '../cloud-accounts/cloud-provider';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import type { TofuRunSignal } from '../cloud-accounts/cloud.port';
import { describeError } from '../common/describe-error';
import type { ExistingReadDeps } from './existing-database-reads';
import type { CloudRead, PlanStep } from './planner/plan.types';

type Change = Extract<PlanStep, { action: 'change' }>;

/** What each cloud's half reads of an existing bucket's row: its place and name. */
export interface GoogleExistingBucket {
  readonly bucketId: string;
  readonly environmentId: string;
  readonly region: string;
  readonly bucketName: string;
}

/**
 * The lookup of an **existing bucket** on a plan's step (ADR-0033; the AWS buckets
 * spec "Use existing"): a `tofu plan` of `data` sources only, in the
 * Cloud account and region it was created in, against its own workspace
 * (the Service's id), which holds nothing, so nothing is locked or written.
 * What it finds is judged (`judgeBucketLookup`): a refusal is the step's
 * failed read, which refuses the Apply naming it; one found as given marks
 * the bucket `done`, which its Outputs wait for. On Google Cloud it
 * is `GooglePlanReads.readExistingBucket`.
 */
export async function readExistingBucket(
  deps: ExistingReadDeps,
  step: Change,
  signal: TofuRunSignal | undefined,
): Promise<CloudRead> {
  const [row] = await deps.db
    .select({
      bucketId: bucket.bucketId,
      cloudAccountId: bucket.cloudAccountId,
      region: bucket.region,
      bucketName: bucket.bucketName,
      environmentId: bucket.environmentId,
    })
    .from(bucket)
    .where(and(eq(bucket.bucketId, step.serviceId), eq(bucket.existing, true)));
  const name = step.configName;
  if (!row?.cloudAccountId || !row.region) {
    return failed(`${name} is no longer an existing bucket`);
  }
  const cloudAccountRow = await deps.findAccount(row.cloudAccountId);
  if (!cloudAccountRow) {
    return failed(
      `The Cloud account ${name}'s existing bucket ${row.bucketName} is looked up in is gone`,
    );
  }
  const placed: GoogleExistingBucket = {
    bucketId: row.bucketId,
    environmentId: row.environmentId,
    region: row.region,
    bucketName: row.bucketName,
  };
  // Each cloud's half (ADR-0043): on Google Cloud a lookup through the
  // Google client port, and a plan of the key account and key Cloudgate
  // makes for it in its own state.
  return onCloud(cloudAccountRow, {
    aws: (account) => readOnAws(deps, step, placed, account, signal),
    gcp: (account) =>
      deps.readGoogleBucket
        ? deps.readGoogleBucket(account, placed)
        : Promise.resolve(
            failed(
              `Cloud account ${account.name} is a Google Cloud project, and nothing here looks an existing bucket up there`,
            ),
          ),
  });
}

/** An existing bucket's lookup in AWS: `data` sources only. */
async function readOnAws(
  deps: ExistingReadDeps,
  step: Change,
  row: GoogleExistingBucket,
  account: AwsCloudAccount,
  signal: TofuRunSignal | undefined,
): Promise<CloudRead> {
  const name = step.configName;
  const refused = await deps.credentialRefusal(account);
  if (refused) return failed(refused);
  const stateId = row.bucketId;
  const outcome = await deps.states.planFresh({
    stateId,
    credential: credentialOf(account),
    definition: existingBucketLookup({
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: row.region,
      environmentId: row.environmentId,
      stateId,
      bucketName: row.bucketName,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!outcome.ok) {
    return failed(
      `${name}: AWS could not be asked for the existing bucket ${row.bucketName}: ${outcome.message}`,
    );
  }
  let verdict: ReturnType<typeof judgeBucketLookup>;
  try {
    verdict = judgeBucketLookup(foundBucket(outcome.show, row.bucketName), {
      serviceName: name,
      bucketName: row.bucketName,
      cloudAccount: `${account.name} (${account.cloudId})`,
      region: row.region,
    });
  } catch (error) {
    return failed(
      `${name}: the lookup of ${row.bucketName} could not be read: ${describeError(error)}`,
    );
  }
  if (!verdict.ok) return failed(verdict.reason);
  await deps.db
    .update(bucket)
    .set({ applicationStatus: 'done' })
    .where(eq(bucket.bucketId, row.bucketId));
  const reading = readPlan({
    show: outcome.show,
    tagSearch: [],
    context: { serviceName: name },
  });
  return {
    status: 'read',
    ...reading,
    summary: verdict.lines,
    stateId,
    serviceId: step.serviceId,
    readAt: new Date().toISOString(),
  };
}

function failed(reason: string): CloudRead {
  return { status: 'failed', reason };
}
