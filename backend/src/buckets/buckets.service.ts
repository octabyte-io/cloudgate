import { refuseDeployUntilReady } from '../bought-servers/server-readiness';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type Docker from 'dockerode';
import { and, eq, sql } from 'drizzle-orm';
import type { ApplicationStatus } from '../applications/application.schema';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';
import type { LabelsSwarm } from '../applications/swarm.types';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import {
  byCloud,
  CLOUD_NAMES,
  cloudOrLegacy,
} from '../cloud-accounts/cloud-provider';
import { EXISTING_BUCKET_NAME_REGEX } from '../cloud-accounts/aws/definitions/existing-bucket-lookup';
import {
  bucketReadGrant,
  isGoogleBucketName,
} from '../cloud-accounts/gcp/plan-reader/existing-bucket';
import { checkServerAccess } from '../common/owned-server';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { systemSettleClock } from '../compose/compose.utils';
import type { SettleClock } from '../compose/compose.utils';
import {
  awaitDatabaseDeploy,
  DATABASE_CONVERGENCE_CLOCK,
} from '../databases/common/database-convergence';
import { convergeDatabaseService } from '../databases/common/database-spec';
import { generateAppName } from '../db/columns';
import { OBJECT_STORAGE } from '../object-storage/object-storage.port';
import type { ObjectStoragePort } from '../object-storage/object-storage.port';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  bucket,
  cloudAccount,
  environment,
  project,
  server,
} from '../db/schema';
import { RemoteDockerFactory } from '../docker/remote-docker.factory';
import { claimServiceConfigName } from '../environments/config-name';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { parseBucketOrigins } from './bucket-origins';
import {
  recheckGoogleBucketAccess,
  googleAccessView,
} from './google-bucket-access';
import type { GoogleAccessView } from './google-bucket-access';
import type { BucketCloudDeleteRecord, KeyRotation } from './bucket.schema';
import {
  bucketCorsProgram,
  bucketVolumeName,
  createBucketProgram,
  createKeyProgram,
  GARAGE_IMAGE,
  GARAGE_REGION,
  garageConfigSecretName,
  garageServiceSpec,
  garageSpecSource,
  garageToml,
  newAdminCredential,
  readCreatedKey,
} from './garage';
import { describeError } from '../common/describe-error';

/**
 * Where a bucket is (ADR-0035): its run Server, the platform host, or an S3
 * bucket in a Cloud account and region.
 */
export type BucketPlace =
  | {
      readonly kind: 'server';
      readonly serverId: string;
      readonly serverName: string;
    }
  | { readonly kind: 'platform-host' }
  | {
      readonly kind: 'cloud';
      readonly cloudAccountId: string;
      readonly cloudAccountName: string;
      /**
       * Its Cloud account's own id: on AWS the account id, which the
       * bucket's real name ends with; on Google Cloud the project id, where
       * Cloudgate makes the bucket, or an existing bucket's key.
       */
      readonly cloudId: string;
      /**
       * Its Cloud account's cloud: on Google Cloud the bucket has a
       * key of its own, which Rotate key replaces.
       */
      readonly cloud: CloudKind;
      readonly region: string;
      /**
       * An existing bucket on Google Cloud in a project other than its
       * Cloud account's: that project's number, as Cloud Storage
       * answers it; `null` for every other bucket, and before a plan has
       * looked it up.
       */
      readonly bucketProjectNumber: string | null;
    };

/**
 * A bucket as the API answers it (ADR-0019): its real name, its place and
 * region, and whether its key is set — never the key, nor Cloudgate's admin
 * credential.
 */
