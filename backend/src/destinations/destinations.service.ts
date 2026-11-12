import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { destination } from '../db/schema';
import type { Destination } from '../db/schema';
import {
  bucketKeySegments,
  bucketPrefixCandidates,
  normalizeS3Path,
} from '../backups/commands';
import { refusedBucketPrefixes } from '../common/bucket-prefix-owners';
import { checkServerAccess } from '../common/owned-server';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { destinationInUseMessage } from './destination-users';
import type {
  CreateDestinationDto,
  ListDestinationObjectsDto,
  TestConnectionDto,
  TestSavedConnectionDto,
  UpdateDestinationDto,
} from './dto/destination.dto';
import {
  boundedRcloneFlags,
  execRclone,
  rcloneFailureMessage,
} from './rclone-exec';
import { redactS3Credentials } from './s3-credentials';
import type { S3Credentials } from './s3-credentials';

/** A destination as exposed over the API — the secret never leaves the server. */
export type SanitizedDestination = Omit<Destination, 'secretAccessKey'>;

/** One object in a destination's bucket, as the restore picker reads it. */
export interface DestinationObject {
  /** The full S3 object key, bucket-relative — what a restore is given. */
  key: string;
  /** Bytes. */
  size: number;
  /** RFC 3339 instant, straight off rclone's `ModTime`. */
  lastModified: string;
}

/** One entry of `rclone lsjson` output. */
interface RcloneEntry {
  Path: string;
  Name: string;
  Size: number;
  ModTime: string;
  IsDir: boolean;
}

/**
 * How many objects one listing answers with. A restore picks the newest few;
 * a bucket that has been backed up nightly for a year holds hundreds, and the
 * ones that matter are all at the top of a newest-first sort.
 */
const MAX_OBJECTS = 200;

function stripSecret(row: Destination): SanitizedDestination {
  const { secretAccessKey, ...rest } = row;
  void secretAccessKey;
  return rest;
}

