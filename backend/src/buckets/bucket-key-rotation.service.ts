import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';

import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { byCloud, cloudOrLegacy } from '../cloud-accounts/cloud-provider';
import type { PerCloud } from '../cloud-accounts/cloud-provider';
import { mysql } from '../databases/mysql/mysql.schema';
import { MysqlService } from '../databases/mysql/mysql.service';
import { postgres } from '../databases/postgres/postgres.schema';
import { PostgresService } from '../databases/postgres/postgres.service';
import { redis } from '../databases/redis/redis.schema';
import { RedisService } from '../databases/redis/redis.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  bucket,
  cloudAccount,
  deployment,
  environment,
  project,
} from '../db/schema';
import { DeploymentsService } from '../deployments/deployments.service';
import {
  markServicesWiredChanged,
  servicesLinking,
  servicesStillWiredChanged,
} from '../project-config/outputs';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import type {
  Bucket,
  BucketKey,
  KeyRotation,
  KeyRotationRedeploy,
} from './bucket.schema';
import {
  createKeyProgram,
  readCreatedKey,
  readRemovedKeys,
  removeKeysProgram,
} from './garage';
import { describeError } from '../common/describe-error';
import { BucketsService } from './buckets.service';
import type { BucketRead } from './buckets.service';
import { GoogleBucketKeys } from './google-bucket-keys.service';
import { googleKeyLayout } from './google-key-layout';

/**
 * How often a rotation looks at its redeploys, and how long one may take
 * before it counts as failed. A token so the e2e lane looks often.
 */
export const KEY_ROTATION_CLOCK = Symbol('KEY_ROTATION_CLOCK');

export interface KeyRotationClock {
  readonly everyMs: number;
  /** From the redeploy's queueing; a build longer than this has failed. */
  readonly budgetMs: number;
}

const DEFAULT_CLOCK: KeyRotationClock = {
  everyMs: 5_000,
  budgetMs: 2 * 60 * 60_000,
};

/** The two Outputs a rotation changes: who links one is redeployed. */
const KEY_OUTPUTS = ['access_key_id', 'secret_access_key'] as const;

const NOT_FOUND = 'Bucket not found';

/** The database tables a linking database's deploy is followed through. */
const DATABASE_STATUS = {
  postgres: { table: postgres, id: postgres.postgresId },
  mysql: { table: mysql, id: mysql.mysqlId },
  redis: { table: redis, id: redis.redisId },
} as const;

type Redeploy = KeyRotationRedeploy;

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * One place's half of a Rotate key (ADR-0043): where the bucket's keys are
 * made and removed — Garage on a Server, the bucket's own
 * Infrastructure state on Cloud Storage. Everything else, the
 * redeploys, the put-backs and what is stored when, is the rotation's own.
 */
interface KeyHalf {
  /** Where its keys are, as a sentence names it. */
  readonly where: string;
  /** Why its key cannot be rotated now, or `null`. */
  refusal(found: Bucket): Promise<string | null>;
  /** The sentence of a new key that was not made, so nothing changed. */
  unmade(configName: string): string;
  /**
   * The new key, apart from the stored one, with the strays still to
   * remove; throws when it was not made.
   */
  make(
    found: Bucket,
  ): Promise<{ key: BucketKey; strayKeyIds: readonly string[] }>;
  /** Removes the old key and the strays; answers the IDs it could not. */
  removeOld(found: Bucket, keyIds: readonly string[]): Promise<string[]>;
  /** Removes a failed rotation's new key; answers the IDs it could not. */
  removeNew(found: Bucket, keyIds: readonly string[]): Promise<string[]>;
  /** What the row stores beside the new key once it is the bucket's. */
  stored(found: Bucket): Partial<Pick<Bucket, 'googleKeySlot'>>;
  /**
   * After a restart cut the rotation off before its new key was stored:
   * removes a key it may have made that the row does not know of; answers
   * whether none is left.
   */
  removeUnstored(found: Bucket): Promise<boolean>;
}

/** A bucket row with its Cloud account's cloud, `null` on a Server. */
type Placed = Bucket & { readonly cloud: CloudKind | null };