export interface BucketRead {
  readonly bucketId: string;
  readonly name: string;
  readonly appName: string;
  readonly configName: string;
  readonly description: string | null;
  readonly bucketName: string;
  readonly region: string;
  readonly place: BucketPlace;
  /**
   * An existing bucket (ADR-0033): one made outside Cloudgate, in
   * `place`'s Cloud account and region, which every plan looks up and
   * Cloudgate never changes. Its `applicationStatus` is `done` once a
   * plan's lookup has found it.
   */
  readonly existing: boolean;
  /**
   * An existing bucket on Google Cloud's access (ADR-0033 as
   * amended): "waiting for access" until a list of one file made with its
   * key answers, ok once it has, "no access" when it fails after that, with
   * the exact `add-iam-policy-binding` line that grants it. `null` until the
   * Apply made its key, and for every other bucket.
   */
  readonly googleAccess: GoogleAccessView | null;
  readonly serverId: string | null;
  /**
   * The Docker volume its files are on, which a volume backup names;
   * `null` for a bucket on S3, which has none.
   */
  readonly volumeName: string | null;
  /**
   * That its key exists; Garage makes it on the first deploy. A bucket on
   * S3 has none: a linking Service's task role reaches it (ADR-0032).
   */
  readonly hasKey: boolean;
  /**
   * The web origins trusted to upload to it from a browser, in this
   * Environment; empty is none.
   */
  readonly origins: readonly string[];
  /**
   * Its last Rotate key, running or ended, or `null` before the
   * first: which Services it redeploys, how each ended, and the sentence
   * naming any that failed. Never a key.
   */
  readonly keyRotation: KeyRotation | null;
  /**
   * A bucket on AWS's Delete under way or incomplete (ADR-0038): its
   * run's Deployment, whether it asked for the files to go, what is left in
   * AWS and why the run did not finish; `null` when there is none. Never
   * who asked.
   */
  readonly cloudDelete: {
    readonly status: 'deleting' | 'incomplete';
    readonly deploymentId: string;
    readonly deleteFiles: boolean;
    readonly left: BucketCloudDeleteRecord['left'];
    readonly unfinished: string | null;
  } | null;
  readonly applicationStatus: ApplicationStatus;
  readonly createdAt: string;
  readonly environmentId: string;
  readonly environment: {
    readonly environmentId: string;
    readonly name: string;
    readonly project: { readonly projectId: string; readonly name: string };
  };
}

const NOT_FOUND = 'Bucket not found';

/** The refusal code of an existing bucket in an Environment not on a cloud. */
export const EXISTING_BUCKET_NEEDS_CLOUD = 'EXISTING_BUCKET_NEEDS_CLOUD';

/** The refusal code of a change Cloudgate never makes to an existing bucket. */
export const EXISTING_BUCKET_NOT_MANAGED = 'EXISTING_BUCKET_NOT_MANAGED';

/**
 * Buckets (ADR-0037): each one its own Garage Swarm service on its run
 * Server, with its files on its own volume. A bucket is made only by a plan
 * — there is no console create — and is deployed as a `postgres` entry is:
 * no Deployment row, its own status following the deploy in the background.
 */
@Injectable()
export class BucketsService {
  private readonly logger = new Logger(BucketsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly dockerFactory: RemoteDockerFactory,
    private readonly remoteExec: RemoteExecService,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    private readonly instanceMode: InstanceMode,
    @Optional()
    @Inject(DATABASE_CONVERGENCE_CLOCK)
    private readonly convergenceClock: SettleClock = systemSettleClock,
  ) {}

