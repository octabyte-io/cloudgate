import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  bucket,
  cloudAccount,
  environment,
  environmentNetwork,
  existingDatabase,
  mysql,
  postgres,
  project,
  redis,
} from '../db/schema';
import type { CloudAccount } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { nameCategory } from '../servers/servers.service';
import type { PolicyStanding } from './aws/policy-standing';
import type { SetupTemplate } from './aws/setup-template';
import { regionRefusal } from './cloud-regions';
import type { AwsCredential } from './cloud.port';
import type {
  CreateCloudAccountInput,
  SetupCloudAccountInput,
  UpdateCloudAccountInput,
} from './dto/cloud-account.dto';
import type { GoogleSetupTemplate } from './gcp/setup-script';
import type { AwsProvider } from './aws/aws-provider';
import { passed, recordUseFailure } from './cloud-account-rows';
import type { AwsColumns, GcpColumns } from './cloud-account-rows';
import { CloudProviders } from './cloud-providers';
import type { GoogleProvider } from './gcp/google-provider';
import { CLOUD_NAMES, credentialOf, onCloud } from './cloud-provider';
import type { AwsCloudAccount, GcpCloudAccount } from './cloud-provider';

/**
 * A Cloud account as the API exposes it, by its cloud, carrying only its own
 * cloud's columns — so an AWS one reads exactly as it did before Google
 * Cloud accounts could exist. Each private half is replaced by whether one is
 * on file (ADR-0019), which is always true for a saved one — the field
 * exists so the console can say so and an edit can keep it — and the
 * view says whether its role is held to the policy this Cloudgate needs.
 */
export type CloudAccountView =
  | (Omit<AwsCloudAccount, 'secretAccessKey' | GcpColumns> &
      PolicyStanding & { hasSecretAccessKey: boolean })
  | (Omit<GcpCloudAccount, 'signingKey' | 'pendingSigningKey' | AwsColumns> &
      PolicyStanding & {
        hasSigningKey: boolean;
        hasPendingSigningKey: boolean;
      });

/** What `DELETE /cloud-accounts/:id` answers. */
export interface CloudAccountRemoved {
  cloudAccountId: string;
  name: string;
  /** What Cloudgate did not remove in the cloud, and whose it is to remove. */
  message: string;
}

/** What `POST /cloud-accounts/:id/key` answers: the new key's public half, and the setup trusting both keys. */
export interface GoogleNewKey {
  signingKeyId: string;
  signingPublicKey: string;
  template: GoogleSetupTemplate;
}

/** What `POST /cloud-accounts/:id/key/check` answers once the new key passed and signs. */
export interface GoogleKeyChanged {
  cloudAccount: CloudAccountView;
  /** The JWKS holding the new key only, to upload in place of the one with both. */
  jwks: string;
  /** The reminder to upload it. */
  message: string;
}

/** What `POST /cloud-accounts/setup` answers. */
export interface CloudAccountSetup {
  /** Hand back on connect; it carries the ids the template was made with. */
  setupToken: string;
  /** The id the Cloud account will have, and so its tag value (ADR-0036: ids only). */
  cloudAccountId: string;
  externalId: string;
  template: SetupTemplate;
}

/** What `POST /cloud-accounts/setup` answers for a Google Cloud project (the Google Cloud spec). */
export interface GoogleCloudAccountSetup {
  cloud: 'gcp';
  /** Hand back on connect; it carries the id and the key pair the script was made with. */
  setupToken: string;
  cloudAccountId: string;
  /** The key's id and public half, which the script uploads. The private half never leaves. */
  signingKeyId: string;
  signingPublicKey: string;
  template: GoogleSetupTemplate;
}

/**
 * **Cloud accounts** (the AWS spec, the Google Cloud spec): what is the same on every
 * cloud — the row, its Organization, the guards on its Delete, its last
 * check — with what differs asked of its cloud's {@link CloudProvider} by
 * the row's own `cloud` (ADR-0043): `AwsProvider` or `GoogleProvider`.
 */