/**
 * A Server bucket's **Rotate key** (ADR-0037): a console action with
 * no schedule and nothing in the config, an ordinary `service: update` on
 * the bucket.
 *
 * 1. Through Cloudgate's admin access to the bucket's Garage, a new key
 *    with read and write on that bucket only, kept apart from the stored
 *    one (`rotationKeys`).
 * 2. Every Service linking the key's Outputs is redeployed, and its wired variables are
 * filled in with the new key
 *    while this phase runs (`wired-env.ts`).
 * 3. Only when every redeploy succeeded is the old key removed and the new
 *    one stored, encrypted.
 *
 * When one fails, the Services already on the new key are deployed again
 * with the old one, and only then is the new key removed: the old key stays
 * valid and stored throughout, so nothing loses access, and the result names
 * the Service that failed. A put-back that fails too leaves the new key in
 * Garage for that Service, marked to deploy again, and the next rotation
 * that succeeds removes it. On Cloud Storage, whose state has one spare
 * key slot, the next rotation waits for that deploy instead.
 *
 * The redeploys are builds, so the action answers once they are queued and
 * the rest runs in the background, written to the bucket's `keyRotation`; a
 * restart picks a running rotation up where its row says it is.
 *
 * **On Cloud Storage** (spec "Key rotation copies a Server") it
 * is the same rotation, its keys made and removed in the bucket's own
 * Infrastructure state rather than in Garage ({@link GoogleBucketKeys}). A
 * bucket on S3 has no key: its linking Services reach it through their own
 * task role. Each place's half is chosen in one place ({@link KeyHalf},
 * ADR-0043).
 */
@Injectable()
export class BucketKeyRotation implements OnApplicationBootstrap {
  private readonly logger = new Logger(BucketKeyRotation.name);