  /**
   * A plan's create: the row on the Environment's Deploy target,
   * under the Config name and real name the plan showed, with a new admin
   * credential. `service: create` on the Project, as every create asks; an
   * unknown or unowned Server is a 404 after it. `appName` is the
   * plan's when it already named the Swarm service in a generated Domain's
   * host, else a new one.
   */
  async create(
    ctx: PermissionCtx,
    data: {
      readonly environmentId: string;
      readonly name: string;
      readonly serverId: string | null;
      readonly description?: string;
      readonly appName?: string;
      /** Its Garage's labels on a Server, its `native.docker`'s. */
      readonly labelsSwarm?: LabelsSwarm | null;
      /**
       * An S3 bucket's place: its Cloud account and region, under the
       * Service id its plan was read with. Never beside a Server.
       */
      readonly cloud?: {
        /** Absent on an existing bucket, which no plan read made. */
        readonly bucketId?: string;
        readonly cloudAccountId: string;
        readonly region: string;
        /** An existing bucket: one Cloudgate only looks up. */
        readonly existing?: boolean;
      };
    },
    initial: { readonly configName: string; readonly bucketName: string },
  ): Promise<{ bucketId: string; appName: string }> {
    const parent = await this.findParentEnvironment(ctx, data.environmentId);
    await this.permissions.checkServiceAccess(ctx, parent.projectId, 'create');
    // No Server and no Cloud account is a Garage on the platform host:
    // refused on the Hosted instance (ADR-0053 seam 3). An Apply onto
    // a platform-host Environment is refused before it gets here.
    if (!data.serverId && !data.cloud) {
      this.instanceMode.refusePlatformHost('services');
    }
    await checkServerAccess(this.db, ctx, data.serverId);

    const appName = data.appName ?? generateAppName('bucket');
    const created = await this.db.transaction(async (tx) => {
      const configName = await claimServiceConfigName(
        tx,
        data.environmentId,
        initial.configName,
      );
      const [row] = await tx
        .insert(bucket)
        .values({
          ...(data.cloud
            ? {
                ...(data.cloud.bucketId
                  ? { bucketId: data.cloud.bucketId }
                  : {}),
                cloudAccountId: data.cloud.cloudAccountId,
                region: data.cloud.region,
                existing: data.cloud.existing === true,
              }
            : {}),
          name: data.name,
          configName,
          appName,
          description: data.description ?? null,
          labelsSwarm: data.labelsSwarm ?? null,
          bucketName: initial.bucketName,
          adminCredential: newAdminCredential(),
          volumeName: bucketVolumeName(appName),
          environmentId: data.environmentId,
          serverId: data.serverId,
        })
        .returning({ bucketId: bucket.bucketId, appName: bucket.appName });
      return row;
    });
    await this.permissions.addNewService(ctx, created.bucketId);
    return created;
  }

  /**
   * "Use an existing bucket" (ADR-0033): a bucket Service under the
   * Config name of the Environment's entry, whose place is the S3 bucket the
   * operator names, in the Environment's Cloud account and region, fixed
   * from now on (ADR-0035). Gated as any create (`service: ['create']`), no
   * new statement. It is not a console Save: the Project config does not
   * change, and the entry stays described, so the next plan matches it,
   * creates nothing and looks the bucket up. Nothing reaches AWS here.
   */
  async createExisting(
    ctx: PermissionCtx,
    data: {
      readonly environmentId: string;
      readonly configName: string;
      readonly bucketName: string;
    },
  ): Promise<BucketRead> {
    const parent = await this.findParentEnvironment(ctx, data.environmentId);
    const [env] = await this.db
      .select({ deployTarget: environment.deployTarget })
      .from(environment)
      .where(eq(environment.environmentId, parent.environmentId));
    const target = env.deployTarget;
    if (target.kind !== 'cloud') {
      throw new ConflictException({
        message:
          "An existing bucket is looked up in its Environment's Cloud account, and this Environment's Deploy target is not a Cloud account; choose one as its Deploy target first",
        code: EXISTING_BUCKET_NEEDS_CLOUD,
      });
    }
    await this.checkExistingName(target.cloudAccountId, data.bucketName);
    const created = await this.create(
      ctx,
      {
        environmentId: data.environmentId,
        name: data.configName,
        serverId: null,
        cloud: {
          cloudAccountId: target.cloudAccountId,
          region: target.region,
          existing: true,
        },
      },
      { configName: data.configName, bucketName: data.bucketName },
    );
    return this.findOne(ctx, created.bucketId);
  }

