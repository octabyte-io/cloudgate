import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { systemSettleClock } from '../compose/compose.utils';
import type { SettleClock } from '../compose/compose.utils';
import {
  DATABASE_VOLUME_RELEASE_CLOCK,
  databaseServicePresence,
  removeDatabaseVolumeWhenReleased,
} from '../databases/common/database-ops';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { bucket, cloudAccount, environment, project } from '../db/schema';
import { OBJECT_STORAGE } from '../object-storage/object-storage.port';
import type {
  EmptyOutcome,
  ObjectStoragePort,
  ObjectStorageTarget,
} from '../object-storage/object-storage.port';
import {
  ConsoleSaves,
  KEEP_NOTHING,
  writeKept,
} from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { TraefikWriterService } from '../traefik/traefik-writer.service';
import { keepsFiles } from './bucket-files';
import { leftAsItWas } from './bucket-files';
import type {
  BucketFiles,
  BucketKeptBecause,
  BucketLeftAsItWas,
  BucketLeftBehind,
} from './bucket-files';
import { removeBucketService } from './bucket-ops';
import { GARAGE_REACH } from './garage-reach';
import type { GarageReach } from './garage-reach';
import { GARAGE_REGION } from './garage';
import { CloudBucketDeletes } from './cloud-bucket-deletes.service';
import { leftGrantOf } from './google-bucket-access';
import type { CloudBucketDeleteStarted } from './cloud-bucket-deletes.service';
import { describeError } from '../common/describe-error';

/**
 * A bucket's Delete answered: `bucketLeftBehind` names the bucket it
 * kept, once; `volumeLeftBehind` is an empty bucket's volume Docker would not
 * remove. A bucket that went whole carries neither.
 *
 * A bucket on AWS is kept, with its account and region, at once; or
 * `cloudDelete` names the destroy-only Cloud run its Delete queued, while
 * the bucket reads "Deleting".
 */
export interface BucketDeleted {
  readonly volumeLeftBehind: boolean;
  readonly bucketLeftBehind?: BucketLeftBehind;
  /**
   * An existing bucket's Delete (ADR-0033): the bucket it left as it
   * was, files and all, and the sentence saying so. Nothing reached AWS.
   * On Google Cloud it comes beside `cloudDelete`, the run that
   * destroys the key and account Cloudgate made, and names the grant the
   * operator added on the bucket, with the line that removes it.
   */
  readonly bucketLeftAsItWas?: BucketLeftAsItWas;
  readonly cloudDelete?: {
    readonly status: 'deleting';
    readonly deploymentId: string;
  };
}

/**
 * An Environment's or Project's Delete of its buckets, read before the
 * cascade tears them down (`cascadeFiles`): `settle` then removes each empty
 * bucket's volume and names every other bucket.
 */
export interface BucketCascade {
  settle(remoteExec: RemoteExecService): Promise<BucketLeftBehind[]>;
}

/** The columns a bucket's files are read and its volume settled from. */
const FILES_COLUMNS = {
  bucketId: bucket.bucketId,
  appName: bucket.appName,
  serverId: bucket.serverId,
  volumeName: bucket.volumeName,
  bucketName: bucket.bucketName,
  accessKeyId: bucket.accessKeyId,
  secretAccessKey: bucket.secretAccessKey,
  cloudAccountId: bucket.cloudAccountId,
  configName: bucket.configName,
  existing: bucket.existing,
};

interface FilesSource {
  readonly appName: string;
  readonly serverId: string | null;
  readonly volumeName: string;
  readonly bucketName: string;
  readonly accessKeyId: string | null;
  readonly secretAccessKey: string | null;
  readonly cloudAccountId: string | null;
  readonly configName: string;
  readonly existing: boolean;
}

/**
 * A bucket's Delete never loses a user's files by accident (the
 * **Delete** entry in `CONTEXT.md`): a bucket that holds files — any object,
 * old version or delete marker — is kept and named once as left behind, an
 * empty one goes whole, and only the bucket's own Delete or Plan destroy may
 * ask for its files to go. On a Server "kept" is its volume.
 * Whether it holds files is one cheap read through the object-storage port,
 * at its Garage, while its Garage still runs.
 */
@Injectable()
export class BucketDeletes {
  private readonly logger = new Logger(BucketDeletes.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    @Inject(GARAGE_REACH) private readonly garageReach: GarageReach,
    private readonly traefikWriter: TraefikWriterService,
    @Optional()
    @Inject(DATABASE_VOLUME_RELEASE_CLOCK)
    private readonly volumeReleaseClock: SettleClock = systemSettleClock,
    // Optional for the same reason a database's is: a hand-built spec
    // constructs this with no config seam.
    @Optional() private readonly consoleSaves?: ConsoleSaves,
    // Optional likewise: a bucket on AWS is the only one it reaches.
    @Optional() private readonly cloudDeletes?: CloudBucketDeletes,
    // An existing bucket's lookup workspace, which holds nothing and
    // goes with its Delete. Optional likewise.
    @Optional() private readonly states?: InfrastructureStatesService,
  ) {}