@Injectable()
export class CloudAccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly providers: CloudProviders,
  ) {}

  /**
   * What connecting a Cloud account needs before its cloud has anything:
   * a sealed setup token and its cloud's setup template or script (the Google
   * Cloud spec). Calls nothing in the cloud and keeps nothing.
   */
  async setup(
    ctx: PermissionCtx,
    data: SetupCloudAccountInput,
  ): Promise<CloudAccountSetup | GoogleCloudAccountSetup> {
    return this.providers
      .of(data.cloud)
      .setup(ctx.session.activeOrganizationId, data);
  }

  /**
   * Connects an AWS account or a Google Cloud project as a Cloud account in
   * the caller's Organization, saving it only if every step of its cloud's
   * connect check passes; a refusal is a 400 naming what to
   * fix, and writes nothing.
   *
   * The duplicate is looked for before the check, so connecting an account
   * twice costs no cloud calls; the unique index still decides a race.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateCloudAccountInput,
  ): Promise<CloudAccountView> {
    const created = await this.providers
      .of(data.cloud)
      .connect(ctx.session.activeOrganizationId, data);
    return this.view(created);
  }

  /** A row as the API shows it. */
  private view(row: CloudAccount): CloudAccountView {
    return this.providers.of(row.cloud).view(row);
  }

  /** The Organization's Cloud accounts with their last check, newest first; never calls AWS. */
  async list(ctx: PermissionCtx): Promise<CloudAccountView[]> {
    const rows = await this.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(cloudAccount.createdAt));
    return rows.map((row) => this.view(row));
  }

  /** One Cloud account, org-scoped, with its last check; never calls AWS. */
  async findOne(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<CloudAccountView> {
    return this.view(await this.findOneWithCredentials(ctx, cloudAccountId));
  }

  /**
   * Edits a Cloud account, so that an edit can never
   * break one that works (the AWS spec). A field left out keeps
   * its stored value; a changed credential reruns its cloud's connect check
   * and saves only once it passes, and a failed re-check writes nothing —
   * not even the last check ({@link CloudProvider.edit}).
   */
  async update(
    ctx: PermissionCtx,
    cloudAccountId: string,
    data: UpdateCloudAccountInput,
  ): Promise<CloudAccountView> {
    const found = await this.findOneWithCredentials(ctx, cloudAccountId);
    if (data.cloud !== found.cloud) {
      throw new BadRequestException(
        `Cloud account ${found.name} is on ${CLOUD_NAMES[found.cloud]}, not ${CLOUD_NAMES[data.cloud]}`,
      );
    }
    const set = await this.providers.of(found.cloud).edit(found, data);
    const [updated] = await this.db
      .update(cloudAccount)
      .set(set)
      .where(eq(cloudAccount.cloudAccountId, found.cloudAccountId))
      .returning();
    return this.view(updated);
  }

  /**
   * "Check now": reruns the connect check on the saved values and
   * records when it ran, how it ended and why. A failure is the answer, not
   * an error, so it is a `200` carrying the failed last check. A pass also
   * records the policy version it held the role to, which is what clears
   * "permissions out of date" once the operator has updated the role.
   *
   * There is no background checking; this and
   * {@link recordUseFailure} are the only writers of the last check after
   * connect.
   */
  async checkNow(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<CloudAccountView> {
    const stored = await this.findOneWithCredentials(ctx, cloudAccountId);
    const result = await this.providers.of(stored.cloud).check(stored);
    const [updated] = await this.db
      .update(cloudAccount)
      .set(
        result.ok
          ? passed(result.policyVersion)
          : {
              lastCheckedAt: new Date().toISOString(),
              lastCheckResult: 'failed',
              lastCheckReason: result.message,
            },
      )
      .where(eq(cloudAccount.cloudAccountId, stored.cloudAccountId))
      .returning();
    return this.view(updated);
  }

  /**
   * Records a failure a use of the Cloud account found — a plan, an apply, a
   * log read refused by its cloud — as its last check, so the Cloud account
   * shows when and why until a check passes (the AWS spec, "When the credential
   * stops working"). For the Cloud run and plan code, which
   * already hold the row; `reason` names the cloud's error in its own words.
   * Unscoped by Organization for that reason, and never reached from a route.
   */
  recordUseFailure(cloudAccountId: string, reason: string): Promise<void> {
    return recordUseFailure(this.db, cloudAccountId, reason);
  }

  /** AWS's deploy role session ({@link AwsProvider.deployRoleSession}), for the callers that hold an AWS Cloud account. */
  deployRoleSession(
    account: AwsCloudAccount,
    credential: AwsCredential = credentialOf(account),
  ): ReturnType<AwsProvider['deployRoleSession']> {
    return this.providers.aws.deployRoleSession(account, credential);
  }

  /** A Google Cloud account's run session ({@link GoogleProvider.runSession}), for the callers that hold one. */
  googleRunSession(
    account: GcpCloudAccount,
  ): ReturnType<GoogleProvider['runSession']> {
    return this.providers.gcp.runSession(account);
  }

  /**
   * Whether the Cloud account signs in now as its cloud's deploy identity —
   * the deploy role on AWS, the deploy service account on Google Cloud —
   * `null`, or the refusal, recorded on the Cloud account like any
   * failed use. What a Delete asks before it starts, so one that cannot
   * reach its cloud fails and removes nothing.
   */
  async signInRefusal(row: CloudAccount): Promise<string | null> {
    const signed = await this.providers.of(row.cloud).signIn(row);
    return signed.ok ? null : signed.refusal;
  }

  /**
   * The full row with the decrypted secret, unscoped, or `null` when it is
   * gone: for a Cloud run or a plan read, whose Organization was
   * checked when the plan or the Deployment was asked for. Never reached
   * from a route.
   */
  async findForUse(cloudAccountId: string): Promise<CloudAccount | null> {
    const [found] = await this.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    return found ?? null;
  }

  /**
   * The setup template at the current policy version for a connected Cloud
   * account, with its own external id and tag value, so an operator whose
   * permissions are out of date updates the role they already made.
   * For a Google one it is the setup script at the current role version,
   * with the issuer it was set up with and every key the provider should
   * trust. Calls nothing in the cloud and keeps nothing.
   */
  async template(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<SetupTemplate | GoogleSetupTemplate> {
    const stored = await this.findOneWithCredentials(ctx, cloudAccountId);
    return this.providers.of(stored.cloud).template(stored);
  }

  /** "New key", a Google Cloud account's only: {@link GoogleProvider.newKey}. */
  async newKey(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<GoogleNewKey> {
    return this.providers.gcp.newKey(
      googleOrRefuse(await this.findOneWithCredentials(ctx, cloudAccountId)),
    );
  }

  /** The new key's check and switch: {@link GoogleProvider.checkNewKey}. */
  async checkNewKey(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<GoogleKeyChanged> {
    return this.providers.gcp.checkNewKey(
      googleOrRefuse(await this.findOneWithCredentials(ctx, cloudAccountId)),
    );
  }

  /**
   * Deletes a Cloud account's row and nothing else. Cloudgate never
   * made what its setup made — the operator did, from the template or the
   * script — so it does not remove them, and the answer says so, naming
   * each (its cloud's {@link CloudProvider.leftovers}). There is no force: what still uses the Cloud account refuses the
   * Delete ({@link blockingUses}).
   */
  async remove(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<CloudAccountRemoved> {
    const found = await this.findOneWithCredentials(ctx, cloudAccountId);
    const blocking = await this.blockingUses(found);
    if (blocking.length > 0) {
      throw new ConflictException(
        `Cloud account ${found.name} is still used by ${blocking.join(', ')}`,
      );
    }
    await this.db
      .delete(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, found.cloudAccountId));
    return {
      cloudAccountId: found.cloudAccountId,
      name: found.name,
      message: this.providers.of(found.cloud).leftovers(found),
    };
  }

  /**
   * What still uses a Cloud account and so refuses its Delete, each named for
   * the operator. Each guard answers the uses it knows of.
   * The tickets that introduce a use add its guard to this list —
   * Environments targeting it, Environment networks and
   * Services in it — the way `servers.service.ts`'s
   * `targetingEnvironments` guards a Server.
   */
  private readonly deleteGuards: ReadonlyArray<
    (found: CloudAccount) => Promise<string[]>
  > = [
    // An Environment whose Deploy target it is: choose another
    // target in its settings first.
    async (found) => {
      const targeting = await this.targetingEnvironments(found.cloudAccountId);
      const named = nameCategory(targeting, 'Environment', 'Environments');
      return named === null
        ? []
        : [
            `${named} as ${targeting.length === 1 ? 'its' : 'their'} Deploy target`,
          ];
    },
    // An Environment network made in it, whatever its status: its
    // load balancer bills until the Environment's Delete removes it.
    async (found) => {
      const networks = await this.environmentNetworksIn(found.cloudAccountId);
      const named = nameCategory(
        networks,
        'Environment network',
        'Environment networks',
      );
      return named === null ? [] : [named];
    },
    // A Service running in it: its Delete destroys what it runs on
    // AWS, which needs the Cloud account's credential.
    async (found) => {
      const services = await this.servicesIn(found.cloudAccountId);
      const named = nameCategory(services, 'Service', 'Services');
      return named === null ? [] : [named];
    },
  ];

  /**
   * Every Service running in this Cloud account, as
   * `Project / Environment / Service in <region>`: a `web`, a
   * postgres on RDS, a redis on ElastiCache or a bucket on
   * S3.
   */
  private async servicesIn(cloudAccountId: string): Promise<string[]> {
    const databases = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: postgres.name,
        region: postgres.region,
      })
      .from(postgres)
      .innerJoin(
        environment,
        eq(environment.environmentId, postgres.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(postgres.cloudAccountId, cloudAccountId));
    // A mysql on RDS, as a postgres there.
    const mysqls = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: mysql.name,
        region: mysql.region,
      })
      .from(mysql)
      .innerJoin(
        environment,
        eq(environment.environmentId, mysql.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(mysql.cloudAccountId, cloudAccountId));
    // And an Existing database a mysql uses.
    const existingMysqls = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: mysql.name,
        region: existingDatabase.region,
      })
      .from(existingDatabase)
      .innerJoin(mysql, eq(mysql.mysqlId, existingDatabase.mysqlId))
      .innerJoin(
        environment,
        eq(environment.environmentId, mysql.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(existingDatabase.cloudAccountId, cloudAccountId));
    const caches = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: redis.name,
        region: redis.region,
      })
      .from(redis)
      .innerJoin(
        environment,
        eq(environment.environmentId, redis.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(redis.cloudAccountId, cloudAccountId));
    const applications = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: application.name,
        region: application.region,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(application.cloudAccountId, cloudAccountId));
    const buckets = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: bucket.name,
        region: bucket.region,
      })
      .from(bucket)
      .innerJoin(
        environment,
        eq(environment.environmentId, bucket.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(bucket.cloudAccountId, cloudAccountId));
    // An Existing database looked up in it: its lookup needs the
    // Cloud account's credential, though its Delete never reaches AWS.
    const existing = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: postgres.name,
        region: existingDatabase.region,
      })
      .from(existingDatabase)
      .innerJoin(postgres, eq(postgres.postgresId, existingDatabase.postgresId))
      .innerJoin(
        environment,
        eq(environment.environmentId, postgres.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(existingDatabase.cloudAccountId, cloudAccountId));
    // And an existing replication group a redis uses.
    const existingCaches = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        service: redis.name,
        region: existingDatabase.region,
      })
      .from(existingDatabase)
      .innerJoin(redis, eq(redis.redisId, existingDatabase.redisId))
      .innerJoin(
        environment,
        eq(environment.environmentId, redis.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(existingDatabase.cloudAccountId, cloudAccountId));
    return [
      ...applications,
      ...databases,
      ...mysqls,
      ...caches,
      ...buckets,
      ...existing,
      ...existingMysqls,
      ...existingCaches,
    ]
      .map(
        (row) =>
          `${row.project} / ${row.environment} / ${row.service} in ${row.region}`,
      )
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Every Environment network made in this Cloud account, as
   * `Project / Environment in <region>` — what its Delete is refused over.
   */
  private async environmentNetworksIn(
    cloudAccountId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .select({
        project: project.name,
        environment: environment.name,
        region: environmentNetwork.region,
      })
      .from(environmentNetwork)
      .innerJoin(
        environment,
        eq(environment.environmentId, environmentNetwork.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(environmentNetwork.cloudAccountId, cloudAccountId))
      .orderBy(
        asc(project.name),
        asc(environment.name),
        asc(environmentNetwork.region),
      );
    return rows.map(
      (row) => `${row.project} / ${row.environment} in ${row.region}`,
    );
  }

  private async blockingUses(found: CloudAccount): Promise<string[]> {
    const uses = await Promise.all(
      this.deleteGuards.map((guard) => guard(found)),
    );
    return uses.flat();
  }

  /**
   * The full row with the decrypted secret, org-scoped (404 outside the
   * caller's Organization, ADR-0008), for code that calls AWS with it. Never
   * returned from a controller.
   */
  async findOneWithCredentials(
    ctx: PermissionCtx,
    cloudAccountId: string,
  ): Promise<CloudAccount> {
    const [found] = await this.db
      .select()
      .from(cloudAccount)
      .where(
        and(
          eq(cloudAccount.cloudAccountId, cloudAccountId),
          eq(cloudAccount.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Cloud account not found');
    return found;
  }

  /**
   * A cloud Deploy target an Environment asks for, checked: the Cloud
   * account is the caller's Organization's and the caller may read it, the
   * region is one its cloud has (the Google Cloud spec S17), and its cloud's region check
   * passes there — AWS's, or Google's (the Google Cloud spec, "Region check"). Answers the target to store — built from
   * the checked row, not the body — and any warning to show beside it.
   *
   * **"Not found" for a caller without `cloudAccount: read`** (ADR-0008): the
   * Environment statement lets them choose where Services go, not learn which
   * Cloud accounts exist, so a missing statement and another Organization's
   * id answer alike.
   *
   * A refusal is a 400 naming the region and each denied action, and the
   * caller stores nothing. A region its cloud does not have is refused
   * before the cloud is called. A call the cloud never answered is a 502, as
   * for the connect check.
   */
  async checkDeployTarget(
    ctx: PermissionCtx,
    given: { cloudAccountId: string; region: string },
  ): Promise<{
    target: { kind: 'cloud'; cloudAccountId: string; region: string };
    warnings: string[];
  }> {
    try {
      await this.permissions.checkPermission(ctx, { cloudAccount: ['read'] });
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw new NotFoundException('Cloud account not found');
      }
      throw error;
    }
    const account = await this.findOneWithCredentials(
      ctx,
      given.cloudAccountId,
    );
    const notARegion = regionRefusal(account.cloud, given.region);
    if (notARegion) throw new BadRequestException(notARegion);
    const target = {
      kind: 'cloud' as const,
      cloudAccountId: account.cloudAccountId,
      region: given.region,
    };
    // Its cloud's region check: AWS's, or Google's (the Google Cloud spec).
    const warnings = await this.providers
      .of(account.cloud)
      .checkRegion(account, given.region);
    return { target, warnings };
  }

  /**
   * Every Environment whose Deploy target is this Cloud account, as
   * `Project / Environment` — what a Cloud account's Delete is refused over
   * (spec "A Cloud account cannot be deleted while…").
   */
  async targetingEnvironments(cloudAccountId: string): Promise<string[]> {
    const rows = await this.db
      .select({ project: project.name, environment: environment.name })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          sql`${environment.deployTarget} ->> 'kind' = 'cloud'`,
          sql`${environment.deployTarget} ->> 'cloudAccountId' = ${cloudAccountId}`,
        ),
      )
      .orderBy(asc(project.name), asc(environment.name));
    return rows.map((row) => `${row.project} / ${row.environment}`);
  }
}

/**
 * The row as a Google one, or a 400 saying an AWS one's key is its access
 * key: for the key change, which only a Google Cloud account has.
 */
function googleOrRefuse(found: CloudAccount): GcpCloudAccount {
  return onCloud(found, {
    aws: () => {
      throw new BadRequestException(
        `Cloud account ${found.name} is on AWS, where its key is the access key; change it by editing the Cloud account`,
      );
    },
    gcp: (account) => account,
  });
}
