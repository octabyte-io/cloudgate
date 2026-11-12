import type { Logger } from '@nestjs/common';

import { destroyDefinition } from '../cloud-accounts/aws/definitions/destroy-definition';
import { TAG_KEYS } from '../cloud-accounts/aws/definitions/tags';
import { findLeftovers } from '../cloud-accounts/aws/delete-check';
import type {
  KeptResource,
  Leftover,
} from '../cloud-accounts/aws/delete-check';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { credentialOf } from '../cloud-accounts/cloud-provider';
import { CHANGED_NOTHING } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  TofuFailure,
} from '../cloud-accounts/cloud.port';
import type { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../common/describe-error';
import type { CloudRunControl } from '../deployment-queue/cloud-run-job.types';
import type {
  BucketContents,
  EmptyOutcome,
  ObjectStoragePort,
  ObjectStorageTarget,
} from '../object-storage/object-storage.port';
import { NothingRemoved } from '../common/nothing-removed';
import type { CloudBucketKept } from './bucket-files';
import type { Bucket } from './bucket.schema';

// The steps of a bucket on AWS's Delete (ADR-0038) that are not the
// run's bookkeeping: what a kept or left bucket is named as, its files read
// and emptied through the object-storage port, and the destroy of its state
// with the check of what is left afterwards. `CloudBucketDeletes` holds the
// run and the bucket's row; these take what they reach as arguments
// (§1.5's extracted-helper pattern).

/** What a kept S3 bucket costs, as the report names it. */
const KEPT_COST =
  'S3 storage for the files it holds, billed until you empty or delete it in AWS';

/** A bucket's place in AWS; a Server bucket never reaches here. */
export function placeOf(found: Bucket): {
  cloudAccountId: string;
  region: string;
} {
  if (found.cloudAccountId === null || found.region === null) {
    throw new Error(`${found.name} is not in a Cloud account`);
  }
  return { cloudAccountId: found.cloudAccountId, region: found.region };
}

/** The S3 bucket, reached at AWS's own endpoint with the deploy role's session. */
export function s3Target(
  found: Bucket,
  region: string,
  session: AwsCredential,
): ObjectStorageTarget {
  return {
    endpoint: null,
    region,
    bucket: found.bucketName,
    credential: session,
    pathStyle: false,
  };
}

export function bucketArn(found: Bucket): string {
  return `arn:aws:s3:::${found.bucketName}`;
}

export function keptOf(
  found: Bucket,
  account: AwsCloudAccount,
  region: string,
  files: 'holds-files' | 'unknown' | 'empty',
): CloudBucketKept {
  return {
    bucketName: found.bucketName,
    because: files === 'unknown' ? 'unknown' : 'holds-files',
    cloud: {
      cloudAccountId: account.cloudAccountId,
      cloudAccountName: account.name,
      awsAccountId: account.cloudId,
      region,
    },
  };
}

export function keptResource(
  found: Bucket,
  account: AwsCloudAccount,
  region: string,
): KeptResource {
  return {
    type: 's3',
    awsId: bucketArn(found),
    region,
    awsAccountId: account.cloudId,
    cost: KEPT_COST,
  };
}

export function partlyEmptied(
  found: Bucket,
  region: string,
  state: { infrastructureStateId: string } | null,
): Leftover {
  return {
    type: 's3',
    awsId: bucketArn(found),
    region,
    tag: state ? `${TAG_KEYS.state}=${state.infrastructureStateId}` : null,
    because: 'partly-emptied',
  };
}

export const ENDED_BEFORE_DESTROYING: TofuFailure = {
  ok: false,
  reason: 'interrupted',
  message: 'The run was ended before it destroyed anything.',
};

export function accessOf(account: AwsCloudAccount) {
  return {
    awsAccountId: account.cloudId,
    deployRoleArn: account.deployRoleArn,
    externalId: account.externalId,
  };
}

/**
 * Destroys everything in the bucket's Infrastructure state, then checks AWS
 * by the state's tag for anything left, with a fresh session: a destroy may
 * outlast one. Throws {@link NothingRemoved} for a run that changed nothing;
 * otherwise answers what did not finish and what is left.
 */
export async function destroyAndCheck(
  deps: {
    readonly states: InfrastructureStatesService;
    readonly cloudAccounts: CloudAccountsService;
    readonly cloud: AwsCloudPort;
  },
  input: {
    readonly found: Bucket;
    readonly account: AwsCloudAccount;
    readonly region: string;
    readonly state: { readonly infrastructureStateId: string } | null;
    readonly control: CloudRunControl;
    readonly log: (line: string) => Promise<void>;
  },
): Promise<{ unfinished: string | null; left: Leftover[] }> {
  const { found, account, region, state, control, log } = input;
  let unfinished: string | null = null;
  if (state) {
    await log(
      `Destroying everything in Infrastructure state ${state.infrastructureStateId}`,
    );
    let began = false;
    const outcome = await deps.states.destroy({
      stateId: state.infrastructureStateId,
      credential: credentialOf(account),
      definition: destroyDefinition(accessOf(account), region, {
        cloudAccountId: account.cloudAccountId,
        environmentId: found.environmentId,
        stateId: state.infrastructureStateId,
      }),
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
      unfinished = began
        ? outcome.message
        : `${outcome.message} The run ended before it destroyed anything`;
    }
  } else {
    await log(
      `${found.name} has no Infrastructure state: nothing was made for it in AWS`,
    );
  }

  // The check afterwards, with a fresh session: a destroy may outlast one.
  let left: Leftover[] = [];
  if (control.signal.killed) {
    unfinished ??= 'The run was killed before it could check what is left';
  } else if (state) {
    await log('🔎 [Cloud run] Checking AWS for anything left');
    const session = await deps.cloudAccounts.deployRoleSession(account);
    const check = !session.ok
      ? { ok: false as const, message: session.refusal }
      : await findLeftovers(deps.cloud, session.session, {
          region,
          stateId: state.infrastructureStateId,
          iamRoleNames: [],
          securityGroupIds: [],
        });
    if (check.ok) left = check.left;
    else unfinished ??= `What is left could not be checked: ${check.message}`;
  }
  return { unfinished, left };
}

/** Whether it holds files, through the port against S3; never throws. */
export async function bucketContents(
  objectStorage: ObjectStoragePort,
  logger: Logger,
  found: Bucket,
  region: string,
  session: AwsCredential,
): Promise<BucketContents> {
  try {
    return await objectStorage.contentsOf(s3Target(found, region, session));
  } catch (error) {
    logger.warn(
      `${found.appName}: Cloudgate could not tell whether ${found.bucketName} holds files — ${describeError(error)}`,
    );
    return 'unknown';
  }
}

/** Empties it through the port against S3; a throw is an outcome. */
export async function emptyBucket(
  objectStorage: ObjectStoragePort,
  found: Bucket,
  region: string,
  session: AwsCredential,
): Promise<EmptyOutcome> {
  try {
    return await objectStorage.empty(s3Target(found, region, session));
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}
