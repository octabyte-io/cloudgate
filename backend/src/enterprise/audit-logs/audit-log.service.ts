import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  sql,
} from 'drizzle-orm';
import { user } from '../../auth/auth.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { member, organization } from '../../organizations/organizations.schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { auditLog } from './audit-log.schema';
import type { AuditActorKind } from './dto/audit-log.dto';
import { PLATFORM_ACTOR_NAME, PLATFORM_ACTOR_ROLE } from './platform-actor';
import type {
  AuditAction,
  AuditLog,
  AuditOutcome,
  AuditResourceType,
} from './audit-log.schema';

/** The refusal for the deleted-organizations trail, in the screen's words. */
export const DELETED_ORGANIZATIONS_REFUSAL =
  'Only an owner or admin of the instance organization can read the entries of deleted Organizations';

/** One audit row as `record` writes it, actor resolved, plus the caller address. */
export interface AuditEvent {
  organizationId: string;
  userId: string;
  userEmail: string;
  userRole: string;
  /** The actor's display name at the time; see `auditLog.userName`. */
  userName?: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  resourceName?: string;
  /** `succeeded` when omitted. A `refused` or `failed` row puts its reason in `metadata.reason`. */
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/** Who acted, and from where. The email and role are resolved from the DB. */
export interface AuditActor {
  userId: string;
  organizationId: string | null | undefined;
  ip?: string;
}

/**
 * One event in the life of the "paid by" link between an **Attached
 * Organization** and its **Paying Organization** (ADR-0059): it was
 * made attached, its owner started paying for it, the Paying Organization
 * stopped paying for it, or it was deleted.
 */
export type LinkEvent =
  'attached' | 'paidForItself' | 'stoppedPaying' | 'deleted';

/**
 * Each link event's action. Two are `update`, so the action list does not
 * grow; `metadata.link` tells them apart.
 */
const LINK_EVENT_ACTIONS: Record<LinkEvent, AuditAction> = {
  attached: 'create',
  paidForItself: 'update',
  stoppedPaying: 'update',
  deleted: 'delete',
};

/** The platform, for {@link AuditLogService.recordLinkEvent}. */
export const PLATFORM_ACTOR = 'platform' as const;

/**
 * Who did a link event: a person, with the Organization they acted from (one
 * of the two), or {@link PLATFORM_ACTOR}.
 */
export type LinkEventActor =
  | { userId: string; actedFromOrganizationId: string; ip?: string }
  | typeof PLATFORM_ACTOR;

/** What happened, as a caller of `audit` describes it. */
export interface AuditEventInput {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  resourceName?: string;
  /** `succeeded` when omitted. A `refused` or `failed` row puts its reason in `metadata.reason`. */
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
}

/** The trail's filters and page; the organizationId is passed separately. */
export interface FindAuditLogsInput {
  userId?: string;
  userEmail?: string;
  resourceName?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  outcome?: AuditOutcome;
  /** `platform`: only the rows the platform wrote with no caller. */
  actor?: AuditActorKind;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * The organization audit trail: writes and the filtered, paginated read.
 *
 * Neither writes nor reads are gated on a license. A write gated on
 * `hasValidLicense(organizationId)` would make an unlicensed organization record
 * nothing, so its history would be silently absent rather than merely
 * unreadable. The trail is kept unconditionally and reads are gated by the
 * `auditLog:read` permission instead (owner/admin pass, member denied, since
 * `auditLog` is an enterpriseOnlyResource). Phase 49 made LicenseService real;
 * this stays deliberate, not a consequence of the stub it used to be.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Writes one entry and answers its id, or `null` when the write failed.
   * Fire-and-forget safe — a logging failure never breaks the operation being
   * audited, and a caller that does not need the id ignores it.
   *
   * The id is for the MCP dispatcher: an unmapped tool failure answers
   * "The call failed." plus the id of the row that holds the detail, so the
   * operator can find it in the console while the model is told nothing.
   */
  record(event: AuditEvent): Promise<string | null> {
    return this.write(event);
  }

  /**
   * Writes one entry whose actor is **the platform**: no user id, no
   * email, role `system` and name `Cloudgate`. `platform-actor.ts` owns the
   * shape, and says why every caller-less writer reuses it. No member is
   * looked up, so the row is written even when whoever the act was for (an
   * Agent that asked for a preview) no longer exists; name them in
   * `metadata`. Answers the id, or `null` when the write failed.
   */
  recordAsPlatform(
    organizationId: string | null,
    event: AuditEventInput,
  ): Promise<string | null> {
    return this.write({
      organizationId,
      userId: null,
      userEmail: null,
      userRole: PLATFORM_ACTOR_ROLE,
      userName: PLATFORM_ACTOR_NAME,
      ...event,
    });
  }