  /**
   * Refuses a name the Environment's Cloud account's cloud does not name a
   * bucket by (ADR-0043): an S3 bucket name on AWS, a Cloud Storage one on
   * Google Cloud.
   */
  private async checkExistingName(
    cloudAccountId: string,
    bucketName: string,
  ): Promise<void> {
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    const refusal = byCloud<string | null>(cloudOrLegacy(found?.cloud), {
      aws: EXISTING_BUCKET_NAME_REGEX.test(bucketName)
        ? null
        : 'bucketName must be an S3 bucket name: 3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit',
      gcp: isGoogleBucketName(bucketName)
        ? null
        : 'bucketName must be a Cloud Storage bucket name: lowercase letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit, 3 to 63 characters (222 when dotted)',
    });
    if (refusal) throw new BadRequestException(refusal);
  }

  /**
   * What the "Use an existing bucket" form shows before a name is given
   * on Google Cloud, the deploy service account a bucket in
   * another project must let read it, and the exact grant, `<bucket>`
   * standing for the bucket's name. `null` on AWS, whose lookup needs no
   * grant. `service: create`, as the create the form makes.
   */
  async existingReach(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<{
    readonly google: {
      readonly projectId: string;
      readonly serviceAccount: string;
      readonly readGrant: string;
    } | null;
  }> {
    const parent = await this.findParentEnvironment(ctx, environmentId);
    await this.permissions.checkServiceAccess(ctx, parent.projectId, 'create');
    const [env] = await this.db
      .select({ deployTarget: environment.deployTarget })
      .from(environment)
      .where(eq(environment.environmentId, parent.environmentId));
    const target = env.deployTarget;
    if (target.kind !== 'cloud') return { google: null };
    const [account] = await this.db
      .select({
        cloud: cloudAccount.cloud,
        cloudId: cloudAccount.cloudId,
        serviceAccount: cloudAccount.deployServiceAccount,
      })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, target.cloudAccountId));
    if (!account) return { google: null };
    const serviceAccount = account.serviceAccount ?? '';
    return {
      google: byCloud(cloudOrLegacy(account.cloud), {
        aws: null,
        gcp: {
          projectId: account.cloudId,
          serviceAccount,
          readGrant: bucketReadGrant('<bucket>', serviceAccount),
        },
      }),
    };
  }

  /**
   * The bucket's page: {@link findOne}, after an existing bucket on
   * Google Cloud's access is checked again, so a grant added or
   * taken off since shows at once. The check never fails the read.
   */
  async read(ctx: PermissionCtx, bucketId: string): Promise<BucketRead> {
    const found = await this.findOne(ctx, bucketId);
    if (
      !found.existing ||
      !found.googleAccess ||
      found.place.kind !== 'cloud'
    ) {
      return found;
    }
    const [row] = await this.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    if (!row) return found;
    try {
      const checked = await recheckGoogleBucketAccess(
        this.db,
        this.objectStorage,
        row,
      );
      return {
        ...found,
        googleAccess: googleAccessView(
          { ...row, ...checked },
          found.place.cloudId,
        ),
      };
    } catch (error) {
      this.logger.warn(
        `${row.appName}: the access of ${row.bucketName} was not checked — ${describeError(error)}`,
      );
      return found;
    }
  }

  /** Row-level `read`, org-scoped through environment → project. */
  async findOne(ctx: PermissionCtx, bucketId: string): Promise<BucketRead> {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'read');
    // Named columns, never a relation loaded whole: the key, the admin
    // credential and the Server's own secrets stay in the database.
    const [found] = await this.db
      .select({
        bucketId: bucket.bucketId,
        name: bucket.name,
        appName: bucket.appName,
        configName: bucket.configName,
        description: bucket.description,
        bucketName: bucket.bucketName,
        serverId: bucket.serverId,
        serverName: server.name,
        cloudAccountId: bucket.cloudAccountId,
        cloudAccountName: cloudAccount.name,
        cloudId: cloudAccount.cloudId,
        projectNumber: cloudAccount.projectNumber,
        googleProjectNumber: bucket.googleProjectNumber,
        cloud: cloudAccount.cloud,
        region: bucket.region,
        volumeName: bucket.volumeName,
        hasKey: sql<boolean>`${bucket.accessKeyId} is not null`,
        origins: bucket.origins,
        keyRotation: bucket.keyRotation,
        cloudDelete: bucket.cloudDelete,
        existing: bucket.existing,
        googleAccess: bucket.googleAccess,
        googleAccessCheckedAt: bucket.googleAccessCheckedAt,
        applicationStatus: bucket.applicationStatus,
        createdAt: bucket.createdAt,
        environmentId: environment.environmentId,
        environmentName: environment.name,
        projectId: project.projectId,
        projectName: project.name,
      })
      .from(bucket)
      .innerJoin(
        environment,
        eq(bucket.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .leftJoin(server, eq(bucket.serverId, server.serverId))
      .leftJoin(
        cloudAccount,
        eq(bucket.cloudAccountId, cloudAccount.cloudAccountId),
      )
      .where(
        and(
          eq(bucket.bucketId, bucketId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException(NOT_FOUND);
    return {
      bucketId: found.bucketId,
      name: found.name,
      appName: found.appName,
      configName: found.configName,
      description: found.description,
      bucketName: found.bucketName,
      region: found.region ?? GARAGE_REGION,
      place: placeOf(found),
      existing: found.existing,
      // Its key's service account is in the Cloud account's own project.
      googleAccess:
        found.existing && found.cloudId
          ? googleAccessView(found, found.cloudId)
          : null,
      serverId: found.serverId,
      volumeName: found.cloudAccountId === null ? found.volumeName : null,
      hasKey: found.hasKey,
      origins: found.origins,
      keyRotation: found.keyRotation,
      cloudDelete: found.cloudDelete
        ? {
            status: found.cloudDelete.status,
            deploymentId: found.cloudDelete.deploymentId,
            deleteFiles: found.cloudDelete.deleteFiles,
            left: found.cloudDelete.left,
            unfinished: found.cloudDelete.unfinished,
          }
        : null,
      applicationStatus: found.applicationStatus,
      createdAt: found.createdAt,
      environmentId: found.environmentId,
      environment: {
        environmentId: found.environmentId,
        name: found.environmentName,
        project: { projectId: found.projectId, name: found.projectName },
      },
    };
  }

  /**
   * A plan's change: a bucket's description, the one field its entry
   * has, and on a Server its Garage's labels, its `native.docker`'s one key
   * which its next deploy lays on. `service: update` on the bucket.
   */
  async update(
    ctx: PermissionCtx,
    bucketId: string,
    data: {
      readonly description: string | null;
      readonly labelsSwarm?: LabelsSwarm | null;
    },
  ): Promise<void> {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'update');
    await this.findOwned(ctx, bucketId);
    await this.db
      .update(bucket)
      .set({
        description: data.description,
        ...(data.labelsSwarm !== undefined && {
          labelsSwarm: data.labelsSwarm,
        }),
      })
      .where(eq(bucket.bucketId, bucketId));
  }

  /**
   * Sets the web origins trusted to upload to the bucket straight from a
   * browser: the whole list, each one a browser origin or a 400
   * naming it. `service: update` on the bucket, as any Service setting; the
   * row is the Environment's, so another Environment's bucket keeps its own.
   *
   * A deployed bucket's Garage CORS is set first, through Cloudgate's admin
   * access to its container (`bucketCorsProgram`), and the list saved only
   * once Garage took it, so what is saved is what a browser meets. A Garage
   * that cannot be reached refuses the edit (409) and saves nothing. A bucket
   * not yet deployed saves the list alone: its deploy applies it. So does a
   * bucket on S3, whose CORS is written by the Cloud run of the next
   * plan's Apply, that plan showing it as a CORS change.
   */
  async updateOrigins(
    ctx: PermissionCtx,
    bucketId: string,
    raw: readonly string[],
  ): Promise<BucketRead> {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'update');
    const owned = await this.findOwned(ctx, bucketId);
    // An existing bucket's CORS is the operator's: never written.
    if (owned.existing) {
      throw new ConflictException({
        message: `${owned.bucketName} is an existing bucket, which Cloudgate uses but never changes, so its browser-upload origins are its own CORS, set in ${CLOUD_NAMES[cloudOrLegacy(owned.cloud)]}`,
        code: EXISTING_BUCKET_NOT_MANAGED,
      });
    }
    const origins = parseBucketOrigins(raw);
    // On S3 the list is saved alone: it is the bucket's CORS resource
    // in its own state, which the next plan shows as a change and its Apply
    // writes.
    if (owned.cloudAccountId === null && owned.applicationStatus === 'done') {
      try {
        await execOnServer(
          this.remoteExec,
          owned.serverId,
          bucketCorsProgram(owned.appName, owned.bucketName, origins),
        );
      } catch (error) {
        this.logger.warn(
          `${owned.appName}: the CORS of ${owned.bucketName} was not set — ${describeError(error)}`,
        );
        throw new ConflictException(
          `Cloudgate could not set the origins on bucket ${owned.bucketName}, so they were not saved — try again once its Garage is running`,
        );
      }
    }
    await this.db
      .update(bucket)
      .set({ origins })
      .where(eq(bucket.bucketId, bucketId));
    return this.findOne(ctx, bucketId);
  }

  /**
   * Deploys a bucket once its plan is written, in the background of its own
   * status (`running`, then `done` or `error`): Garage's Swarm service on
   * its run Server, then, once Swarm runs it, the bucket and — on the first
   * deploy — its one key, through the `garage` CLI in its task, and its
   * CORS set to its saved origins. Cloudgate's
   * caller is never waiting, so a failure is the bucket's status and a log
   * line, never a throw.
   */
  async deploy(bucketId: string): Promise<void> {
    const [found] = await this.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    if (!found) throw new NotFoundException(NOT_FOUND);
    // A bucket on S3 is made by its Cloud run, never by Garage.
    if (found.cloudAccountId !== null) {
      throw new ConflictException(
        `${found.bucketName} is an S3 bucket, made by its Cloud run`,
      );
    }
    // Nothing is deployed to a Bought Server until it is Ready (spec #1387).
    await refuseDeployUntilReady(this.db, [found.serverId]);
    // Nor to a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [found.serverId]);
    await this.setStatus(bucketId, 'running');
    try {
      const docker = await this.dockerFactory.getRemoteDocker(found.serverId);
      const secret = await this.configSecret(docker, found);
      await execOnServer(this.remoteExec, found.serverId, [
        'docker',
        'pull',
        GARAGE_IMAGE,
      ]);
      const converged = await convergeDatabaseService(
        docker,
        found.appName,
        garageServiceSpec(found, secret),
      );
      const verdict = await awaitDatabaseDeploy(
        docker,
        found.appName,
        garageSpecSource(found),
        converged,
        { engineLabel: 'Bucket', clock: this.convergenceClock },
      );
      if (verdict.failed) throw new Error(verdict.reason);

      await execOnServer(
        this.remoteExec,
        found.serverId,
        createBucketProgram(found.appName, found.bucketName),
      );
      if (found.accessKeyId === null) {
        const { stdout } = await execOnServer(
          this.remoteExec,
          found.serverId,
          createKeyProgram(found.appName, found.bucketName, found.appName),
        );
        const key = readCreatedKey(stdout);
        if (!key) throw new Error('Garage did not hand back the new key');
        await this.db
          .update(bucket)
          .set(key)
          .where(eq(bucket.bucketId, bucketId));
      }
      // Its origins, read now so an edit saved while it was not
      // deployed — or during this deploy — is the one Garage holds. Set on
      // every deploy, an empty list too, so a list cleared while Garage was
      // down is cleared there as well; a new bucket's CORS allows no origin.
      const [{ origins }] = await this.db
        .select({ origins: bucket.origins })
        .from(bucket)
        .where(eq(bucket.bucketId, bucketId));
      await execOnServer(
        this.remoteExec,
        found.serverId,
        bucketCorsProgram(found.appName, found.bucketName, origins),
      );
      await this.setStatus(bucketId, 'done');
    } catch (error) {
      this.logger.warn(
        `${found.appName}: the bucket ${found.bucketName} was not deployed — ${describeError(error)}`,
      );
      await this.setStatus(bucketId, 'error');
    }
  }

  /**
   * The Swarm secret the bucket's `garage.toml` is handed over in: the one
   * already there, or a new one. Its content never changes — the admin
   * credential is made once with the bucket — so an existing one is reused
   * as it is, and a Swarm secret is never updated in place anyway.
   */
  private async configSecret(
    docker: Docker,
    found: {
      appName: string;
      adminCredential: (typeof bucket.$inferSelect)['adminCredential'];
    },
  ): Promise<{ secretId: string; secretName: string }> {
    const secretName = garageConfigSecretName(found.appName);
    try {
      const existing = (await docker.getSecret(secretName).inspect()) as {
        ID: string;
      };
      return { secretId: existing.ID, secretName };
    } catch {
      const created = (await docker.createSecret({
        Name: secretName,
        Data: Buffer.from(garageToml(found.adminCredential)).toString('base64'),
      })) as { id?: string; ID?: string };
      const secretId = created.id ?? created.ID;
      if (!secretId) throw new Error(`Docker made no secret ${secretName}`);
      return { secretId, secretName };
    }
  }

  private async setStatus(bucketId: string, status: ApplicationStatus) {
    await this.db
      .update(bucket)
      .set({ applicationStatus: status })
      .where(eq(bucket.bucketId, bucketId));
  }

  /** Org-scoped, the write path's counterpart of {@link findOne}. */
  private async findOwned(ctx: PermissionCtx, bucketId: string) {
    const [found] = await this.db
      .select({
        appName: bucket.appName,
        serverId: bucket.serverId,
        volumeName: bucket.volumeName,
        bucketName: bucket.bucketName,
        applicationStatus: bucket.applicationStatus,
        cloudAccountId: bucket.cloudAccountId,
        existing: bucket.existing,
        cloud: cloudAccount.cloud,
      })
      .from(bucket)
      .innerJoin(
        environment,
        eq(bucket.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .leftJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, bucket.cloudAccountId),
      )
      .where(
        and(
          eq(bucket.bucketId, bucketId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException(NOT_FOUND);
    return found;
  }

  /** The Environment (with its projectId) inside the caller's organization. */
  private async findParentEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
  ) {
    const [found] = await this.db
      .select({
        environmentId: environment.environmentId,
        projectId: environment.projectId,
      })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Environment not found');
    return found;
  }
}

/** A bucket's place as the API answers it, from its row's joined names. */
function placeOf(found: {
  serverId: string | null;
  serverName: string | null;
  cloudAccountId: string | null;
  cloudAccountName: string | null;
  cloudId: string | null;
  projectNumber: string | null;
  googleProjectNumber: string | null;
  cloud: CloudKind | null;
  region: string | null;
}): BucketPlace {
  if (
    found.cloudAccountId !== null &&
    found.region !== null &&
    found.cloudAccountName !== null &&
    found.cloudId !== null
  ) {
    return {
      kind: 'cloud',
      cloudAccountId: found.cloudAccountId,
      cloudAccountName: found.cloudAccountName,
      cloudId: found.cloudId,
      cloud: cloudOrLegacy(found.cloud),
      region: found.region,
      bucketProjectNumber:
        found.googleProjectNumber !== null &&
        found.googleProjectNumber !== found.projectNumber
          ? found.googleProjectNumber
          : null,
    };
  }
  if (found.serverId !== null && found.serverName !== null) {
    return {
      kind: 'server',
      serverId: found.serverId,
      serverName: found.serverName,
    };
  }
  return { kind: 'platform-host' };
}
