import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { beginDeleting } from '../bought-servers/bought-server-deletion.service';
import { BoughtServerStages } from '../bought-servers/bought-server-stages.service';
import { withPurchase } from '../bought-servers/server-readiness';
import { boughtServer } from '../bought-servers/bought-server.schema';
import { storageCommand } from '../bought-servers/storage';
import { BillingService } from '../cloud/billing/billing.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  bucket,
  certificate,
  compose,
  environment,
  forwardAuthSettings,
  libsql,
  mariadb,
  mongo,
  mysql,
  postgres,
  project,
  redis,
  schedule,
  server,
} from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  isTransportFailure,
  rethrowIfHostUnreachable,
} from '../docker-ops/host-reachability';
import { ExecError } from '../remote/exec-error';
import { isHostKeyChanged } from '../remote/host-key';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SshKeysService } from '../ssh-keys/ssh-keys.service';
import { serverAuditCommand } from './server-audit';
import type { ServerAuditResult } from './server-audit';
import { serverSetupCommand } from './server-setup';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../common/config/cloudgate-directory';
import { carriesRequestMetrics } from '../common/config/request-metrics';
import type { CreateServerDto, UpdateServerDto } from './dto/server.dto';
import {
  isServerAddressRefusal,
  ServerAddressGuard,
} from './server-address-guard';

/**
 * How many rows of one category a refusal names before it starts counting.
 *
 * **Per category, not across the combined list — and that is the decision
 * rather than a deviation.** The triage asked for one budget
 * across both lists; this shipped one budget per list with the reason in a
 * comment, and a later review raised the gap. A shared budget was re-examined
 * and rejected: `remove` enumerates Services before configuration, so ten
 * Services would spend the whole budget and `nameCategory` would emit `12
 * configuration entries (, and 12 more)` — an empty slice behind a stray comma,
 * naming nothing, in exactly the case the acceptance criterion ("names both
 * categories") exists for. The count is printed before the slice either way, so
 * the number an operator has to act on never depends on the budget; only the
 * names do. The worst case is 20 names rather than 10, still well short of the
 * unreadable 40-service message the cap was written against.
 */
export const MAX_NAMED_PER_CATEGORY = 10;

/**
 * One clause of a delete refusal — `2 services (application "Web App",
 * postgres "Orders DB")` — or `null` when the category is empty so the caller
 * can join only the clauses that have something to say.
 *
 * Parenthesised rather than the earlier `services: application "Web App"`,
 * because two categories in one sentence made two colons, and the second read
 * as if it were still listing Services.
 */