  /** Rotations this process is following, so a bucket has one follower. */
  private readonly following = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly deployments: DeploymentsService,
    private readonly postgres: PostgresService,
    private readonly mysql: MysqlService,
    private readonly redis: RedisService,
    private readonly buckets: BucketsService,
    private readonly google: GoogleBucketKeys,
    @Optional()
    @Inject(KEY_ROTATION_CLOCK)
    private readonly clock: KeyRotationClock = DEFAULT_CLOCK,
  ) {}

  /** Picks up every rotation a restart interrupted. */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.db
      .select({ bucketId: bucket.bucketId, keyRotation: bucket.keyRotation })
      .from(bucket)
      .where(isNotNull(bucket.keyRotation));
    for (const row of rows) {
      if (row.keyRotation?.status === 'running')
        this.followInBackground(row.bucketId);
    }
  }

  /**
   * Starts a rotation: the new key made and every linking Service's redeploy
   * queued before it answers. Refused (409) on a bucket with no key — one
   * not yet deployed, or an AWS bucket, whose Services reach it through
   * their own identity — on one whose Garage is not running, and while
   * another rotation of it runs. Answers the bucket, whose `keyRotation`
   * then follows the redeploys to their end.
   */
  async rotate(ctx: PermissionCtx, bucketId: string): Promise<BucketRead> {
    await this.permissions.checkServiceAccess(ctx, bucketId, 'update');
    const owned = await this.findOwned(ctx, bucketId);
    const half = this.halfOf(owned);
    const refused = await half.refusal(owned);
    if (refused) throw new ConflictException(refused);
    await this.claim(bucketId, owned.configName);

    let made: { key: BucketKey; strayKeyIds: readonly string[] };
    try {
      made = await half.make(owned);
    } catch (error) {
      this.logger.warn(
        `${owned.appName}: the new key of ${owned.bucketName} was not made — ${describeError(error)}`,
      );
      const message = half.unmade(owned.configName);
      await this.end(bucketId, { status: 'failed', failed: [], message });
      throw new ConflictException(message);
    }

    await this.db
      .update(bucket)
      .set({
        rotationKeys: {
          newKey: made.key,
          strayKeyIds: [...made.strayKeyIds],
        },
        keyRotation: {
          ...(await this.state(bucketId)),
          phase: 'redeploying',
        },
      })
      .where(eq(bucket.bucketId, bucketId));
    await this.queueRedeploys(bucketId);
    this.followInBackground(bucketId);
    return this.buckets.findOne(ctx, bucketId);
  }

  /**
   * Marks the bucket rotating, or refuses while it already is. Under the
   * row's lock, so two presses make one rotation.
   */
  private async claim(bucketId: string, configName: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ keyRotation: bucket.keyRotation })
        .from(bucket)
        .where(eq(bucket.bucketId, bucketId))
        .for('update');
      if (locked?.keyRotation?.status === 'running') {
        throw new ConflictException(
          `${configName}'s key is already being rotated; wait for that rotation to end`,
        );
      }
      const started: KeyRotation = {
        status: 'running',
        phase: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        queued: false,
        redeploys: [],
        putBacks: [],
        failed: [],
        message: null,
      };
      await tx
        .update(bucket)
        .set({ keyRotation: started })
        .where(eq(bucket.bucketId, bucketId));
    });
  }

  /** Queues a redeploy of every Service linking the key, and records them. */
  private async queueRedeploys(bucketId: string): Promise<void> {
    const [found] = await this.db
      .select({
        environmentId: bucket.environmentId,
        configName: bucket.configName,
      })
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    if (!found) return;
    const linking = await servicesLinking(this.db, found, KEY_OUTPUTS);
    const redeploys: Redeploy[] = [];
    for (const service of linking) {
      redeploys.push(
        await this.redeploy(
          service,
          `${found.configName}'s key was rotated`,
          'Queued by rotating the key of the bucket it links',
        ),
      );
    }
    await this.patch(bucketId, { queued: true, redeploys });
  }

  /**
   * One Service's redeploy: an Application's Deployment queued, or a
   * database's own deploy started — `apply`, so a stopped one stays
   * stopped with its new variables in its spec. A refusal is a failed
   * redeploy, there and then.
   */
  private async redeploy(
    service: {
      serviceType: Redeploy['serviceType'];
      serviceId: string;
      configName: string;
    },
    title: string,
    description: string,
  ): Promise<Redeploy> {
    const base = {
      ...service,
      deploymentId: null,
      queuedAt: new Date().toISOString(),
    };
    try {
      if (service.serviceType === 'application') {
        const queued = await this.deployments.deployForLinkedOutput(
          service.serviceId,
          { title, description },
        );
        return { ...base, deploymentId: queued.deploymentId, outcome: null };
      }
      await this.databaseService(service.serviceType).deployInternal(
        service.serviceId,
        'apply',
      );
      return { ...base, outcome: null };
    } catch (error) {
      this.logger.warn(
        `${service.configName} was not redeployed for a key rotation — ${describeError(error)}`,
      );
      return { ...base, outcome: 'failed' };
    }
  }

  private databaseService(serviceType: 'postgres' | 'mysql' | 'redis') {
    switch (serviceType) {
      case 'postgres':
        return this.postgres;
      case 'mysql':
        return this.mysql;
      case 'redis':
        return this.redis;
    }
  }

  private followInBackground(bucketId: string): void {
    if (this.following.has(bucketId)) return;
    this.following.add(bucketId);
    this.follow(bucketId)
      .catch((error: unknown) =>
        this.logger.error(
          `Bucket ${bucketId}: its key rotation stopped — ${describeError(error)}`,
        ),
      )
      .finally(() => this.following.delete(bucketId));
  }

  /** Runs a rotation from wherever its row says it is to its end. */
  private async follow(bucketId: string): Promise<void> {
    for (;;) {
      const state = await this.state(bucketId).catch(() => null);
      if (!state || state.status !== 'running') return;
      switch (state.phase) {
        case null: {
          // Interrupted while its key was being made: nothing was stored
          // and nothing redeployed, so the old key is all there is, and a
          // key the place may have made is removed.
          const found = await this.keysOf(bucketId);
          const half = found ? this.halfOf(found) : null;
          const clean = found && half ? await half.removeUnstored(found) : true;
          await this.end(bucketId, {
            status: 'failed',
            failed: [],
            message: clean
              ? 'The rotation was interrupted before its new key was stored, so nothing changed and the old key stays in use — rotate again'
              : `The rotation was interrupted before its new key was stored, so the old key stays in use, but Cloudgate could not remove a key it may have made from ${half?.where}; its Remove the unstored key run says why — rotate again`,
          });
          return;
        }
        case 'redeploying': {
          if (!state.queued) {
            // Interrupted before its redeploys were recorded: queue them now,
            // never read "none" as "all done".
            await this.queueRedeploys(bucketId);
            continue;
          }
          const redeploys = await this.settled(state.redeploys);
          await this.patch(bucketId, { redeploys });
          if (redeploys.some((one) => one.outcome === null)) break;
          const failed = redeploys.filter((one) => one.outcome === 'failed');
          if (failed.length === 0) {
            await this.succeed(bucketId, redeploys);
            return;
          }
          // Back onto the old key before the new one goes, for every Service
          // that already runs with the new one.
          await this.patch(bucketId, {
            phase: 'putting-back',
            failed: failed.map((one) => one.configName),
          });
          const putBacks: Redeploy[] = [];
          for (const one of redeploys.filter((r) => r.outcome === 'done')) {
            putBacks.push(
              await this.redeploy(
                one,
                'Put back on the bucket key it had',
                'Queued because a key rotation of the bucket it links failed',
              ),
            );
          }
          await this.patch(bucketId, { putBacks });
          continue;
        }
        case 'putting-back': {
          const putBacks = await this.settled(state.putBacks);
          await this.patch(bucketId, { putBacks });
          if (putBacks.some((one) => one.outcome === null)) break;
          await this.fail(bucketId, state.failed, putBacks);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.clock.everyMs));
    }
  }

  /** Each redeploy with the outcome it has reached, if any. */
  private async settled(redeploys: readonly Redeploy[]): Promise<Redeploy[]> {
    const now = Date.now();
    const out: Redeploy[] = [];
    for (const one of redeploys) {
      if (one.outcome !== null) {
        out.push(one);
        continue;
      }
      let outcome = await this.outcomeOf(one);
      if (
        outcome === null &&
        now - Date.parse(one.queuedAt) > this.clock.budgetMs
      ) {
        outcome = 'failed';
      }
      out.push({ ...one, outcome });
    }
    return out;
  }

  private async outcomeOf(one: Redeploy): Promise<Redeploy['outcome']> {
    if (one.serviceType === 'application') {
      if (!one.deploymentId) return 'failed';
      const [row] = await this.db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.deploymentId, one.deploymentId));
      if (!row) return 'failed';
      if (row.status === 'done') return 'done';
      if (row.status === 'error' || row.status === 'cancelled') {
        return 'failed';
      }
      return null;
    }
    const { table, id } = DATABASE_STATUS[one.serviceType];
    const [row] = await this.db
      .select({ status: table.applicationStatus })
      .from(table)
      .where(eq(id, one.serviceId));
    if (!row) return 'failed';
    if (row.status === 'running') return null;
    return row.status === 'error' ? 'failed' : 'done';
  }

  /**
   * Every redeploy succeeded: the old key — and any a past rotation could
   * not remove — taken out of Garage, and the new one stored.
   */
  private async succeed(
    bucketId: string,
    redeploys: readonly Redeploy[],
  ): Promise<void> {
    const found = await this.keysOf(bucketId);
    if (!found) return;
    const { newKey } = found.rotationKeys ?? { newKey: null };
    if (!newKey) {
      await this.end(bucketId, {
        status: 'failed',
        failed: [],
        message:
          'The rotation lost its new key, so the old key stays in use — rotate again',
      });
      return;
    }
    const retiring = [
      ...(found.accessKeyId ? [found.accessKeyId] : []),
      ...(found.rotationKeys?.strayKeyIds ?? []),
    ].filter((id) => id !== newKey.accessKeyId);
    const half = this.halfOf(found);
    const left = await half.removeOld(found, retiring);
    await this.db
      .update(bucket)
      .set({
        ...half.stored(found),
        accessKeyId: newKey.accessKeyId,
        secretAccessKey: newKey.secretAccessKey,
        rotationKeys:
          left.length > 0 ? { newKey: null, strayKeyIds: left } : null,
      })
      .where(eq(bucket.bucketId, bucketId));
    const services =
      redeploys.length === 0
        ? 'No Service links its key'
        : `${listed(redeploys.map((one) => one.configName))} ${redeploys.length === 1 ? 'runs' : 'run'} with the new key`;
    await this.end(bucketId, {
      status: 'done',
      failed: [],
      message:
        left.length === 0
          ? `${services}, and the old key was removed`
          : `${services}, but Cloudgate could not remove the old key from ${half.where}, so it still opens the bucket; the next rotation removes it`,
    });
  }

  /**
   * A redeploy failed and the put-backs ended: the new key removed when
   * every Service is back on the old one, and kept for any that is not.
   */
  private async fail(
    bucketId: string,
    failed: readonly string[],
    putBacks: readonly Redeploy[],
  ): Promise<void> {
    const found = await this.keysOf(bucketId);
    if (!found) return;
    const strays = found.rotationKeys?.strayKeyIds ?? [];
    const newKey = found.rotationKeys?.newKey ?? null;
    const stuck = putBacks.filter((one) => one.outcome === 'failed');
    let kept = [...strays];
    if (newKey) {
      if (stuck.length === 0) {
        const left = await this.halfOf(found).removeNew(found, [
          newKey.accessKeyId,
        ]);
        kept = [...kept, ...left];
      } else {
        kept = [...kept, newKey.accessKeyId];
      }
    }
    // Each still runs with the new key, not the stored one, until deployed
    // again: its page says so, and on Cloud Storage the next rotation waits
    // for that deploy before it replaces the key they hold.
    await markServicesWiredChanged(this.db, stuck);
    await this.db
      .update(bucket)
      .set({
        rotationKeys:
          kept.length > 0 ? { newKey: null, strayKeyIds: kept } : null,
      })
      .where(eq(bucket.bucketId, bucketId));
    const why = `The redeploy of ${listed(failed)} failed, so the old key stays in use`;
    await this.end(bucketId, {
      status: 'failed',
      failed,
      message:
        stuck.length === 0
          ? `${why} and the new key was removed — fix ${listed(failed)}, then rotate again`
          : `${why}; ${listed(stuck.map((one) => one.configName))} could not be put back on it, so the new key stays valid for ${stuck.length === 1 ? 'it' : 'them'} until the next rotation removes it`,
    });
  }

  /** Removes `keyIds` from the bucket's Garage; the IDs it could not. */
  private async removeGarageKeys(
    found: { appName: string; serverId: string | null },
    keyIds: readonly string[],
  ): Promise<string[]> {
    if (keyIds.length === 0) return [];
    try {
      const { stdout } = await execOnServer(
        this.remoteExec,
        found.serverId,
        removeKeysProgram(found.appName, keyIds),
      );
      const removed = new Set(readRemovedKeys(stdout));
      return keyIds.filter((id) => !removed.has(id));
    } catch (error) {
      this.logger.warn(
        `${found.appName}: keys were not removed from Garage — ${describeError(error)}`,
      );
      return [...keyIds];
    }
  }

  private async keysOf(bucketId: string): Promise<Placed | undefined> {
    const [found] = await this.db
      .select({ row: bucket, cloud: cloudAccount.cloud })
      .from(bucket)
      .leftJoin(
        cloudAccount,
        eq(cloudAccount.cloudAccountId, bucket.cloudAccountId),
      )
      .where(eq(bucket.bucketId, bucketId));
    return found ? { ...found.row, cloud: found.cloud } : undefined;
  }

  /**
   * The bucket's half by its place (ADR-0043): Garage on a Server, else its
   * Cloud account's cloud's.
   */
  private halfOf(found: Placed): KeyHalf {
    if (found.cloudAccountId === null) return this.garage;
    return byCloud<KeyHalf>(cloudOrLegacy(found.cloud), this.cloudHalves);
  }

  /** A Server bucket's keys, in its Garage. */
  private readonly garage: KeyHalf = {
    where: 'Garage',
    refusal: (found) => {
      if (found.accessKeyId === null) {
        return Promise.resolve(
          `${found.configName} has no key to rotate: Garage makes it on the bucket's first deploy`,
        );
      }
      if (found.applicationStatus !== 'done') {
        return Promise.resolve(
          `${found.configName}'s key cannot be rotated while its Garage is not running; deploy it, then rotate`,
        );
      }
      return Promise.resolve(null);
    },
    unmade: (name) =>
      `Cloudgate could not make a new key for ${name}, so nothing changed and the old key stays in use — try again once its Garage is running`,
    make: async (found) => {
      const { stdout } = await execOnServer(
        this.remoteExec,
        found.serverId,
        createKeyProgram(
          found.appName,
          found.bucketName,
          `${found.appName}-${Date.now()}`,
        ),
      );
      const made = readCreatedKey(stdout);
      if (!made) throw new Error('Garage did not hand back the new key');
      return {
        key: made,
        strayKeyIds: found.rotationKeys?.strayKeyIds ?? [],
      };
    },
    removeOld: (found, keyIds) => this.removeGarageKeys(found, keyIds),
    removeNew: (found, keyIds) => this.removeGarageKeys(found, keyIds),
    stored: () => ({}),
    // Garage hands a new key back only once made; one it made then is not
    // known to the row, and stays.
    removeUnstored: () => Promise.resolve(true),
  };

  /** A bucket in a Cloud account's keys, by its cloud. */
  private readonly cloudHalves: PerCloud<KeyHalf> = {
    // An S3 bucket has no key: each linking Service's own task role reaches
    // it (ADR-0032).
    aws: {
      where: 'S3',
      refusal: (found) =>
        Promise.resolve(
          `${found.configName} has no key to rotate: on S3 each Service linking it reaches it through its own task role`,
        ),
      unmade: (name) => `${name} has no key to rotate`,
      make: () => Promise.reject(new Error('An S3 bucket has no key')),
      removeOld: (_found, keyIds) => Promise.resolve([...keyIds]),
      removeNew: (_found, keyIds) => Promise.resolve([...keyIds]),
      stored: () => ({}),
      removeUnstored: () => Promise.resolve(true),
    },
    // Cloud Storage: the HMAC key of the bucket's own service
    // account, in its Infrastructure state.
    gcp: {
      where: 'Cloud Storage',
      refusal: async (found) => {
        if (found.cloudDelete !== null) {
          return `${found.configName} is being deleted, so its key is not rotated`;
        }
        if (found.accessKeyId === null) {
          return `${found.configName} has no key to rotate: its Cloud run makes it with the bucket`;
        }
        if (found.applicationStatus !== 'done') {
          return `${found.configName}'s key cannot be rotated while its Cloud run has not finished; rotate once it is made`;
        }
        return this.spareStillHeld(found);
      },
      unmade: (name) =>
        `Cloudgate could not make a new key for ${name}, so nothing changed and the old key stays in use — its Make a new key run says why; try again`,
      make: (found) => this.google.make(found),
      removeOld: (found, keyIds) => this.google.removeOld(found, keyIds),
      removeNew: (found, keyIds) => this.google.removeNew(found, keyIds),
      stored: (found) => ({ googleKeySlot: this.google.storedSlot(found) }),
      removeUnstored: (found) => this.google.removeUnstored(found),
    },
  };

  /**
   * On Cloud Storage the state has one spare key slot, and a new key is
   * made there after destroying what it holds. After a failed
   * rotation whose put-back of a Service failed, it holds the key that
   * Service still runs with, so a rotation is refused, naming them, until
   * each has been deployed again (and so runs with the stored key): the key
   * a Service uses is never destroyed before it is redeployed.
   */
  private async spareStillHeld(found: Bucket): Promise<string | null> {
    const last = found.keyRotation;
    if (!googleKeyLayout(found).spare || last?.status !== 'failed') {
      return null;
    }
    const stuck = await servicesStillWiredChanged(
      this.db,
      last.putBacks.filter((one) => one.outcome === 'failed'),
    );
    if (stuck.length === 0) return null;
    const names = listed(stuck.map((one) => one.configName));
    return `${names} still ${stuck.length === 1 ? 'runs' : 'run'} with the key ${found.configName}'s last rotation could not take back, and a new key would replace it: deploy ${names} first, so ${stuck.length === 1 ? 'it runs' : 'they run'} with the key in use, then rotate`;
  }

  private async state(bucketId: string): Promise<KeyRotation> {
    const [found] = await this.db
      .select({ keyRotation: bucket.keyRotation })
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    if (!found?.keyRotation) throw new NotFoundException(NOT_FOUND);
    return found.keyRotation;
  }

  private async patch(
    bucketId: string,
    change: Partial<KeyRotation>,
  ): Promise<void> {
    const state = await this.state(bucketId);
    await this.db
      .update(bucket)
      .set({ keyRotation: { ...state, ...change } })
      .where(eq(bucket.bucketId, bucketId));
  }

  private async end(
    bucketId: string,
    outcome: Pick<KeyRotation, 'status' | 'failed' | 'message'>,
  ): Promise<void> {
    await this.patch(bucketId, {
      ...outcome,
      phase: null,
      finishedAt: new Date().toISOString(),
    });
  }

  /** Org-scoped through environment → project. */
  private async findOwned(
    ctx: PermissionCtx,
    bucketId: string,
  ): Promise<Placed> {
    const [found] = await this.db
      .select({ row: bucket, cloud: cloudAccount.cloud })
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
    return { ...found.row, cloud: found.cloud };
  }
}