  /**
   * A bucket's Delete (ADR-0018), from the console or a plan's destroy:
   * `service: delete` on the bucket, and nothing more when `deleteFiles`
   * asks for its files to go.
   *
   * Its files are read first. With `deleteFiles`, a bucket not known to be
   * empty is emptied, old versions and delete markers included; an emptying
   * that stops partway does not stop the Delete. Then its
   * Garage service and config secret are taken off its run Server and —
   * once Swarm says the service is gone — its row. Its volume goes only when
   * the bucket was empty; any other bucket keeps its volume and is named once
   * in `bucketLeftBehind`, and Cloudgate forgets it. A service still there,
   * or a Server that cannot say, keeps the row and refuses (409).
   */
  async remove(
    ctx: PermissionCtx,
    bucketId: string,
    options: { readonly deleteFiles?: boolean } = {},
  ): Promise<BucketDeleted> {
    const write = (keep: KeepConfig) =>
      this.removeRow(ctx, bucketId, options.deleteFiles === true, keep);
    if (!this.consoleSaves) return write(KEEP_NOTHING);
    return this.consoleSaves.remove(
      ctx,
      { serviceType: 'bucket', serviceId: bucketId },
      write,
    );
  }

  /**
   * **Retry** a bucket on AWS's incomplete Delete (ADR-0038): another
   * destroy-only Cloud run from the kept state, emptying it again first when
   * the Delete asked for its files to go. `service: delete`, as the Delete.
   */
  async retryCloud(ctx: PermissionCtx, bucketId: string) {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'delete');
    await this.findOwned(ctx, bucketId);
    const started = await this.requireCloudDeletes().start(
      ctx,
      await this.cloudRow(bucketId),
      { deleteFiles: false, retrying: true },
      KEEP_NOTHING,
    );
    return cloudAnswer(started);
  }

  /**
   * **Forget** a bucket on AWS's incomplete Delete (ADR-0038): the row
   * and state dropped with what is left still in AWS, the list written into
   * the audit entry. `service: delete`.
   */
  async forgetCloud(ctx: PermissionCtx, bucketId: string) {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'delete');
    await this.findOwned(ctx, bucketId);
    return this.requireCloudDeletes().forget(
      ctx,
      await this.cloudRow(bucketId),
    );
  }

  /**
   * Whether a bucket holds files, for its destroy row in a plan, read when
   * the plan is made. Never throws: what cannot be read, a
   * bucket gone included, is `unknown`. A bucket on AWS is read against S3.
   */
  async filesOf(bucketId: string): Promise<BucketFiles> {
    const [found] = await this.db
      .select(FILES_COLUMNS)
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    // An existing bucket's files are never read; a plan never asks.
    if (!found || found.existing) return 'unknown';
    if (found.cloudAccountId !== null) {
      return this.cloudDeletes
        ? this.cloudDeletes.filesOf(await this.cloudRow(bucketId))
        : 'unknown';
    }
    return this.readFiles(found);
  }

  /**
   * An Environment's or Project's Delete of these buckets,
   * which never asks for files to go: each bucket's files are read now,
   * before the cascade tears its Garage down, and `settle` — once the
   * cascade is through — removes each empty bucket's volume and names every
   * other bucket as left behind.
   */
  async cascadeFiles(bucketIds: readonly string[]): Promise<BucketCascade> {
    const found =
      bucketIds.length === 0
        ? []
        : await this.db
            .select(FILES_COLUMNS)
            .from(bucket)
            .where(
              and(
                inArray(bucket.bucketId, [...bucketIds]),
                // A bucket on AWS goes by its cloud Delete, first.
                isNull(bucket.cloudAccountId),
              ),
            );
    const read: { one: FilesSource; files: BucketFiles }[] = [];
    for (const one of found) {
      read.push({ one, files: await this.readFiles(one) });
    }
    return {
      settle: async (remoteExec) => {
        const left: BucketLeftBehind[] = [];
        for (const { one, files } of read) {
          const settled = await this.settleVolume(remoteExec, one, files);
          if (settled.bucketLeftBehind) left.push(settled.bucketLeftBehind);
        }
        return left;
      },
    };
  }

  private async removeRow(
    ctx: PermissionCtx,
    bucketId: string,
    deleteFiles: boolean,
    keep: KeepConfig,
  ): Promise<BucketDeleted> {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'delete');
    const owned = await this.findOwned(ctx, bucketId);
    // An existing bucket whose own state holds what Cloudgate made for it —
    // on Google Cloud its key account and key — is the cloud
    // Delete's, which destroys only those; any other, its records alone.
    if (owned.existing && !(await this.states?.findForBucket(bucketId))) {
      return this.removeExisting(bucketId, owned, deleteFiles, keep);
    }
    if (owned.existing) {
      if (deleteFiles) throw existingFilesRefused(owned.bucketName);
      // Read before the run starts, which removes the row once it ends.
      const left = await this.leftWithGrant(owned, bucketId);
      const started = await this.requireCloudDeletes().start(
        ctx,
        await this.cloudRow(bucketId),
        { deleteFiles: false, retrying: false },
        keep,
      );
      return { ...cloudAnswer(started), bucketLeftAsItWas: left };
    }
    // On AWS its Delete is the cloud Delete's (ADR-0038).
    if (owned.cloudAccountId !== null) {
      const started = await this.requireCloudDeletes().start(
        ctx,
        await this.cloudRow(bucketId),
        { deleteFiles, retrying: false },
        keep,
      );
      return cloudAnswer(started);
    }

    let files: BucketFiles | 'partly-emptied' = await this.readFiles(owned);
    if (deleteFiles && keepsFiles(files)) {
      const emptied = await this.emptyFiles(owned);
      if (emptied.ok) {
        files = 'empty';
      } else {
        files = 'partly-emptied';
        this.logger.warn(
          `${owned.appName}: the bucket ${owned.bucketName} was only partly emptied — ${emptied.message}`,
        );
      }
    }

    await removeBucketService(
      this.remoteExec,
      owned.serverId,
      owned.appName,
    ).catch(() => undefined);
    // Its Domains' routes: the rows cascade with the bucket, the file
    // they generated does not, and a public host would stay routed at
    // nothing. Best effort, as an Application's is, and named in the log.
    await this.traefikWriter
      .removeConfig(owned.appName, owned.serverId)
      .catch((error: unknown) =>
        this.logger.warn(
          `${owned.appName}: the Traefik config of its Domains was not removed — ${describeError(error)}`,
        ),
      );
    const presence = await databaseServicePresence(
      this.remoteExec,
      owned.serverId,
      owned.appName,
    );
    if (presence !== 'absent') {
      throw new ConflictException(
        presence === 'present'
          ? `Swarm service ${owned.appName} is still running, so the bucket was kept — delete it again once it has stopped`
          : `Cloudgate could not reach Docker to confirm swarm service ${owned.appName} is gone, so the bucket was kept — delete it again when the Server is reachable`,
      );
    }
    const answer = await this.settleVolume(this.remoteExec, owned, files);
    // The row goes in the transaction its console Save's config rewrite
    // commits in.
    await writeKept(
      this.db,
      keep,
      (db) => db.delete(bucket).where(eq(bucket.bucketId, bucketId)),
      () => ({ serviceId: bucketId, removed: answer }),
    );
    return answer;
  }

  /**
   * An existing bucket's Delete (ADR-0033): only Cloudgate's records
   * go — its row and its lookup's workspace, which holds nothing. Nothing
   * reaches AWS: the bucket and its files are the operator's, so "also
   * delete its files" is refused rather than ignored, and the answer says
   * the bucket was left as it was. The config is not rewritten unless it
   * is Cloudgate-kept, as any Delete's.
   */
  private async removeExisting(
    bucketId: string,
    owned: FilesSource,
    deleteFiles: boolean,
    keep: KeepConfig,
  ): Promise<BucketDeleted> {
    if (deleteFiles) throw existingFilesRefused(owned.bucketName);
    const answer: BucketDeleted = {
      volumeLeftBehind: false,
      bucketLeftAsItWas: leftAsItWas(owned.bucketName, owned.configName),
    };
    await writeKept(
      this.db,
      keep,
      (db) => db.delete(bucket).where(eq(bucket.bucketId, bucketId)),
      () => ({ serviceId: bucketId, removed: answer }),
    );
    await this.states?.remove(bucketId);
    return answer;
  }

  /**
   * A bucket's volume once its Garage is gone: removed when the bucket was
   * empty, else kept with the bucket named. An empty bucket's volume Docker
   * would not remove is a volume left behind, never a failed Delete.
   */
  private async settleVolume(
    remoteExec: RemoteExecService,
    found: FilesSource,
    files: BucketFiles | 'partly-emptied',
  ): Promise<BucketDeleted> {
    if (files !== 'empty') {
      const because: BucketKeptBecause = files;
      return {
        volumeLeftBehind: false,
        bucketLeftBehind: {
          bucketName: found.bucketName,
          volumeName: found.volumeName,
          serverId: found.serverId,
          because,
        },
      };
    }
    try {
      await removeDatabaseVolumeWhenReleased(
        remoteExec,
        found.serverId,
        found.volumeName,
        this.volumeReleaseClock,
      );
      return { volumeLeftBehind: false };
    } catch (error) {
      this.logger.warn(
        `${found.appName}: the empty bucket's volume ${found.volumeName} was not removed — ${describeError(error)}`,
      );
      return { volumeLeftBehind: true };
    }
  }

  /**
   * Whether the bucket holds files, through the object-storage port at its
   * Garage. A bucket that never got its key holds none: Garage makes the key
   * right after the bucket, and nothing writes a file without it.
   */
  private async readFiles(found: FilesSource): Promise<BucketFiles> {
    if (found.accessKeyId === null || found.secretAccessKey === null) {
      return 'empty';
    }
    try {
      return await this.atGarage(found, (target) =>
        this.objectStorage.contentsOf(target),
      );
    } catch (error) {
      this.logger.warn(
        `${found.appName}: Cloudgate could not tell whether ${found.bucketName} holds files — ${describeError(error)}`,
      );
      return 'unknown';
    }
  }

  private async emptyFiles(found: FilesSource): Promise<EmptyOutcome> {
    try {
      return await this.atGarage(found, (target) =>
        this.objectStorage.empty(target),
      );
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  /** `use` with the bucket's S3 API open, reached with its one key. */
  private async atGarage<T>(
    found: FilesSource,
    use: (target: ObjectStorageTarget) => Promise<T>,
  ): Promise<T> {
    const { accessKeyId, secretAccessKey } = found;
    if (accessKeyId === null || secretAccessKey === null) {
      throw new Error(`${found.bucketName} has no key yet`);
    }
    const reached = await this.garageReach.open(found);
    try {
      return await use({
        endpoint: reached.endpoint,
        region: GARAGE_REGION,
        bucket: found.bucketName,
        credential: { accessKeyId, secretAccessKey },
        pathStyle: true,
      });
    } finally {
      await reached.close();
    }
  }

  private requireCloudDeletes(): CloudBucketDeletes {
    if (!this.cloudDeletes) {
      throw new Error('Nothing deletes a bucket on AWS here');
    }
    return this.cloudDeletes;
  }

  private async cloudRow(bucketId: string) {
    const [found] = await this.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    if (!found) throw new NotFoundException('Bucket not found');
    // An existing bucket's Delete never runs in AWS; on Google Cloud
    // it destroys what its own state holds.
    if (
      found.cloudAccountId === null ||
      (found.existing && !(await this.states?.findForBucket(bucketId)))
    ) {
      throw new NotFoundException('This bucket has no cloud Delete');
    }
    return found;
  }

  /**
   * What an existing bucket on Google Cloud's Delete leaves: the
   * bucket and its files, and the operator's grant on it, named with the
   * exact line that removes it.
   */
  private async leftWithGrant(
    owned: FilesSource,
    bucketId: string,
  ): Promise<BucketLeftAsItWas> {
    const [placed] = await this.db
      .select({ projectId: cloudAccount.cloudId })
      .from(bucket)
      .innerJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, bucket.cloudAccountId),
      )
      .where(eq(bucket.bucketId, bucketId));
    return leftAsItWas(
      owned.bucketName,
      owned.configName,
      placed
        ? leftGrantOf(
            { bucketId, bucketName: owned.bucketName },
            placed.projectId,
          )
        : undefined,
    );
  }

  /** Org-scoped: a bucket of another organization is a 404. */
  private async findOwned(
    ctx: PermissionCtx,
    bucketId: string,
  ): Promise<FilesSource> {
    const [found] = await this.db
      .select(FILES_COLUMNS)
      .from(bucket)
      .innerJoin(
        environment,
        eq(bucket.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(bucket.bucketId, bucketId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Bucket not found');
    return found;
  }
}

/** The refusal code of "also delete its files" on an existing bucket. */
export const EXISTING_BUCKET_FILES_CODE = 'EXISTING_BUCKET_FILES_NOT_DELETED';

/** "Also delete its files" on an existing bucket: refused, never ignored. */
function existingFilesRefused(bucketName: string): ConflictException {
  return new ConflictException({
    message: `${bucketName} is an existing bucket, which Cloudgate uses but doesn't manage, so its Delete never deletes its files; delete it without "also delete its files"`,
    code: EXISTING_BUCKET_FILES_CODE,
  });
}

/**
 * A bucket's cloud Delete, as its route answers it: on Google Cloud a
 * kept bucket is named at once beside the run destroying its key.
 */
function cloudAnswer(started: CloudBucketDeleteStarted): BucketDeleted {
  return started.kind === 'kept'
    ? { volumeLeftBehind: false, bucketLeftBehind: started.kept }
    : {
        volumeLeftBehind: false,
        ...(started.kept ? { bucketLeftBehind: started.kept } : {}),
        cloudDelete: { status: 'deleting', deploymentId: started.deploymentId },
      };
}
