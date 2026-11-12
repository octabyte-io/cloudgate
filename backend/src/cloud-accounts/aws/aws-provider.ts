import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';

import { encryptValue } from '../../common/encryption/encryption';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { CloudAccount } from '../../db/schema';
import {
  connectChecked,
  editChecked,
  GCP_COLUMNS,
  openSetupToken,
  reachingCloud,
  recordUseFailure,
  without,
} from '../cloud-account-rows';
import type {
  CloudAccountSetup,
  CloudAccountView,
} from '../cloud-accounts.service';
import { awsAccountOf, credentialOf } from '../cloud-provider';
import type { AwsCloudAccount } from '../cloud-provider';
import type { CloudProvider, ConnectCheckOutcome } from '../cloud-providers';
import { AWS_CLOUD_PORT } from '../cloud.port';
import type { AwsCloudPort, AwsCredential } from '../cloud.port';
import { accountOfRoleArn } from '../dto/cloud-account.dto';
import type {
  CreateCloudAccountInput,
  SetupCloudAccountInput,
  UpdateCloudAccountInput,
} from '../dto/cloud-account.dto';
import { AWS_POLICY } from './aws-policy';
import type { AwsPolicy } from './aws-policy';
import { runConnectCheck, runRegionCheck } from './connect-check';
import type { ConnectCheckResult } from './connect-check';
import { policyStanding } from './policy-standing';
import type { SetupTemplate } from './setup-template';

/** The session name Cloudgate takes the deploy role under. */
const DEPLOY_ROLE_SESSION_NAME = 'cloudgate';

const DUPLICATE =
  'This AWS account is already connected to this Organization as a Cloud account';

/** The fields an edit reruns the connect check for. */
const CREDENTIAL_FIELDS = [
  'accessKeyId',
  'secretAccessKey',
  'deployRoleArn',
  'taskExecutionRoleArn',
] as const;

/** An AWS setup token's contents. */
interface SetupIds {
  organizationId: string;
  cloudAccountId: string;
  externalId: string;
}

/**
 * **A Cloud account at AWS** (the AWS spec; ADR-0043): an IAM user's
 * access key that takes on a deploy role the operator made from Cloudgate's
 * setup template, under an external id Cloudgate made. Every call goes
 * through the AWS port, which the e2e specs fake.
 */