  /**
   * Writes one link event into **both** Organizations' logs, the Attached
   * Organization's row first. Every row has one shape: resource type
   * `organization`, the resource always the Attached Organization (its id
   * and its name now), and metadata `{ link, payingOrganizationId,
   * payingOrganizationName }`, so each log names the other Organization and
   * both still read correctly after either is deleted.
   *
   * The person is looked up once. Where they are a member, the row records
   * their real role there. Where they are not — a Paying Organization's admin
   * stopping payment for an Organization they never joined — it records
   * their role in the Organization they acted from, and the metadata names
   * that Organization (`actedFromOrganizationId`, `actedFromOrganizationName`)
   * rather than inventing a role word. The platform, a person who no longer
   * exists, or one who holds no role in either, is written as the platform.
   *
   * Called after the link's change has committed (for a delete, just before
   * it), outside its transaction: like every writer, it never throws, so a
   * failed row can never fail or undo the change. `audit()` is not used: it
   * writes nothing for a non-member.
   */
  async recordLinkEvent(
    actor: LinkEventActor,
    link: {
      event: LinkEvent;
      attachedOrganizationId: string;
      payingOrganizationId: string;
    },
  ): Promise<void> {
    try {
      const { attachedOrganizationId, payingOrganizationId } = link;
      const names = await this.db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(
          inArray(organization.id, [
            attachedOrganizationId,
            payingOrganizationId,
          ]),
        );
      const nameOf = (id: string) =>
        names.find((row) => row.id === id)?.name ?? null;
      const event: AuditEventInput = {
        action: LINK_EVENT_ACTIONS[link.event],
        resourceType: 'organization',
        resourceId: attachedOrganizationId,
        resourceName: nameOf(attachedOrganizationId) ?? undefined,
        metadata: {
          link: link.event,
          payingOrganizationId,
          payingOrganizationName: nameOf(payingOrganizationId),
        },
      };
      const logs = [attachedOrganizationId, payingOrganizationId];

      const person =
        actor === PLATFORM_ACTOR
          ? null
          : await this.linkActorOf(actor.userId, logs);
      if (actor === PLATFORM_ACTOR || !person) {
        for (const organizationId of logs) {
          await this.recordAsPlatform(organizationId, event);
        }
        return;
      }

      const actedFromRole = person.roles.get(actor.actedFromOrganizationId);
      for (const organizationId of logs) {
        const role = person.roles.get(organizationId);
        if (!role && !actedFromRole) {
          await this.recordAsPlatform(organizationId, event);
          continue;
        }
        await this.record({
          organizationId,
          userId: actor.userId,
          userEmail: person.email,
          userName: person.name,
          userRole: role ?? actedFromRole!,
          ip: actor.ip,
          ...event,
          metadata: role
            ? event.metadata
            : {
                ...event.metadata,
                actedFromOrganizationId: actor.actedFromOrganizationId,
                actedFromOrganizationName: nameOf(
                  actor.actedFromOrganizationId,
                ),
              },
        });
      }
    } catch (err) {
      this.logger.error('Failed to create audit log entry', err as Error);
    }
  }

  /**
   * A person's email, name and role in each of these Organizations, in one
   * query; null when they no longer exist.
   */
  private async linkActorOf(
    userId: string,
    organizationIds: string[],
  ): Promise<{
    email: string;
    name: string | null;
    roles: Map<string, string>;
  } | null> {
    const rows = await this.db
      .select({
        email: user.email,
        name: sql<
          string | null
        >`nullif(trim(${user.firstName} || ' ' || ${user.lastName}), '')`,
        organizationId: member.organizationId,
        role: member.role,
      })
      .from(user)
      .leftJoin(
        member,
        and(
          eq(member.userId, user.id),
          inArray(member.organizationId, organizationIds),
        ),
      )
      .where(eq(user.id, userId));
    if (rows.length === 0) return null;
    const roles = new Map<string, string>();
    for (const row of rows) {
      if (row.organizationId && row.role) {
        roles.set(row.organizationId, row.role);
      }
    }
    return { email: rows[0].email, name: rows[0].name, roles };
  }

  /** The one insert both actors go through. Never throws. */
  private async write(
    event: Omit<AuditEvent, 'organizationId' | 'userId' | 'userEmail'> & {
      organizationId: string | null;
      userId: string | null;
      userEmail: string | null;
    },
  ): Promise<string | null> {
    try {
      const [written] = await this.db
        .insert(auditLog)
        .values({
          organizationId: event.organizationId,
          userId: event.userId,
          userEmail: event.userEmail,
          userRole: event.userRole,
          userName: event.userName ?? null,
          action: event.action,
          outcome: event.outcome,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          resourceName: event.resourceName,
          metadata: event.metadata ? JSON.stringify(event.metadata) : undefined,
          ip: event.ip,
        })
        .returning({ id: auditLog.auditLogId });
      return written?.id ?? null;
    } catch (err) {
      this.logger.error('Failed to create audit log entry', err as Error);
      return null;
    }
  }