export function nameCategory(
  found: string[],
  one: string,
  many: string,
): string | null {
  if (found.length === 0) return null;
  // Long lists are truncated rather than dropped: the count is the part an
  // operator needs, and a 40-service message is unreadable in a toast.
  const named = found.slice(0, MAX_NAMED_PER_CATEGORY).join(', ');
  const rest = found.length - MAX_NAMED_PER_CATEGORY;
  return (
    `${found.length} ${found.length === 1 ? one : many} ` +
    `(${named}${rest > 0 ? `, and ${rest} more` : ''})`
  );
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    private readonly billing: BillingService,
    private readonly sshKeys: SshKeysService,
    private readonly addressGuard: ServerAddressGuard,
    // Forward: the stages start a first Setup run through ServerSetupRuns,
    // which provisions through this service.
    @Inject(forwardRef(() => BoughtServerStages))
    private readonly boughtServers: BoughtServerStages,
  ) {}

  /**
   * The `sshKeyId` a caller supplied, once it is known to name a key in the
   * caller's own organization — and the id is taken back off the row the
   * lookup returned rather than off the body, so what lands in the column is
   * the row that was checked.
   *
   * `organizationId` was always pinned from the session here; the hole was the
   * *other* id in the same body. `server.ssh_key_id → ssh_key` requires only
   * that the key exist, so an owner of organization A could create a Server in
   * their own organization pointing at organization B's key, and every
   * connection to that Server then authenticated with B's private key. Not the
   * plaintext — the *use* of it, which is a signing oracle for a credential
   * the caller was never granted, against any host that trusts it.
   *
   * `SshKeysService.findOne` rather than a query of our own, per §1.4 and
   * the lesson about five copies of one ownership lookup drifting apart: it
   * already runs the `sshKeyId = ? AND organizationId = ?` select and already
   * raises `'SSH key not found'` whichever predicate misses, so a key in
   * another organization is refused byte-identically to an id that names
   * nothing anywhere (§2.2 / ADR-0008) and the fleet is not enumerable by the
   * difference. It also answers with the *sanitized* row, so resolving an id
   * here never brings a private key into this service.
   *
   * `ServerConnectionProvider`'s join carries the same organization predicate
   * independently. That is not redundancy: this check protects the column, and
   * that one protects the key at the moment it is used, from rows this method
   * never saw.
   */
  private async ownedSshKeyId(
    ctx: PermissionCtx,
    sshKeyId: string,
  ): Promise<string> {
    const key = await this.sshKeys.findOne(ctx, sshKeyId);
    return key.sshKeyId;
  }

  /** Creates a Server, scoped to the session's active organization. */
  async create(ctx: PermissionCtx, data: CreateServerDto) {
    // Hosted: refuses with "choose a plan" when the organization has none, and
    // points at the Add-on once its Servers fill the allowance. Self-hosted
    // this is a no-op, so a self-hosted instance is unmetered.
    await this.billing.assertRoomFor(
      ctx.session.activeOrganizationId,
      'servers',
    );

    // `sshKeyId` is destructured out rather than left to `...data`, and
    // resolved on its own line rather than inside `.values({…})`, so there is
    // no reading of this in which an unchecked foreign key reaches the insert.
    const { sshKeyId, ...fields } = data;
    const ownedKeyId = await this.ownedSshKeyId(ctx, sshKeyId);
    // Hosted: an address on loopback, link-local, a private range or the
    // box's own is refused. Checked again at every connect.
    await this.addressGuard.addressToDial(fields.ipAddress);

    const [created] = await this.db
      .insert(server)
      .values({
        ...fields,
        sshKeyId: ownedKeyId,
        organizationId: ctx.session.activeOrganizationId,
      })
      .returning();
    return created;
  }

  /** The organization's servers, newest first. */
  async list(ctx: PermissionCtx) {
    return this.db
      .select()
      .from(server)
      .where(eq(server.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(server.createdAt));
  }

  /**
   * `list` and `findOne` as `GET /servers` and `GET /servers/:id` answer
   * them: each row with `boughtServer`, its Bought Server's stage or null,
   * so the console can grey out one that is not Ready yet.
   */
  async listWithPurchase(ctx: PermissionCtx) {
    return withPurchase(this.db, await this.list(ctx));
  }

  async findOneWithPurchase(ctx: PermissionCtx, serverId: string) {
    const [row] = await withPurchase(this.db, [
      await this.findOne(ctx, serverId),
    ]);
    return row;
  }

  /** One server — a server is only visible inside its organization. */
  async findOne(ctx: PermissionCtx, serverId: string) {
    const [found] = await this.db
      .select()
      .from(server)
      .where(
        and(
          eq(server.serverId, serverId),
          eq(server.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Server not found');
    return found;
  }

  /**
   * Updates a Server, org-scoped through findOne — and with the
   * `sshKeyId` in the body scoped the same way.
   *
   * `findOne` only ever scoped the Server row. `UpdateServerDto`'s optional
   * `sshKeyId` carried the identical hole `create` did, one PATCH away from
   * the same outcome on a Server that was created legitimately, so both ids
   * are now asserted as a pair before either is written. `sshKeyId` is
   * destructured out of the `set` for the reason it is destructured out of the
   * insert.
   */
  async update(ctx: PermissionCtx, serverId: string, data: UpdateServerDto) {
    const current = await this.findOne(ctx, serverId);
    // An absent `sshKeyId` means "leave the key alone": nothing is resolved
    // and nothing is written for it, so a rename does not have to name a key.
    const { sshKeyId, ...fields } = data;
    if (fields.ipAddress !== undefined) {
      await this.addressGuard.addressToDial(fields.ipAddress);
    }
    const keyed =
      sshKeyId === undefined
        ? fields
        : { ...fields, sshKeyId: await this.ownedSshKeyId(ctx, sshKeyId) };
    // A new address is a different machine as far as SSH can tell, and the
    // operator changing it is the deliberate act Forget host key otherwise
    // is: its next connect records the host key afresh (ADR-0074).
    const moved =
      (fields.ipAddress !== undefined &&
        fields.ipAddress !== current.ipAddress) ||
      (fields.port !== undefined && fields.port !== current.port);
    const values = moved ? { ...keyed, hostKeyFingerprint: null } : keyed;

    const [updated] = await this.db
      .update(server)
      .set(values)
      .where(eq(server.serverId, current.serverId))
      .returning();
    return updated;
  }

  /**
   * Forget the host key recorded for this Server, so the next connect records
   * the one it presents then (ADR-0074). The deliberate answer to a refused,
   * changed host key after the Server was reinstalled; org-scoped through
   * findOne, and `server:create` like every other change to the row.
   */
  async forgetHostKey(ctx: PermissionCtx, serverId: string) {
    const current = await this.findOne(ctx, serverId);
    const [updated] = await this.db
      .update(server)
      .set({ hostKeyFingerprint: null })
      .where(eq(server.serverId, current.serverId))
      .returning();
    this.logger.log(
      `Server ${current.serverId}: host key ${current.hostKeyFingerprint ?? '(none recorded)'} forgotten by user ${ctx.user.id}`,
    );
    return updated;
  }

  /**
   * Start Maintenance on the Server (spec #1420): records when it began and
   * who started it, after which every entry that would start containers on
   * it is refused (`server-maintenance.ts`). Org-scoped through findOne. A
   * Server already in maintenance is refused 409, and keeps when it began.
   */
  async startMaintenance(ctx: PermissionCtx, serverId: string) {
    const current = await this.findOne(ctx, serverId);
    const [updated] = await this.db
      .update(server)
      .set({
        maintenanceSince: new Date().toISOString(),
        maintenanceStartedBy: ctx.user.id,
      })
      .where(
        and(
          eq(server.serverId, current.serverId),
          isNull(server.maintenanceSince),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException(`${current.name} is already in maintenance`);
    }
    return updated;
  }

  /**
   * End the Server's Maintenance (spec #1420): clears when it began and who
   * started it, so new work may start on it again. Org-scoped through
   * findOne. A Server not in maintenance is refused 409.
   */
  async endMaintenance(ctx: PermissionCtx, serverId: string) {
    const current = await this.findOne(ctx, serverId);
    const [updated] = await this.db
      .update(server)
      .set({ maintenanceSince: null, maintenanceStartedBy: null })
      .where(
        and(
          eq(server.serverId, current.serverId),
          isNotNull(server.maintenanceSince),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException(`${current.name} is not in maintenance`);
    }
    return updated;
  }

  /**
   * Connectivity probe: run a trivial command over SSH. Any SSH/exec failure
   * becomes a 400 with the exec message, except a changed host key, which
   * keeps its 409 and code so the console can offer Forget host key.
   */
  async validate(ctx: PermissionCtx, serverId: string) {
    const current = await this.findOne(ctx, serverId);
    try {
      await this.remoteExec.execAsyncRemote(current.serverId, 'echo ok');
    } catch (error) {
      // A refused address keeps its code, so the console can tell it
      // from a Server that could not be reached.
      if (isServerAddressRefusal(error) || isHostKeyChanged(error)) {
        await this.recordReach(current.serverId, (error as Error).message);
        throw error;
      }
      const message =
        error instanceof Object && 'message' in error
          ? String((error as Error).message)
          : `Error validating server: ${String(error)}`;
      await this.recordReach(current.serverId, message);
      throw new BadRequestException(message);
    }
    await this.recordReach(current.serverId, null);
    return { status: 'ok' as const };
  }

  /**
   * Store the outcome of an attempt to reach this Server: `null` for reached,
   * otherwise the refusal the caller was shown.
   *
   * Every Server tab read its own request's result and dropped it on
   * navigation, so a failed Check now came back as "Nothing has been checked
   * yet" beside an audit card still saying "could not reach". One stored
   * answer, written by every SSH attempt the console makes, is what the tabs
   * read instead. A failed write is logged and swallowed: the attempt itself
   * is the answer the caller asked for, and bookkeeping must not replace it.
   */
  private async recordReach(
    serverId: string,
    failure: string | null,
  ): Promise<void> {
    await this.recordOutcome(serverId, 'reach', {
      reachCheckedAt: new Date().toISOString(),
      reachOk: failure === null,
      reachMessage: failure,
    });
  }

  /** The setup half of {@link recordReach}: how the last run ended. */
  private async recordSetup(
    serverId: string,
    failure: string | null,
  ): Promise<void> {
    await this.recordOutcome(serverId, 'setup', {
      setupRanAt: new Date().toISOString(),
      setupOk: failure === null,
      setupMessage: failure,
    });
  }

  private async recordOutcome(
    serverId: string,
    what: 'reach' | 'setup',
    values: Partial<typeof server.$inferInsert>,
  ): Promise<void> {
    try {
      await this.db
        .update(server)
        .set(values)
        .where(eq(server.serverId, serverId));
    } catch (error) {
      this.logger.warn(
        `Server ${serverId}: could not store the ${what} outcome: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Runs the readiness script and parses its JSON report of
   * docker/swarm/network/privilege state.
   *
   * **A session that never ran the script is a refusal the console can word,
   * not a 500.** This awaited `execAsyncRemote` bare, so an unreachable
   * host, a key the host does not accept and a key that cannot be parsed all
   * reached the filter as `500 Internal server error`, journaled at error, and
   * the Infrastructure, Overview and Access cards told the operator "the
   * backend hit an error … so nothing changed" about a read. The key's two
   * failures are checked first: both are transport failures to
   * `isTransportFailure` too, and a key problem told as "could not be reached"
   * sends the operator to the network when the fix is on the Access tab.
   */
  async audit(
    ctx: PermissionCtx,
    serverId: string,
  ): Promise<ServerAuditResult> {
    const current = await this.findOne(ctx, serverId);
    let stdout: string;
    try {
      ({ stdout } = await this.remoteExec.execAsyncRemote(
        current.serverId,
        serverAuditCommand(),
      ));
    } catch (error) {
      // Stored only for the two refusals that mean "not reached"; anything
      // else ran on the Server, which is a reach, but says nothing new.
      try {
        if (isHostKeyChanged(error)) throw error;
        await this.rethrowIfKeyRefused(ctx, current, error);
        rethrowIfHostUnreachable(this.logger, current.serverId, error);
      } catch (refusal) {
        await this.recordReach(
          current.serverId,
          refusal instanceof Error ? refusal.message : String(refusal),
        );
        throw refusal;
      }
      throw error;
    }
    await this.recordReach(current.serverId, null);
    try {
      return JSON.parse(stdout.trim()) as ServerAuditResult;
    } catch (error) {
      throw new BadRequestException(
        `Failed to parse audit output: ${error instanceof Object && 'message' in error ? String((error as Error).message) : String(error)}`,
      );
    }
  }

  /**
   * A 400 naming the Server's key when the session failed on the key itself —
   * the same status `validate()` answers with for these, so "Check now" and the
   * audit's cards agree on what kind of failure it is.
   *
   * Two shapes, told apart by what `RemoteExecService` and `ssh2` actually
   * produce rather than by our own prose:
   *
   * - **Not accepted.** An `ExecError` off the client's `'error'` event whose
   *   `ssh2` error carries `level: 'client-authentication'` — the field the
   *   exec service itself branches on to write its `Authentication failed`
   *   message.
   * - **Not readable.** `ssh2`'s `connect()` throws `Cannot parse privateKey: …`
   *   synchronously for a stored private half that is not a key (stored
   *   garbage), inside `execAsyncRemote`'s promise executor, so it arrives as a
   *   plain `Error` with no structural marker at all. Its prefix is `ssh2`'s
   *   wording, pinned by the lockfile, not a §2.5 sentence of ours.
   *
   * Rejected: making `RemoteExecService` wrap the parse failure in an
   * `ExecError`. Every docker and swarm route would then read it as
   * `isTransportFailure` and answer "This Server could not be reached" for a
   * key problem — the misattribution this method exists to avoid, spread wider.
   */
  private async rethrowIfKeyRefused(
    ctx: PermissionCtx,
    current: { serverId: string; username: string; sshKeyId: string | null },
    error: unknown,
  ): Promise<void> {
    const notAccepted =
      error instanceof ExecError &&
      (error.originalError as { level?: unknown } | undefined)?.level ===
        'client-authentication';
    const notReadable =
      !(error instanceof ExecError) &&
      error instanceof Error &&
      error.message.startsWith('Cannot parse privateKey');
    if (!notAccepted && !notReadable) return;

    this.logger.warn(
      `Server ${current.serverId} refused its SSH key: ${error.message}`,
    );
    const key = await this.keyName(ctx, current.sshKeyId);
    throw new BadRequestException(
      notAccepted
        ? `${key} was not accepted by this Server. Add its public half to ~/.ssh/authorized_keys for ${current.username} on the Server, or choose another key on the Access tab`
        : `${key} could not be read: its private half is not a key Cloudgate can use. Choose another key on the Access tab`,
    );
  }

  /** `The SSH key "<name>"`, or a phrase that needs no lookup when it fails. */
  private async keyName(
    ctx: PermissionCtx,
    sshKeyId: string | null,
  ): Promise<string> {
    if (sshKeyId === null) return "This Server's SSH key";
    try {
      const key = await this.sshKeys.findOne(ctx, sshKeyId);
      return `The SSH key "${key.name}"`;
    } catch {
      return "This Server's SSH key";
    }
  }

  /**
   * Provisions the host with the default script (Docker → Swarm → network →
   * directory → Traefik), or the server's stored custom command when one is
   * set. A Bought Server's extra storage is mounted once that finishes, and
   * its filesystem grown to fill it (`bought-servers/storage.ts`).
   */
  async setup(
    ctx: PermissionCtx,
    serverId: string,
    onData?: (data: string) => void,
  ) {
    const current = await this.findOne(ctx, serverId);
    const command = current.command || serverSetupCommand();
    try {
      await this.remoteExec.execAsyncRemote(current.serverId, command, onData);
      const storage = await this.extraStorageOf(current.serverId);
      if (storage) {
        await this.remoteExec.execAsyncRemote(
          current.serverId,
          storageCommand(storage.volumeId, storage.sizeGb),
          onData,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A run that never reached a shell is also the newest reach answer; one
      // that ran and failed reached the Server and leaves that answer alone.
      if (isTransportFailure(error)) {
        await this.recordReach(current.serverId, message);
      }
      await this.recordSetup(current.serverId, message);
      throw error;
    }
    await this.recordReach(current.serverId, null);
    await this.recordSetup(current.serverId, null);
    await this.recordRequestMetrics(current.serverId);
    return { status: 'ok' as const };
  }

  /** The extra storage of the Bought Server behind this Server, once its Volume is made; null for any other Server. */
  private async extraStorageOf(
    serverId: string,
  ): Promise<{ volumeId: number; sizeGb: number } | null> {
    const [row] = await this.db
      .select({
        volumeId: boughtServer.providerVolumeId,
        sizeGb: boughtServer.storageGb,
      })
      .from(boughtServer)
      .where(eq(boughtServer.serverId, serverId))
      .limit(1);
    return row?.volumeId != null && row.sizeGb != null
      ? { volumeId: row.volumeId, sizeGb: row.sizeGb }
      : null;
  }

  /**
   * Sets `requestMetricsEnabled` from the traefik.yml the setup run left on
   * the Server (ADR-0027).
   *
   * Read back rather than assumed, because the script writes that file only
   * when there is none: a Server that already had one — provisioned before
   * ADR-0027, or by an operator's custom command — keeps what it had, and its
   * state has to say so rather than claim the block the script would have
   * written. A read that fails leaves the stored state alone and is logged:
   * the setup itself succeeded, and failing it over a bookkeeping read would
   * tell the operator the wrong thing about their machine.
   */
  private async recordRequestMetrics(serverId: string): Promise<void> {
    try {
      const { stdout } = await this.remoteExec.execRemote(serverId, [
        'cat',
        `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml`,
      ]);
      await this.db
        .update(server)
        .set({ requestMetricsEnabled: carriesRequestMetrics(stdout) })
        .where(eq(server.serverId, serverId));
    } catch (error) {
      this.logger.warn(
        `Server ${serverId}: could not read traefik.yml back after setup, request-metrics state left as it was: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The Services this Server carries, as `"<kind> <name>"`, in the order the
   * console lists a Project's services.
   *
   * These eight are the **Services** in `CONTEXT.md`'s sense — an Application,
   * a Compose stack or a Database — which is why they are counted apart from
   * `carriedConfiguration` rather than flattened into one list. See the FK
   * accounting on `carriedConfiguration` for the other five cascades and for
   * the one that is deliberately absent.
   */
  private async carriedServices(serverId: string): Promise<string[]> {
    const tables = [
      ['application', application],
      ['compose', compose],
      ['postgres', postgres],
      ['mysql', mysql],
      ['mariadb', mariadb],
      ['mongo', mongo],
      ['redis', redis],
      ['libsql', libsql],
      ['bucket', bucket],
    ] as const;

    const found = await Promise.all(
      tables.map(async ([kind, table]) => {
        const rows = await this.db
          .select({ name: table.name })
          .from(table)
          .where(eq(table.serverId, serverId));
        return rows.map((row) => `${kind} "${row.name}"`);
      }),
    );
    return found.flat();
  }

  /**
   * The configuration this Server carries that is *not* a Service: a stored
   * certificate, a scheduled job, a forward-auth rule.
   *
   * **Why this exists as a second list rather than three more rows in the
   * first.** The original guard reasoned that "every service table's `serverId`
   * cascades", read the eight service tables, and stopped — but thirteen
   * foreign keys onto `server` are `on delete cascade`, and the five it missed
   * split cleanly in two:
   *
   * - `certificate.serverId`, `schedule.serverId` and
   *   `forwardAuthSettings.serverId` are **configuration**. A certificate whose
   *   PEM material Traefik is serving on that host, a cron job that runs there,
   *   and the row naming the domain that host's oauth2-proxy answers on: each
   *   is a thing an operator authored, none of them is reconstructible, and
   *   before this a Server carrying only these produced no 409, named nothing
   *   and was not mentioned in the dialog. So they refuse the delete too.
   * - `containerMetric.serverId` and `serverMetric.serverId` are **samples**.
   *   Losing them is defensible and is stated here rather than left implied:
   *   they are a rolling window of measurements that the next poll begins
   *   refilling, nobody authored them, and a Server whose only trace is
   *   yesterday's CPU readings must stay deletable — a guard that counted them
   *   would refuse every monitored Server forever.
   *
   * And `application.buildServerId` stays out of both lists: it is `set null`,
   * so an Application that merely *builds* on this machine survives the delete
   * with no build server, which is the outcome that column was written for
   * (proven live in the V03 verification run).
   *
   * **The two lists are reported as two categories, not as one.**
   * `CONTEXT.md` defines a Service as an Application, Compose stack or
   * Database, and none of these three is one; calling a certificate a Service
   * in the refusal would teach the glossary's *Avoid* column to an operator in
   * the one message they are guaranteed to read.
   *
   * **`forwardAuthSettings` is counted rather than named, and that is the
   * triage's instruction rather than an omission.** Its `serverId` is
   * `.unique()`, so it is a per-server singleton with no `name` column — naming
   * it by `authDomain` was tried and rejected on review: that column is the
   * proxy's own configuration, not an identifier the row has, and borrowing it
   * invents a name for an entity that does not have one. There is at most one
   * per Server, so "1 configuration entry (forward-auth)" already tells an
   * operator everything the row can tell them.
   */
  private async carriedConfiguration(serverId: string): Promise<string[]> {
    const named = [
      ['certificate', certificate, certificate.name],
      ['schedule', schedule, schedule.name],
    ] as const;

    const found = await Promise.all(
      named.map(async ([kind, table, label]) => {
        const rows = await this.db
          .select({ label })
          .from(table)
          .where(eq(table.serverId, serverId));
        return rows.map((row) => `${kind} "${row.label}"`);
      }),
    );

    // Counted, not named — see the docblock. `.unique()` on its serverId means
    // this is 0 or 1 rows, so the count is the whole fact.
    const forwardAuth = await this.db
      .select({ serverId: forwardAuthSettings.serverId })
      .from(forwardAuthSettings)
      .where(eq(forwardAuthSettings.serverId, serverId));

    return [...found.flat(), ...forwardAuth.map(() => 'forward-auth')];
  }

  /**
   * Every Environment whose Deploy target is this Server, as
   * `Project / Environment`.
   */
  private async targetingEnvironments(serverId: string): Promise<string[]> {
    const rows = await this.db
      .select({ project: project.name, environment: environment.name })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          sql`${environment.deployTarget} ->> 'kind' = 'server'`,
          sql`${environment.deployTarget} ->> 'serverId' = ${serverId}`,
        ),
      )
      .orderBy(asc(project.name), asc(environment.name));
    return rows.map((row) => `${row.project} / ${row.environment}`);
  }

  /**
   * Deletes a Server, org-scoped through findOne — plus the guard the console
   * has always described and the schema never had.
   *
   * Deleting a Server is a *forget the machine* gesture: it stops nothing and
   * cleans nothing up, and `DeleteServerModal` says so in as many words. But
   * every service table's `serverId` cascades, so deleting a Server that is
   * carrying services also deleted Cloudgate's record of each one while the
   * containers kept running — leaving nothing that said which Project they
   * belonged to, which is the very thing the dialog tells you to go and use.
   * The console at least made an operator type the Server's name first; an API
   * key had no confirmation at all.
   *
   * So the delete refuses while anything names this Server, and names what it
   * found. The alternative — making the cascade `set null` so the rows survive
   * unassigned — would leave a service pointing at no machine, which no other
   * part of the system is written for.
   *
   * The guard covers **thirteen** cascades, not the eight first read: the three
   * configuration tables refuse alongside the Services, in their own clause and
   * under their own noun, and the two metric tables deliberately do not.
   * `carriedConfiguration` carries that accounting.
   */
  async remove(ctx: PermissionCtx, serverId: string) {
    const current = await this.findOne(ctx, serverId);

    // An Environment's Deploy target names a Server in jsonb, with no foreign
    // key to cascade or refuse, so the guard is here. It is its own
    // refusal rather than a third clause below: nothing runs because of it and
    // nothing is lost, but the Environment would be left pointing at no
    // machine, and the fix is a different screen — the Environment's settings.
    const targeting = await this.targetingEnvironments(current.serverId);
    if (targeting.length > 0) {
      throw new ConflictException(
        `Server "${current.name}" is the Deploy target of ` +
          `${nameCategory(targeting, 'Environment', 'Environments')}. ` +
          `Choose another Deploy target in ${targeting.length === 1 ? 'its' : 'their'} settings first`,
      );
    }

    const [carried, configuration] = await Promise.all([
      this.carriedServices(current.serverId),
      this.carriedConfiguration(current.serverId),
    ]);
    if (carried.length > 0 || configuration.length > 0) {
      const clauses = [
        nameCategory(carried, 'service', 'services'),
        nameCategory(
          configuration,
          'configuration entry',
          'configuration entries',
        ),
      ].filter((clause): clause is string => clause !== null);

      throw new ConflictException(
        `Server "${current.name}" still carries ${clauses.join(' and ')}. ` +
          // The consequence differs by category, so the sentence does too: a
          // Service leaves running containers behind, a certificate or a cron
          // job just stops existing. Saying "the containers keep running" over
          // a certificate-only refusal would describe something that is not
          // happening.
          //
          // A **mixed** refusal takes the Services sentence and not a third
          // variant, deliberately. It is accurate about the half that
          // leaves containers behind, which is the only half with a consequence
          // beyond the row vanishing, and the operator's action is the same
          // either way — so a third string would be a third thing to keep true
          // for no change in what anyone does. All three messages are pinned
          // verbatim in servers.e2e-spec.ts; a fourth one is a red test.
          (carried.length > 0
            ? 'Deleting the Server would delete Cloudgate’s record of each ' +
              'one while the containers keep running, leaving nothing that ' +
              'says which Project they belonged to. '
            : 'Deleting the Server would delete Cloudgate’s record of each ' +
              'one, and nothing else records what they were. ') +
          'Move or delete them first',
      );
    }

    // A Bought Server goes to Deleting in the same write the row goes in,
    // so nothing connects to it from here on, and its lines, its machine,
    // backups, Volume and Primary IPs go next (ADR-0071: there is no "keep
    // the machine"). Its `bought_server` row stays, marked Deleted, as the
    // record of what was bought. Any other Server is only forgotten.
    const { removed, bought } = await this.db.transaction(async (tx) => {
      const bought = await beginDeleting(tx, current.serverId, new Date());
      const [removed] = await tx
        .delete(server)
        .where(eq(server.serverId, current.serverId))
        .returning();
      return { removed, bought };
    });
    if (bought?.started) await this.boughtServers.advance(bought.id);

    return removed;
  }
}
