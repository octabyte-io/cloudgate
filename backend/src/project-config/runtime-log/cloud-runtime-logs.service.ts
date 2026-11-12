import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import {
  CONTAINER_NAME,
  LOG_STREAM_PREFIX,
  logGroupName,
} from '../../cloud-accounts/aws/definitions/web-definition';
import { cloudRunResourceOf } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsAnswer,
  AwsCloudPort,
  AwsCredential,
  LogStreamsPage,
} from '../../cloud-accounts/cloud.port';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { application, environment, project } from '../../db/schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { describeError } from '../../common/describe-error';
import { GoogleRuntimeLogs } from './google-runtime-logs.service';
import { RUNTIME_LOG_LINES, runtimeLogOf, startOf } from './runtime-log';
import type { RuntimeLog } from './runtime-log';

/** A deploy-role session is asked again after this long (STS gives 15 minutes). */
const SESSION_REFRESH_MS = 10 * 60_000;

/** CloudWatch's code for a log group nothing has made yet. */
const NO_LOG_GROUP = 'ResourceNotFoundException';

/** CloudWatch's code for a role whose policy does not allow the read. */
const ACCESS_DENIED = 'AccessDeniedException';

/**
 * **The Runtime log of a cloud Service** (the AWS spec, "Lifecycle and the
 * Runtime log"): what its ECS tasks write to the log group Cloudgate
 * made for it, read on its behalf with the Cloud account's deploy role, so
 * the cloud's login never reaches the browser.
 *
 * Each read is one `FilterLogEvents` over every stream under the Service's
 * prefix, from `since` on; the console polls every few seconds. There is no
 * Live Tail. Every task's lines are merged by time and each names its task.
 *
 * Gated by `service: read`, like the Service's own read. AWS's refusal is a
 * 400 naming the Cloud account and AWS's words, as the connect check's is;
 * a deploy role that cannot be taken on, or a read the role's policy denies,
 * is recorded on the Cloud account. AWS not answering at all is a 502.
 *
 * A Service in a Google Cloud account is read by {@link GoogleRuntimeLogs}
 * instead, from the project's own log store, under the project's read budget.
 */
@Injectable()
export class CloudRuntimeLogs {
  /** Deploy-role sessions by Cloud account and credential, reused across polls. */
  private readonly sessions = new Map<
    string,
    { session: AwsCredential; at: number }
  >();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly permissions: PermissionService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly google: GoogleRuntimeLogs,
  ) {}

  async read(
    ctx: PermissionCtx,
    applicationId: string,
    since: number | undefined,
  ): Promise<RuntimeLog> {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const [found] = await this.db
      .select({
        name: application.name,
        environmentId: application.environmentId,
        cloudAccountId: application.cloudAccountId,
        region: application.region,
        configKind: application.configKind,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Application not found');
    if (!found.cloudAccountId || !found.region) {
      throw new BadRequestException(
        `${found.name} runs on a Server; its Runtime log is its containers' output`,
      );
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      found.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw new BadRequestException(
        `The Cloud account ${found.name} runs in is gone, so its Runtime log cannot be read`,
      );
    }
    const service = {
      applicationId,
      name: found.name,
      environmentId: found.environmentId,
      region: found.region,
    };
    // Each cloud's own log (ADR-0043): CloudWatch's on ECS, and a Cloud Run
    // Service's the Google project's own.
    return onCloud(cloudAccountRow, {
      aws: (account) => this.readOnAws(account, service, since),
      // A Worker's is its worker pool's.
      gcp: (account) =>
        this.google.read(
          account,
          { ...service, resource: cloudRunResourceOf(found.configKind) },
          since,
        ),
    });
  }

  /** A Service on ECS's Runtime log: its CloudWatch log group's newest streams. */
  private async readOnAws(
    account: AwsCloudAccount,
    found: {
      readonly applicationId: string;
      readonly name: string;
      readonly environmentId: string;
      readonly region: string;
    },
    since: number | undefined,
  ): Promise<RuntimeLog> {
    const { applicationId } = found;
    const session = await this.session(account);
    const now = Date.now();
    const startTime = startOf(since, now);
    const answer: AwsAnswer<LogStreamsPage> = await this.cloud
      .filterLogStreams(session, {
        region: found.region,
        logGroupName: logGroupName(found.environmentId, applicationId),
        logStreamNamePrefix: `${LOG_STREAM_PREFIX}/${CONTAINER_NAME}/`,
        startTime,
        limit: RUNTIME_LOG_LINES,
      })
      .catch((error: unknown) => {
        throw new BadGatewayException(
          `AWS could not be reached for Cloud account ${account.name}: ${describeError(error)}`,
        );
      });
    if (answer.ok) return runtimeLogOf(answer.value, { startTime, now });
    // Before the first deploy's apply there is no log group, and nothing
    // has been written: an empty log, not a failure.
    if (answer.code === NO_LOG_GROUP) {
      return runtimeLogOf({ events: [], more: false }, { startTime, now });
    }
    const words = `${answer.code}: ${answer.message}`;
    if (answer.code === ACCESS_DENIED) {
      await this.cloudAccounts.recordUseFailure(account.cloudAccountId, words);
    }
    throw new BadRequestException(
      `Cloud account ${account.name} could not read the Runtime log of ${found.name}: AWS answered ${words}`,
    );
  }

  /** The deploy role's session, asked once and again when near its end. */
  private async session(account: AwsCloudAccount): Promise<AwsCredential> {
    const key = [
      account.cloudAccountId,
      account.accessKeyId,
      account.deployRoleArn,
      account.externalId,
    ].join('\0');
    const held = this.sessions.get(key);
    if (held && Date.now() - held.at < SESSION_REFRESH_MS) return held.session;
    this.sessions.delete(key);
    const answer = await this.cloudAccounts.deployRoleSession(account);
    if (!answer.ok) throw new BadRequestException(answer.refusal);
    for (const [other, entry] of this.sessions) {
      if (Date.now() - entry.at >= SESSION_REFRESH_MS) {
        this.sessions.delete(other);
      }
    }
    this.sessions.set(key, { session: answer.session, at: Date.now() });
    return answer.session;
  }
}