  /**
   * Records an event for an actor whose email, name and role are looked up
   * rather than passed in. Nothing is recorded when the actor has no active
   * organization or is not a member of it.
   *
   * The role stored is the actor's role in the organization, which is also what
   * the login/logout hooks record — not the admin plugin's global user role,
   * which on a self-hosted Cloudgate instance is always 'user'.
   *
   * Answers the written row's id, or `null` when nothing was written.
   */
  async audit(
    actor: AuditActor,
    event: AuditEventInput,
  ): Promise<string | null> {
    try {
      if (!actor.organizationId) return null;
      const [memberRecord] = await this.db
        .select({
          role: member.role,
          email: user.email,
          // better-auth's `name` is the `firstName` column; an Agent's name
          // is all in it and its `lastName` is ''.
          name: sql<string>`nullif(trim(${user.firstName} || ' ' || ${user.lastName}), '')`,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(
          and(
            eq(member.userId, actor.userId),
            eq(member.organizationId, actor.organizationId),
          ),
        )
        .limit(1);
      if (!memberRecord) return null;

      return await this.record({
        organizationId: actor.organizationId,
        userId: actor.userId,
        userEmail: memberRecord.email,
        userRole: memberRecord.role,
        userName: memberRecord.name,
        ip: actor.ip,
        ...event,
      });
    } catch (err) {
      this.logger.error('Failed to create audit log entry', err as Error);
      return null;
    }
  }

  /**
   * One trail's entries, newest first, with a total for pagination.
   *
   * `organizationId` names the trail: an Organization's id, or `null` for the
   * entries whose Organization has been deleted. The organization FK is
   * `set null`, so deleting an Organization keeps its entries with no
   * Organization at all — and an equality on the active Organization could
   * never reach them again. Who may ask for the `null` trail is
   * {@link findTrail}'s question, not this method's.
   */
  async findAll(
    organizationId: string | null,
    input: FindAuditLogsInput,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const { limit = 50, offset = 0 } = input;
    const conditions = [
      organizationId === null
        ? isNull(auditLog.organizationId)
        : eq(auditLog.organizationId, organizationId),
    ];

    if (input.userId) conditions.push(eq(auditLog.userId, input.userId));
    if (input.userEmail)
      conditions.push(ilike(auditLog.userEmail, `%${input.userEmail}%`));
    if (input.resourceName)
      conditions.push(ilike(auditLog.resourceName, `%${input.resourceName}%`));
    if (input.action) conditions.push(eq(auditLog.action, input.action));
    if (input.resourceType)
      conditions.push(eq(auditLog.resourceType, input.resourceType));
    if (input.outcome) conditions.push(eq(auditLog.outcome, input.outcome));
    // The platform's whole shape, not its role alone: a row written before
    // 0080 renamed a custom role called `system` carries that role and a
    // person behind it (`platform-actor.ts` says why the shape is the test).
    if (input.actor === 'platform')
      conditions.push(
        isNull(auditLog.userId),
        isNull(auditLog.userEmail),
        eq(auditLog.userRole, PLATFORM_ACTOR_ROLE),
      );
    if (input.from) conditions.push(gte(auditLog.createdAt, input.from));
    if (input.to) conditions.push(lte(auditLog.createdAt, input.to));

    const where = and(...conditions);
    const [logs, total] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.$count(auditLog, where),
    ]);

    return { logs, total };
  }

  /**
   * The trail `GET /audit-logs` serves, resolved for the caller.
   *
   * `scope: 'organization'` is the active Organization's trail.
   * `scope: 'deleted-organizations'` is every entry whose Organization has
   * been deleted: with no Organization left there is no organization role to
   * read them by, and the authority that outlives an Organization is the
   * instance's, so that trail takes `checkInstanceAuthority` (ADR-0013) — the
   * instance organization's owners and admins. A second Organization's owner
   * is refused: those rows are other people's sign-ins and addresses, and one
   * deleted Organization's rows are not told apart from another's.
   *
   * `deletedOrganizationEntries` answers "how many entries can't this screen
   * show?" — a number for a caller who can read them, `null` for one who
   * cannot, so a second Organization's owner learns nothing about the others.
   */
  async findTrail(
    ctx: PermissionCtx,
    query: FindAuditLogsInput & {
      scope: 'organization' | 'deleted-organizations';
    },
  ): Promise<{
    logs: AuditLog[];
    total: number;
    deletedOrganizationEntries: number | null;
  }> {
    const { scope, ...filters } = query;
    const instance = await this.holdsInstanceAuthority(ctx);
    if (scope === 'deleted-organizations' && !instance) {
      throw new ForbiddenException(DELETED_ORGANIZATIONS_REFUSAL);
    }
    const [page, deletedOrganizationEntries] = await Promise.all([
      this.findAll(
        scope === 'deleted-organizations'
          ? null
          : ctx.session.activeOrganizationId,
        filters,
      ),
      instance ? this.countOfDeletedOrganizations() : null,
    ]);
    return { ...page, deletedOrganizationEntries };
  }

  /** `checkInstanceAuthority` as a yes or no, for a read that only narrows. */
  private async holdsInstanceAuthority(ctx: PermissionCtx): Promise<boolean> {
    try {
      await this.permissions.checkInstanceAuthority(ctx);
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) return false;
      throw err;
    }
  }

  /** How many entries outlived the Organization they were recorded in. */
  countOfDeletedOrganizations(): Promise<number> {
    return this.db.$count(auditLog, isNull(auditLog.organizationId));
  }
}
