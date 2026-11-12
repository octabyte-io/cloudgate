import { ConflictException, Inject, Injectable } from '@nestjs/common';

import { CLOUD_LIFECYCLE_REFUSED_CODE } from '../../applications/cloud-lifecycle';
import { rdsInstanceIdentifier } from '../../cloud-accounts/aws/definitions/postgres-definition';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsAnswer,
  AwsCloudPort,
  RdsInstanceState,
} from '../../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import { serviceName } from '../../cloud-accounts/gcp/definitions/names';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../../cloud-accounts/google-cloud.port';
import type {
  CloudSqlActivationPolicy,
  GoogleCloudPort,
} from '../../cloud-accounts/google-cloud.port';
import { restartDate } from '../postgres/rds-stop';

/** What a cloud database's Stop and Start read off a postgres's or a mysql's row. */
export interface CloudDatabaseTarget {
  readonly serviceId: string;
  readonly name: string;
  readonly cloudAccountId: string;
  readonly region: string;
}

/** What a Stop leaves for the row to record. */
export interface CloudDatabaseStopped {
  /** When the cloud starts it again by itself: RDS's date, `null` on Cloud SQL. */
  readonly restartsAt: string | null;
}

/** One verb's call on the database's own cloud. */
type Verb = 'stop' | 'start';

/**
 * **Stop and Start of a database in a Cloud account** (spec "AWS
 * database actions", spec "Stop and Start"): one direct call
 * each through its cloud's port (ADR-0043), signed in as its deploy
 * identity, never a Cloud run — the database side of a cloud Service's Stop and Start,
 * refused the same way (`CLOUD_LIFECYCLE_REFUSED`) when the cloud refused
 * it or the Cloud account could not sign in.
 *
 * - On **RDS**: `StopDBInstance` and `StartDBInstance`. AWS starts a stopped
 *   instance again by itself after seven days, so Stop answers that date.
 * - On **Cloud SQL**: an `instances.patch` of `settings.activationPolicy`,
 *   `NEVER` and `ALWAYS`, which the instance's definition ignores. Google
 *   never starts it by itself, so Stop answers no date.
 *
 * What the row records is the Database service's.
 */
@Injectable()
export class CloudDatabaseLifecycle {
  constructor(
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  async stop(
    target: CloudDatabaseTarget,
    stoppedAt = new Date(),
  ): Promise<CloudDatabaseStopped> {
    const restartsAt = await this.call(target, 'stop', stoppedAt);
    return { restartsAt };
  }

  async start(target: CloudDatabaseTarget): Promise<void> {
    await this.call(target, 'start', new Date());
  }

  /** The verb on the database's cloud; answers when the cloud starts it again. */
  private async call(
    target: CloudDatabaseTarget,
    verb: Verb,
    at: Date,
  ): Promise<string | null> {
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      target.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw refused(`The Cloud account ${target.name} runs in is gone`);
    }
    return onCloud<Promise<string | null>>(cloudAccountRow, {
      aws: async (account) => {
        await this.onRds(target, account, verb);
        return verb === 'stop' ? restartDate(at) : null;
      },
      gcp: async (account) => {
        await this.onCloudSql(target, account, verb);
        return null;
      },
    });
  }

  private async onRds(
    target: CloudDatabaseTarget,
    account: AwsCloudAccount,
    verb: Verb,
  ): Promise<void> {
    const session = await this.cloudAccounts.deployRoleSession(account);
    if (!session.ok) throw refused(session.refusal);
    const ref = {
      region: target.region,
      identifier: rdsInstanceIdentifier(target.serviceId),
    };
    const answer: AwsAnswer<RdsInstanceState> =
      verb === 'stop'
        ? await this.cloud.rdsStopInstance(session.session, ref)
        : await this.cloud.rdsStartInstance(session.session, ref);
    if (!answer.ok) {
      throw refused(
        `RDS refused to ${verb} ${target.name}: ${answer.code}: ${answer.message}`,
      );
    }
  }

  /**
   * The deploy service account's token, and the instance by its fixed name
   * (S4). An instance no Apply has made says so; an API turned off names
   * the setup step that turns it on, as Cloud Run's Stop does.
   */
  private async onCloudSql(
    target: CloudDatabaseTarget,
    account: GcpCloudAccount,
    verb: Verb,
  ): Promise<void> {
    const signed = await this.cloudAccounts.googleRunSession(account);
    if (!signed.ok) throw refused(signed.refusal);
    const policy: CloudSqlActivationPolicy =
      verb === 'stop' ? 'NEVER' : 'ALWAYS';
    const answer = await this.google.setCloudSqlActivationPolicy(
      signed.token,
      { projectId: account.cloudId, name: serviceName(target.serviceId) },
      policy,
    );
    if (answer.ok) return;
    if (answer.code === NOT_FOUND) {
      throw refused(
        `${target.name} has nothing in Cloud account ${account.name} yet: no Apply has made its Cloud SQL instance`,
      );
    }
    const words = googleRefusalReason(answer.message, account.cloudId);
    throw refused(
      words === answer.message
        ? `Google Cloud refused to ${verb} ${target.name}: ${answer.code}: ${answer.message}`
        : `Google Cloud refused to ${verb} ${target.name}: ${words}`,
    );
  }
}

function refused(message: string): ConflictException {
  return new ConflictException({
    message,
    code: CLOUD_LIFECYCLE_REFUSED_CODE,
  });
}