@Injectable()
export class AwsProvider implements CloudProvider {
  readonly cloud = 'aws' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly port: AwsCloudPort,
    @Inject(AWS_POLICY) private readonly policy: AwsPolicy,
  ) {}

  /**
   * The setup template for an AWS account not yet connected, with the
   * external id and Cloud account id it will be connected under.
   *
   * **Why a token, not a row.** The template has to carry the external id
   * before the role exists, and nothing is saved until the connect check
   * passes, so the ids travel with the operator instead: sealed
   * with the instance's encryption key (ADR-0006's `enc:v1:`) and bound to the
   * Organization. Sealed rather than sent plain because the external id must
   * be **made by Cloudgate**, never chosen by the caller — AWS's confused-deputy
   * advice is exactly that a caller who picks it can pick another
   * Organization's. Calls nothing in AWS and keeps nothing.
   */
  setup(
    organizationId: string,
    data: SetupCloudAccountInput,
  ): Promise<CloudAccountSetup> {
    if (data.cloud !== 'aws') throw notAws(data.cloud);
    const ids = data.setupToken
      ? this.readSetupToken(organizationId, data.setupToken)
      : {
          organizationId,
          cloudAccountId: nanoid(),
          externalId: randomBytes(24).toString('base64url'),
        };
    return Promise.resolve({
      setupToken: encryptValue(JSON.stringify(ids)),
      cloudAccountId: ids.cloudAccountId,
      externalId: ids.externalId,
      template: this.policy.setupTemplate({
        accountId: data.cloudId,
        externalId: ids.externalId,
        tagValue: ids.cloudAccountId,
      }),
    });
  }

  /** Connects an AWS account with the ids its setup token carries, once the connect check passes. */
  async connect(
    organizationId: string,
    data: CreateCloudAccountInput,
  ): Promise<CloudAccount> {
    if (data.cloud !== 'aws') throw notAws(data.cloud);
    const ids = this.readSetupToken(organizationId, data.setupToken);
    return connectChecked(
      this.db,
      {
        organizationId,
        cloud: data.cloud,
        cloudId: data.cloudId,
        duplicate: DUPLICATE,
      },
      () =>
        this.runCheck({
          accountId: data.cloudId,
          accessKeyId: data.accessKeyId,
          secretAccessKey: data.secretAccessKey,
          deployRoleArn: data.deployRoleArn,
          taskExecutionRoleArn: data.taskExecutionRoleArn,
          externalId: ids.externalId,
          tagValue: ids.cloudAccountId,
        }),
      () => ({
        cloudAccountId: ids.cloudAccountId,
        organizationId,
        name: data.name,
        cloud: data.cloud,
        cloudId: data.cloudId,
        accessKeyId: data.accessKeyId,
        secretAccessKey: data.secretAccessKey,
        deployRoleArn: data.deployRoleArn,
        taskExecutionRoleArn: data.taskExecutionRoleArn,
        externalId: ids.externalId,
      }),
    );
  }

  /**
   * An edit by {@link editChecked}'s rules: a change to the key or a
   * role ARN reruns the connect check with the merged values — the new
   * secret when one is given, the stored one otherwise; a rename alone calls
   * no AWS. A role ARN in another AWS account is refused first.
   */
  async edit(
    row: CloudAccount,
    data: UpdateCloudAccountInput,
  ): Promise<Partial<CloudAccount>> {
    if (data.cloud !== 'aws') throw notAws(data.cloud);
    const stored = this.account(row);
    for (const field of ['deployRoleArn', 'taskExecutionRoleArn'] as const) {
      const account = data[field] ? accountOfRoleArn(data[field]) : null;
      if (account !== null && account !== stored.cloudId) {
        throw new BadRequestException(
          `${field} is in AWS account ${account}, not ${stored.cloudId}`,
        );
      }
    }

    const merged = {
      name: data.name ?? stored.name,
      accessKeyId: data.accessKeyId ?? stored.accessKeyId,
      secretAccessKey: data.secretAccessKey ?? stored.secretAccessKey,
      deployRoleArn: data.deployRoleArn ?? stored.deployRoleArn,
      taskExecutionRoleArn:
        data.taskExecutionRoleArn ?? stored.taskExecutionRoleArn,
    };
    return editChecked(stored, merged, CREDENTIAL_FIELDS, () =>
      this.runCheck(checkInput({ ...stored, ...merged })),
    );
  }

  check(row: CloudAccount): Promise<ConnectCheckOutcome> {
    return this.runCheck(checkInput(this.account(row)));
  }

  /** The template at the current policy version, with the account's own external id and tag value. */
  template(row: CloudAccount): SetupTemplate {
    const found = this.account(row);
    return this.policy.setupTemplate({
      accountId: found.cloudId,
      externalId: found.externalId,
      tagValue: found.cloudAccountId,
    });
  }

  /**
   * AWS's region check: a refusal is a 400 naming the region and
   * each denied action; a call AWS never answered is a 502.
   */
  async checkRegion(row: CloudAccount, region: string): Promise<string[]> {
    const found = this.account(row);
    const result = await reachingCloud('AWS', () =>
      runRegionCheck(
        this.port,
        {
          accountId: found.cloudId,
          accessKeyId: found.accessKeyId,
          secretAccessKey: found.secretAccessKey,
          deployRoleArn: found.deployRoleArn,
          taskExecutionRoleArn: found.taskExecutionRoleArn,
          externalId: found.externalId,
          tagValue: found.cloudAccountId,
          region,
        },
        this.policy,
      ),
    );
    if (!result.ok) {
      // The message names the region and every denied action.
      throw new BadRequestException(result.message);
    }
    return result.warnings;
  }

  signIn(
    row: CloudAccount,
  ): Promise<{ ok: true } | { ok: false; refusal: string }> {
    return this.deployRoleSession(this.account(row));
  }

  /**
   * The deploy role's session the Cloud account's key takes on, for the
   * calls Cloudgate makes outside `tofu` (ECR, ECS, logs; Stop, Start and
   * Reload), or a refusal naming the Cloud account and AWS's own
   * words, recorded on the Cloud account like any failed use.
   */
  async deployRoleSession(
    account: AwsCloudAccount,
    credential: AwsCredential = credentialOf(account),
  ): Promise<
    { ok: true; session: AwsCredential } | { ok: false; refusal: string }
  > {
    let answer: Awaited<ReturnType<AwsCloudPort['assumeRole']>>;
    try {
      answer = await this.port.assumeRole(credential, {
        roleArn: account.deployRoleArn,
        externalId: account.externalId,
        sessionName: DEPLOY_ROLE_SESSION_NAME,
      });
    } catch (error) {
      return {
        ok: false,
        refusal: `AWS could not be reached for Cloud account ${account.name}: ${error instanceof Error ? error.message : String(error)}. Check for changes to read it again`,
      };
    }
    if (answer.ok) return { ok: true, session: answer.value };
    const words = `${answer.code}: ${answer.message}`;
    await recordUseFailure(this.db, account.cloudAccountId, words);
    return {
      ok: false,
      refusal: `Cloud account ${account.name} could not take on its deploy role: AWS answered ${words}. Fix its credential or role in Organization settings, then Check for changes`,
    };
  }

  view(row: CloudAccount): CloudAccountView {
    const account = this.account(row);
    return {
      ...without(account, [...GCP_COLUMNS, 'secretAccessKey']),
      ...policyStanding(
        row.policyVersion,
        this.policy.version,
        this.policy.requiredActions,
      ),
      hasSecretAccessKey: account.secretAccessKey.length > 0,
    };
  }

  /**
   * Cloudgate never made the IAM user, its key or the roles — the operator
   * did, from the template — so a Delete removes none of them.
   */
  leftovers(row: CloudAccount): string {
    const account = this.account(row);
    return `Cloud account ${row.name} is removed from Cloudgate. Nothing was removed in AWS account ${row.cloudId}: the IAM user with access key ${account.accessKeyId}, that key, the deploy role ${account.deployRoleArn} and the task execution role ${account.taskExecutionRoleArn} are yours to remove.`;
  }

  /** The row as an AWS one, or a 400 naming Google Cloud (S12). */
  private account(row: CloudAccount): AwsCloudAccount {
    const aws = awsAccountOf(row);
    if (!aws.ok) throw new BadRequestException(aws.refusal);
    return aws.account;
  }

  /**
   * The connect check through the port. AWS's refusals come back as a result;
   * a call that got no answer at all is a 502, since nothing about the Cloud
   * account can be concluded from it.
   */
  private runCheck(
    input: Parameters<typeof runConnectCheck>[1],
  ): Promise<ConnectCheckResult> {
    return reachingCloud('AWS', () =>
      runConnectCheck(this.port, input, this.policy),
    );
  }

  /** The ids a setup token carries, if it is one this instance made for this Organization. */
  private readSetupToken(organizationId: string, token: string): SetupIds {
    return openSetupToken(
      organizationId,
      token,
      'The setup token is not one Cloudgate made for this Organization; get the setup template again',
      (ids) =>
        typeof ids.cloudAccountId === 'string' &&
        typeof ids.externalId === 'string'
          ? {
              organizationId,
              cloudAccountId: ids.cloudAccountId,
              externalId: ids.externalId,
            }
          : null,
    );
  }
}

/** The connect check's input for a row's values. */
function checkInput(
  row: Pick<
    AwsCloudAccount,
    | 'cloudAccountId'
    | 'cloudId'
    | 'externalId'
    | (typeof CREDENTIAL_FIELDS)[number]
  >,
): Parameters<typeof runConnectCheck>[1] {
  return {
    accountId: row.cloudId,
    accessKeyId: row.accessKeyId,
    secretAccessKey: row.secretAccessKey,
    deployRoleArn: row.deployRoleArn,
    taskExecutionRoleArn: row.taskExecutionRoleArn,
    externalId: row.externalId,
    tagValue: row.cloudAccountId,
  };
}

/** An input of another cloud handed to AWS's provider: the caller chose by its `cloud`, so this is a bug. */
function notAws(cloud: string): Error {
  return new Error(`A ${cloud} Cloud account's input reached AWS's provider`);
}