@Injectable()
export class DestinationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    // `RbacModule` is `@Global()`, so this costs no wiring in
    // `DestinationsModule` — which matters, because `BackupsModule` imports
    // `DestinationsModule` and a module edge in the other direction is the thing
    // `common/bucket-prefix-owners.ts` was moved to avoid (§1.4).
    private readonly permissions: PermissionService,
    // With no Server named, each probe runs rclone on the platform
    // host with the caller's credentials — refused in hosted mode.
    private readonly instanceMode: InstanceMode,
  ) {}

  /** Create a destination, scoped to the session's active organization. */
  async create(
    ctx: PermissionCtx,
    data: CreateDestinationDto,
  ): Promise<SanitizedDestination> {
    const [created] = await this.db
      .insert(destination)
      .values({ ...data, organizationId: ctx.session.activeOrganizationId })
      .returning();
    return stripSecret(created);
  }

  /** The organization's destinations, secrets stripped. */
  async list(ctx: PermissionCtx): Promise<SanitizedDestination[]> {
    const rows = await this.db
      .select()
      .from(destination)
      .where(eq(destination.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(destination.createdAt));
    return rows.map(stripSecret);
  }

  /** One destination, org-scoped, secret stripped. */
  async findOne(
    ctx: PermissionCtx,
    destinationId: string,
  ): Promise<SanitizedDestination> {
    return stripSecret(await this.findOneWithCredentials(ctx, destinationId));
  }

  /** Update a destination, org-scoped through findOneWithCredentials. */
  async update(
    ctx: PermissionCtx,
    destinationId: string,
    data: UpdateDestinationDto,
  ): Promise<SanitizedDestination> {
    const current = await this.findOneWithCredentials(ctx, destinationId);
    const [updated] = await this.db
      .update(destination)
      .set(data)
      .where(eq(destination.destinationId, current.destinationId))
      .returning();
    return stripSecret(updated);
  }

  /**
   * Delete a destination, org-scoped through findOneWithCredentials — refused
   * with a 409 naming every backup schedule and volume backup still using it.
   *
   * `backup.destination_id` and `volume_backup.destination_id` are both
   * `on delete cascade`, and so are `deployment.backup_id` and
   * `deployment.volume_backup_id` one step further on, so a bare delete here
   * took every schedule writing to this bucket *and every run recorded against
   * them*, while the dialog said nothing else went. Of the two shapes, the
   * refusal is the one taken — the shape `ServersService.remove` gives a Server
   * that still carries a Service, with the same `nameCategory` clauses.
   *
   * **Rejected: the cascade, stated in the dialog.** It would make the copy
   * true, but it keeps a one-click path from "forget these credentials" to
   * "delete a Database's backup history", and the console has no per-destination
   * listing of schedules to state it with before the click. Refusing costs an
   * operator one detour per schedule, and each is recoverable; the cascade is not.
   *
   * **Rejected: changing the FKs to `restrict` or `set null`.** `restrict`
   * would answer a 500 with Postgres' words rather than this sentence, and
   * `set null` would leave a schedule whose runs fail forever against no
   * bucket — `destination_id` is `notNull` for exactly that reason. The FKs
   * stay `cascade` and this check is the gate, which also keeps the delete
   * migration-free.
   *
   * **One transaction, with the destination row locked `FOR UPDATE` before the
   * check.** A schedule created between a check and a separate delete would be
   * cascaded away silently — the very outcome this refuses. Inserting a row
   * that references `destination` takes `FOR KEY SHARE` on it, which conflicts
   * with `FOR UPDATE`, so a concurrent create either committed before the lock
   * (and the check, a fresh statement under READ COMMITTED, sees it) or waits
   * for this transaction and then finds the destination gone.
   */
  async remove(
    ctx: PermissionCtx,
    destinationId: string,
  ): Promise<SanitizedDestination> {
    const current = await this.findOneWithCredentials(ctx, destinationId);
    const removed = await this.db.transaction(async (tx) => {
      await tx
        .select({ destinationId: destination.destinationId })
        .from(destination)
        .where(eq(destination.destinationId, current.destinationId))
        .for('update');

      const inUse = await destinationInUseMessage(
        tx,
        ctx.session.activeOrganizationId,
        current,
      );
      if (inUse) throw new ConflictException(inUse);

      const [row] = await tx
        .delete(destination)
        .where(eq(destination.destinationId, current.destinationId))
        .returning();
      return row;
    });
    return stripSecret(removed);
  }

  /**
   * A cheap `rclone ls` probe against the bucket with tight retry/timeout
   * flags, run on the given server or the local docker host. Probe failure
   * surfaces as a 400 with rclone's message — the diagnosis intact, the
   * credentials taken back out.
   *
   * The `ctx` was once `void ctx`: nothing here is org-scoped — the
   * credentials and the bucket come off the payload and belong to whoever is
   * typing — *except* `serverId`, which names a machine on this instance and
   * decides where an SSH session opens and an rclone process runs. Unscoped,
   * that made this route the cheapest way for any authenticated caller to run a
   * command on another organization's Server. `listObjects` next door and
   * `GET /backups/files` both already scoped it; these two probes were the pair
   * that did not.
   */
  async testConnection(
    ctx: PermissionCtx,
    data: TestConnectionDto,
  ): Promise<void> {
    const { serverId, bucket, ...credentials } = data;
    if (!serverId) this.instanceMode.refusePlatformHost('checks');
    await checkServerAccess(this.db, ctx, serverId);
    return this.probeBucket(
      { ...credentials, provider: data.provider ?? null },
      bucket,
      serverId ?? null,
    );
  }

  /**
   * The same probe, against a destination that is already saved.
   *
   * `testConnection` takes the whole payload, which is right for a create — a
   * bucket you have not proved you can write to is one you find out about
   * during a restore. It is no use afterwards: the secret is stripped on every
   * read, so the console cannot send it back, and a bucket whose policy changed
   * under it could not be re-checked at all. This loads the row's decrypted
   * credentials server-side — the lookup a scheduled backup run already makes —
   * and probes with those.
   *
   * `serverId` stays a body field rather than coming off the row: it is not a
   * property of the destination but of *where you are asking from*, and
   * reachability from the platform host and from a particular Server are
   * different questions.
   *
   * Which is exactly why it needs its own check. Resolving the
   * destination org-scoped says nothing about the Server, because the two are
   * unrelated fields of the request: a caller who owns the destination could
   * name any Server id on the instance and have rclone run on it. Two lookups
   * for two ids.
   */
  async testSavedConnection(
    ctx: PermissionCtx,
    destinationId: string,
    data: TestSavedConnectionDto,
  ): Promise<void> {
    if (!data.serverId) this.instanceMode.refusePlatformHost('checks');
    const found = await this.findOneWithCredentials(ctx, destinationId);
    await checkServerAccess(this.db, ctx, data.serverId);
    return this.probeBucket(found, found.bucket, data.serverId ?? null);
  }

  /**
   * The shared `rclone ls` probe.
   *
   * Through `execRclone` like every other route: the credentials
   * travel in rclone's environment, not in argv, because this refusal is meant to
   * be read by a person and a command line gets echoed back in the failure
   * message (and sits in the host's process table meanwhile) — and they are
   * masked out of what it throws on top of that, which is what makes the
   * id-taking route safe, since its caller never held the secret and so cannot
   * take it back out of the refusal itself.
   *
   * The masking stays on the sentence built here too: this route answers rather
   * than rethrows, so what a person reads is a *new* exception whose message this
   * line composes — the masking `execRclone` did was on the error being
   * discarded.
   *
   * Through `rcloneFailureMessage` rather than `error.message`, and
   * the reason is the `serverId` this takes. F-44 credited this route with
   * answering well, but it was measured with **no** server: on the local path
   * Node's `exec` folds stderr into `err.message`, so rclone's diagnosis is in
   * the message by accident. Over SSH there is no such folding —
   * `RemoteExecService` builds `Remote command failed with exit code 1` and the
   * diagnosis lives only in `stderr` — so a Server-scoped probe against a wrong
   * secret answered that sentence and nothing else.
   *
   * **Audited with the listing rule, and this is the other route that reaches the bucket
   * with Organization-wide credentials.** It does not need
   * {@link listObjects}' entitlement filter, and the reasons are properties
   * rather than assurances:
   *
   * - **Nothing of the bucket's contents comes back.** This is
   *   `Promise<void>`, both callers are `@HttpCode(204)`, and the route's own e2e
   *   case asserts the body is `''` — so the `rclone ls` walk is a yes/no
   *   answer about reachability and never a key listing. The disclosure in
   *   question is the object *names*, and no name survives this function.
   * - **The action is narrower, not wider.** Both callers ask for
   *   `destination: ['create']`, where the listing asks `['read']`.
   * - **`serverId` is org-scoped on both**, which it once was not — the
   *   `void ctx` that made this route the cheapest way to run a command on
   *   another Organization's Server. `listObjects` scoped it first and these
   *   two were the pair that did not; re-read at the source, both
   *   now call `checkServerAccess` and `listObjects` still does.
   *
   * What the audit did *not* clear is narrow and is filed rather than fixed
   * here: the walk is unbounded, so on a bucket holding a year of nightly
   * backups a yes/no question pages the whole key space, and if rclone names an
   * individual unreadable object on stderr then `rcloneFailureMessage` puts that
   * one key in a `destination: ['create']` caller's 400. `--max-depth 1` answers
   * the same question and is the shape of the fix.
   */
  private async probeBucket(
    s3: S3Credentials,
    bucket: string,
    serverId: string | null,
  ): Promise<void> {
    const command = `rclone ls ${boundedRcloneFlags({ idle: '10s' })} ":s3:${bucket}"`;
    try {
      await execRclone(this.remoteExec, command, {
        destination: s3,
        serverId,
        platformHost: this.instanceMode,
      });
    } catch (error) {
      // Masked a second time on purpose: `rcloneFailureMessage` reads fields
      // `execRclone` already masked, but what leaves here is a *new* exception,
      // and the belt-and-braces pass is on the sentence this composes.
      throw new BadRequestException(
        redactS3Credentials(
          rcloneFailureMessage(error, 'Error connecting to bucket'),
          s3,
        ),
      );
    }
  }

  /**
   * The objects a destination holds under a prefix.
   *
   * A volume backup writes `<appName>/<prefix>/<timestamp>.tar`, so the keys
   * are derivable but not enumerable: `keepLatestCount` deletes the older ones
   * and nothing outside the bucket knows which survived. The prune path
   * (`buildPruneCommand`) already lists them to decide what to delete; this is
   * that listing, answered to a caller instead of piped into `rclone delete`,
   * and it is what lets a restore *pick* a tarball rather than have one typed
   * from memory.
   *
   * Recursive, because the prefix a caller knows is the Application's
   * directory and the tarballs sit one level down inside the backup's own
   * prefix. Newest first: which tarball is the newest is the decision a
   * restore is actually making.
   *
   * Credentials travel in rclone's environment, not in argv — the same reason
   * testConnection does it: a failed listing is shown to a person, and
   * whatever echoes the command back must not echo the secret with it.
   *
   * **Bounded to the prefixes the caller is entitled to.** A
   * Destination's bucket is Organization-wide — the premise both restore rules
   * are built on — so this route used to hand every Service's tarball and dump
   * keys to any caller holding `destination: ['read']`, and the key *names* are
   * the disclosure: `{appName}/{prefix}/{timestamp}` enumerates other Services'
   * `appName`s, their backup cadence and their retention. Once the restore rules
   * bounded the acting half it was also offering rows `POST /volume-backups/restore`
   * and `POST /backups/restore` answer 403 to, which is the managed-listing property for
   * containers stated one resource over: the same definition decides which rows
   * a listing may show and which objects a restore may reach.
   *
   * The rule is `refusedBucketPrefixes` in `common/bucket-prefix-owners.ts`, the
   * one `GET /backups/files` already uses — a *filter* rather than a refusal, and
   * a prefix no Service claims stays listed, both argued there. Which is why the
   * bound is that function and not a `checkServiceAccess` per row: this is the
   * *volume* restore's picker over the same bucket as the database restore's, and
   * two pickers onto one bucket that disagreed would be the same disclosure with
   * an extra step.
   *
   * **Who this actually changes anything for, since the issue's "anyone with
   * `destination: ['read']`" reads wider than it is.** `destination` is in
   * `enterpriseOnlyResources` and `memberRole` holds `destination: []`, so a
   * static Member is refused this route at the guard; owner and admin take
   * `checkPermission`'s privileged bypass and are unfiltered by design. The shape
   * that both reaches here and is bounded is a licensed custom role granted
   * `destination: ['read']`, which is what
   * `destination-object-authorization.e2e-spec.ts` drives.
   */
  async listObjects(
    ctx: PermissionCtx,
    destinationId: string,
    query: ListDestinationObjectsDto,
  ): Promise<DestinationObject[]> {
    if (!query.serverId) this.instanceMode.refusePlatformHost('checks');
    const found = await this.findOneWithCredentials(ctx, destinationId);
    // The destination is org-scoped by the read above; the Server the caller
    // names is not, and it decides which machine runs rclone with that
    // destination's credentials. `GET /backups/files` — the sibling
    // already honouring `serverId` — scopes it, and the consistency that
    // issue asked for is with that, not only with the parameter being read.
    await checkServerAccess(this.db, ctx, query.serverId);
    // The same guard the two backup modules put on their identical column
    // and here it is what keeps the filter below well-posed: the
    // segment the entitlement decision is made on and the path rclone lists have
    // to be the same thing, and `normalizeS3Path` strips leading and trailing
    // slashes and nothing else. **Not because a `..` reaches a sibling's objects
    // on the S3 side** — it was measured that it does not, twice over: rclone's S3
    // backend encodes such a segment to fullwidth full stops, and even with that
    // encoder off an S3 key is an opaque byte string S3 performs no resolution
    // on. The reasons that survive scrutiny are consistency with
    // `VolumeBackupsService.checkTarballAccess`' identical guard and not
    // depending on an rclone default — now pinned as `RCLONE_S3_ENCODING` in
    // `getS3CredentialsEnv` — and `bucketKeySegments` carries them.
    bucketKeySegments(query.prefix ?? '');
    const prefix = normalizeS3Path(query.prefix ?? '');
    const path = `:s3:${found.bucket}${prefix ? `/${prefix}` : ''}`;
    const command = `rclone lsjson ${boundedRcloneFlags({ idle: '30s' })} --recursive --no-mimetype "${path}"`;

    let stdout: string;
    try {
      ({ stdout } = await execRclone(this.remoteExec, command, {
        destination: found,
        // Read from wherever the caller asks, the way probeBucket and
        // `GET /backups/files` already are. A bucket reachable only from
        // a Server is otherwise indistinguishable from an empty one here, and
        // the restore this listing feeds runs on that Server. The id is
        // org-scoped first — see checkServerAccess above.
        serverId: query.serverId ?? null,
        platformHost: this.instanceMode,
      }));
    } catch (error) {
      // Not `error.message`: this route reads from whichever Server the caller
      // named, and over SSH the message is the flat `Remote command failed with
      // exit code 1` with rclone's reason on stderr. Masked again on the
      // way out for the same reason probeBucket is — a new exception.
      throw new BadRequestException(
        redactS3Credentials(
          rcloneFailureMessage(error, 'Error listing the bucket'),
          found,
        ),
      );
    }

    let entries: RcloneEntry[];
    try {
      entries = JSON.parse(stdout) as RcloneEntry[];
    } catch {
      throw new BadRequestException('Failed to parse the destination listing');
    }

    const objects = entries
      .filter((entry) => !entry.IsDir)
      .map((entry) => ({
        key: `${prefix}${entry.Path}`,
        size: entry.Size,
        lastModified: entry.ModTime,
      }))
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified));

    // Before `MAX_OBJECTS`, not after, and for the reason `listBackupFiles`
    // states at its own filter: the entitlement question is about which keys
    // exist for this caller at all, so running it second would let the cap be
    // filled by rows that are then dropped — a picker that answers fewer than
    // two hundred of its own Service's tarballs because somebody else's newer
    // ones took the slots.
    const visible = await this.visibleObjects(ctx, objects);
    return visible.slice(0, MAX_OBJECTS);
  }

  /**
   * `refusedBucketPrefixes` applied to this listing's row shape.
   *
   * The rule and every alternative it rejects live in
   * `common/bucket-prefix-owners.ts` and are not restated here (§1.4). What is
   * this module's own is which part of a key is the bucket's top-level prefix:
   * the **whole** key's leading segment, `query.prefix` included — the route puts
   * the browsed prefix back onto every `Path` rclone answers with, so a caller
   * browsing `ledger-db/daily` is decided against `ledger-db` exactly as one
   * browsing the bucket root is. A key with no `/` at all is its own leading
   * segment, which no Service claims, and stays listed.
   */
  private async visibleObjects(
    ctx: PermissionCtx,
    objects: DestinationObject[],
  ): Promise<DestinationObject[]> {
    const prefixOf = (object: DestinationObject): string =>
      object.key.split('/')[0];
    const prefixes = [...new Set(objects.map(prefixOf))].filter(
      (segment) => segment.length > 0,
    );
    const refused = await refusedBucketPrefixes(
      this.db,
      this.permissions,
      ctx,
      prefixes.map((segment) => ({
        prefix: segment,
        candidates: bucketPrefixCandidates(segment),
      })),
    );
    return refused.size === 0
      ? objects
      : objects.filter((object) => !refused.has(prefixOf(object)));
  }

  /**
   * findOneWithCredentials without the org scoping, for scheduled (system)
   * backup runs that execute with no user session. The backup row's
   * destination was org-checked when the backup was created or updated.
   */
  async findForScheduledRun(destinationId: string): Promise<Destination> {
    const [found] = await this.db
      .select()
      .from(destination)
      .where(eq(destination.destinationId, destinationId))
      .limit(1);
    if (!found) throw new NotFoundException('Destination not found');
    return found;
  }

  /**
   * The full row including the decrypted secret access key, for internal use
   * (rclone credentials for backups). Never returned from a controller.
   */
  async findOneWithCredentials(
    ctx: PermissionCtx,
    destinationId: string,
  ): Promise<Destination> {
    const [found] = await this.db
      .select()
      .from(destination)
      .where(
        and(
          eq(destination.destinationId, destinationId),
          eq(destination.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Destination not found');
    return found;
  }
}
