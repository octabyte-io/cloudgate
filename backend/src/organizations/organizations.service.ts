import type { IncomingHttpHeaders } from 'node:http';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { callAuthApi, toWebHeaders } from '../auth/auth-api.util';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { LicenseService } from '../enterprise/license/license.service';
import type { Auth } from '../auth/auth.config';
import { AUTH } from '../auth/auth.constants';
import { banInForce } from '../auth/ban';
import { SCIM_DEACTIVATION_REASON } from '../enterprise/scim/scim-tombstone';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  invitation,
  member,
  organization,
  organizationRole,
  subscription,
  team,
  teamMember,
  user,
} from '../db/schema';
import { assertNothingAttached } from '../cloud/billing/attached-refusals';
import { whyCannotAttachTo } from '../cloud/billing/attaching';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  organizationsPayingForThemselvesOwnedBy,
  payingOrganizationOf,
} from '../cloud/billing/paying-organization';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { isAgentRole } from '../rbac/access-control';
import { refuseDeletingInstanceOrganization } from '../rbac/instance-organization-pin';
import { assertRoleFitsKind, writeMemberRole } from '../rbac/member-role';
import { PermissionService } from '../rbac/permission.service';
import type { Invitation } from './organizations.schema';
import type { InviteMemberDto } from './dto/invite-member.dto';
import { customInvitationRole } from './invitation-role';
import type { CreateOrganizationDto } from './dto/organization.dto';
import type { UpdateMemberEntitlementsDto } from './dto/update-member-entitlements.dto';
import {
  CONFIRM_EMAIL_BEFORE_CREATE_REFUSAL,
  HOSTED_OWN_LIMIT,
  hostedLimitReason,
  organizationLimit,
  refusalViewOf,
  SELF_HOSTED_CREATE_ROLE_REFUSAL,
  selfHostedLimitReason,
} from './organization-limit';
import type { OrganizationCreation } from './organization-limit';
import { organizationNameOf } from './organization-name';

/**
 * The assignable roles better-auth's organization plugin resolves on its own —
 * every other assignable role is a custom one (`assertAssignableRole`).
 */
function isStaticAssignableRole(role: string): role is 'admin' | 'member' {
  return role === 'admin' || role === 'member';
}

/**
 * The single reason an invitation cannot be acted on. better-auth collapses
 * every one of these into INVITATION_NOT_FOUND; the invitee's landing page
 * needs them apart to say anything truthful.
 */
function invitationStateCode(invite: Invitation): string {
  // What became of the invitation outranks the clock: an accepted invitation
  // that has since passed its expiry is still accepted.
  switch (invite.status) {
    case 'accepted':
      return 'INVITATION_ALREADY_ACCEPTED';
    case 'rejected':
      return 'INVITATION_REJECTED';
    case 'canceled':
      return 'INVITATION_WITHDRAWN';
    case 'pending':
      return invite.expiresAt.getTime() <= Date.now()
        ? 'INVITATION_EXPIRED'
        : 'INVITATION_PENDING';
    default:
      return 'INVITATION_NOT_OPEN';
  }
}

/**
 * Whether a member's account is deactivated, as the Members table says it
 * — `null` when it is not.
 *
 * Decided by {@link banInForce}, the predicate every credential reader refuses
 * on, so the row is marked exactly when the person cannot get in: a ban whose
 * `banExpires` has passed reads as active here as it does at sign-in.
 *
 * `byDirectory` is whether the ban is the one the SCIM plugin writes for
 * `active: false` ({@link SCIM_DEACTIVATION_REASON}), which is the same test
 * `reviveScimTombstone` uses to decide the ban is SCIM's to lift. It is the
 * half the console needs to say who can undo it: nothing in Cloudgate lifts
 * that ban, the identity provider does.
 *
 * Three fields and no more — the row's own `banned`/`banReason`/`banExpires`
 * columns are not passed through on `user`.
 */
function memberDeactivation(
  row:
    | {
        banned: boolean | null;
        banReason: string | null;
        banExpires: Date | null;
      }
    | undefined,
): {
  byDirectory: boolean;
  reason: string | null;
  expiresAt: Date | null;
} | null {
  if (!row || !banInForce(row)) return null;
  return {
    byDirectory: row.banReason === SCIM_DEACTIVATION_REASON,
    reason: row.banReason,
    expiresAt: row.banExpires,
  };
}

/**
 * Whether a delete failed on `organization.paid_by_organization_id`'s
 * `RESTRICT`: an Organization was attached after the check. Drizzle wraps
 * the driver's error, so its `cause` is read too.
 */
function isAttachedRestrict(err: unknown): boolean {
  for (const one of [err, (err as { cause?: unknown } | null)?.cause]) {
    const { code, constraint } = (one ?? {}) as {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      code === '23503' &&
      constraint === 'organization_paid_by_organization_id_organization_id_fk'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The role refusal of "Add an Organization to this plan": only the open
 * Organization's owners and admins may make it pay for another.
 */
export const ATTACH_ROLE_REFUSAL =
  'Only owners and admins can add an Organization to this plan';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly auditLogs: AuditLogService,
    // LicenseModule is @Global, so this needs no import here — the same way
    // PermissionService reaches it to resolve custom roles.
    private readonly license: LicenseService,
    // RbacModule is @Global too. PermissionService owns the accessed* columns
    // and every check that reads them, so the write lives there.
    private readonly permissions: PermissionService,
    // InstanceModeModule is @Global as well.
    private readonly instanceMode: InstanceMode,
    // So is BillingModule, which exports the one "is it frozen" (ADR-0052).
    private readonly frozen: FrozenOrganizations,
  ) {}

  /**
   * Organizations the user belongs to, each with the caller's membership and
   * who pays for it — the list the console's switcher draws as a tree.
   *
   * `paidBy` is null for an Organization that pays for itself. For an
   * **Attached Organization** it names the Paying Organization's id only when
   * the caller is a member of that one too, so it is in this same list and the
   * switcher nests it there; otherwise it is `{ organizationId: null }`,
   * "Paid by another Organization". The raw `paidByOrganizationId` column is
   * left off every row, so the list never tells someone the id, let alone the
   * name, of an Organization they do not belong to (ADR-0013, ADR-0059).
   */
  async listForUser(userId: string) {
    const rows = await this.db
      .select({ organization, member })
      .from(organization)
      .innerJoin(
        member,
        and(
          eq(member.organizationId, organization.id),
          eq(member.userId, userId),
        ),
      );
    const memberOf = new Set(rows.map((row) => row.organization.id));
    return rows.map((row) => {
      const { paidByOrganizationId, ...own } = row.organization;
      return {
        ...own,
        member: row.member,
        paidBy:
          paidByOrganizationId === null
            ? null
            : {
                organizationId: memberOf.has(paidByOrganizationId)
                  ? paidByOrganizationId
                  : null,
              },
      };
    });
  }

  /**
   * Who may create an Organization, and becomes its owner.
   *
   * - **Hosted** (ADR-0051): any confirmed person, whatever their role
   *   where they are now. It starts with no plan and pays on its own: billing
   *   is per Organization and nothing here writes a subscription row. A person
   *   owns at most one Organization that pays for itself (ADR-0059,
   *   {@link hostedLimit}): a second is refused with `ORGANIZATION_LIMIT`, after
   *   the confirmed-address check, which stays first.
   * - **Self-hosted**: only an owner or admin of the active Organization (the
   *   member role in it). The instance is its owner's, and a plain member
   *   making tenants on it is not something they were invited to do. That
   *   check comes first; then the one-Organization limit
   *   ({@link selfHostedLimit}, ADR-0059).
   *
   * **"Add an Organization to this plan"** (`paidBy: 'active-organization'`,
   * Hosted, ADR-0059) makes an **Attached Organization** of the caller's
   * active one ({@link payingFor}). The link, the creator's owner row and the
   * new Organization's own `subscription` row — no plan, status or Add-ons,
   * only its never-cleared `firstAttachedAt` — are written in the one
   * transaction that inserts it, so there is never an Attached Organization
   * without its mark, nor a link to a payer that was refused. The creator
   * owns it and it starts with its own members: nobody else from the Paying
   * Organization joins it. The `attached` link row goes into both logs after
   * the commit, in place of the plain create row.
   */
  async create(
    user: { id: string; role: string; emailVerified?: boolean },
    data: CreateOrganizationDto,
    ip?: string,
    activeOrganizationId?: string | null,
  ) {
    const { paidBy, ...values } = data;
    let payingOrganizationId: string | null = null;
    if (this.instanceMode.isHosted) {
      // Unreachable by a password session today — an unconfirmed account is
      // refused sign-in — but a session is not the only way to a caller.
      if (user.emailVerified !== true) {
        throw new ForbiddenException(CONFIRM_EMAIL_BEFORE_CREATE_REFUSAL);
      }
      if (paidBy === 'active-organization') {
        payingOrganizationId = await this.payingFor(user, activeOrganizationId);
      } else {
        const limit = await this.hostedLimit(user, activeOrganizationId);
        if (limit.reason !== null) throw organizationLimit(limit.reason);
      }
    } else {
      if (user.role !== 'owner' && user.role !== 'admin') {
        throw new ForbiddenException(SELF_HOSTED_CREATE_ROLE_REFUSAL);
      }
      if (paidBy === 'active-organization') {
        throw new BadRequestException(
          'Only the Hosted instance has plans that pay for other Organizations',
        );
      }
      const limit = await this.selfHostedLimit(user.id);
      if (limit.reached) {
        throw organizationLimit(selfHostedLimitReason(limit.instanceStaff));
      }
    }

    const org = await this.db.transaction(async (tx) => {
      const now = new Date();
      const [created] = await tx
        .insert(organization)
        .values({
          ...values,
          ownerId: user.id,
          paidByOrganizationId: payingOrganizationId,
          createdAt: now,
        })
        .returning();
      await tx.insert(member).values({
        organizationId: created.id,
        userId: user.id,
        role: 'owner',
        createdAt: now,
      });
      if (payingOrganizationId !== null) {
        await tx
          .insert(subscription)
          .values({ organizationId: created.id, firstAttachedAt: now });
      }
      return created;
    });

    if (payingOrganizationId !== null) {
      await this.auditLogs.recordLinkEvent(
        { userId: user.id, actedFromOrganizationId: payingOrganizationId, ip },
        {
          event: 'attached',
          attachedOrganizationId: org.id,
          payingOrganizationId,
        },
      );
      return org;
    }

    await this.auditLogs.audit(
      { userId: user.id, organizationId: org.id, ip },
      {
        action: 'create',
        resourceType: 'organization',
        resourceId: org.id,
        resourceName: org.name,
      },
    );
    return org;
  }

  /**
   * Who pays for an Organization made with "Add an Organization to this
   * plan": the caller's active Organization, once it may (ADR-0059). The
   * caller's role there is asked **first**, before anything about its plan is
   * said; then `whyCannotAttachTo` — on Business or Enterprise, Free trial
   * included, not attached itself, and no move to Starter waiting — refused
   * with `ORGANIZATION_LIMIT` and the reason, which is the sentence the
   * Billing page greys the button out with.
   */
  private async payingFor(
    user: { id: string; role: string },
    activeOrganizationId: string | null | undefined,
  ): Promise<string> {
    if (!activeOrganizationId) {
      throw new ForbiddenException('No active organization');
    }
    if (user.role !== 'owner' && user.role !== 'admin') {
      throw new ForbiddenException(ATTACH_ROLE_REFUSAL);
    }
    const reason = await whyCannotAttachTo(this.db, activeOrganizationId);
    if (reason !== null) throw organizationLimit(reason);
    return activeOrganizationId;
  }

  /**
   * Whether {@link create} would accept this caller now, and why not, for the
   * console to grey out "New organization" before anyone clicks. It asks the
   * same questions in the same order as `create`, so the button and the route
   * cannot disagree.
   */
  async creation(
    user: {
      id: string;
      role: string;
      emailVerified?: boolean;
    },
    activeOrganizationId?: string | null,
  ): Promise<OrganizationCreation> {
    if (this.instanceMode.isHosted) {
      const limit = await this.hostedLimit(user, activeOrganizationId);
      const confirmed = user.emailVerified === true;
      return {
        // The confirmed-address refusal carries no code: it is not a limit.
        ...(confirmed
          ? refusalViewOf(limit.reason)
          : refusalViewOf(CONFIRM_EMAIL_BEFORE_CREATE_REFUSAL, null)),
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: limit.owned, of: HOSTED_OWN_LIMIT },
        planHint: confirmed ? limit.planHint : null,
      };
    }

    const ownerOrAdmin = user.role === 'owner' || user.role === 'admin';
    const limit = await this.selfHostedLimit(user.id);
    // The role refusal comes first and carries no code; then the limit.
    const limited = ownerOrAdmin && limit.reached;
    return {
      ...(ownerOrAdmin
        ? refusalViewOf(
            limited ? selfHostedLimitReason(limit.instanceStaff) : null,
          )
        : refusalViewOf(SELF_HOSTED_CREATE_ROLE_REFUSAL, null)),
      licenseHint: limited && limit.instanceStaff,
      overLimit:
        ownerOrAdmin && !limit.licensed && limit.count > 1
          ? { count: limit.instanceStaff ? limit.count : null }
          : null,
      ownedPayingForThemselves: null,
      planHint: null,
    };
  }

  /**
   * The Hosted one-Organization limit (ADR-0059): a person owns at most one
   * Organization that pays for itself. Attached Organizations they own and the
   * Instance organization are not counted
   * (`organizationsPayingForThemselvesOwnedBy`), and only creating is limited:
   * invites and membership are not.
   *
   * `reason` is the refusal's sentence, or `null` when they own none. It names
   * the oldest one they own, which is theirs to know. The upsell sentence, and
   * `planHint` — where a second Organization comes from — go only to the open
   * Organization's owners and admins: "Add an Organization to <open>'s plan"
   * when it can pay for one, "See plans" otherwise.
   */
  private async hostedLimit(
    user: { id: string; role: string },
    activeOrganizationId: string | null | undefined,
  ): Promise<{
    owned: number;
    reason: string | null;
    planHint: OrganizationCreation['planHint'];
  }> {
    const owned = await organizationsPayingForThemselvesOwnedBy(
      this.db,
      user.id,
      await this.permissions.instanceOrganizationId(),
    );
    if (owned.length === 0) {
      return { owned: 0, reason: null, planHint: null };
    }
    const [first] = owned;
    const ownerOrAdmin =
      !!activeOrganizationId &&
      (user.role === 'owner' || user.role === 'admin');
    if (!ownerOrAdmin) {
      return {
        owned: owned.length,
        reason: hostedLimitReason(first.name, null),
        planHint: null,
      };
    }
    const [ownedCannotPay, openCannotPay, openName] = await Promise.all([
      whyCannotAttachTo(this.db, first.id),
      whyCannotAttachTo(this.db, activeOrganizationId),
      organizationNameOf(this.db, activeOrganizationId),
    ]);
    return {
      owned: owned.length,
      reason: hostedLimitReason(
        first.name,
        ownedCannotPay === null ? 'on-its-plan' : 'on-business',
      ),
      planHint:
        openCannotPay === null
          ? { kind: 'add-to-plan', organizationName: openName }
          : { kind: 'see-plans' },
    };
  }

  /**
   * The Self-hosted one-Organization limit (ADR-0059): a new Organization only
   * when none exists yet, or when the **Instance organization's** Enterprise
   * license is valid — the same question `SettingsService.requireInstanceLicense`
   * asks for white-labelling. No other Organization's license counts: the
   * limit is the instance's, and a tenant cannot buy its way past the instance
   * owner. Every Organization that exists counts, so deleting one frees its slot,
   * and a license passing `validUntil` removes nothing — it only refuses the
   * next one.
   *
   * `instanceStaff` is whether this person is an owner or admin of the Instance
   * organization, which picks the refusal's wording: they can add the license,
   * everyone else is told who can.
   */
  private async selfHostedLimit(userId: string): Promise<{
    reached: boolean;
    licensed: boolean;
    count: number;
    instanceStaff: boolean;
  }> {
    const [{ organizations }] = await this.db
      .select({ organizations: count() })
      .from(organization);
    const instanceOrganizationId =
      await this.permissions.instanceOrganizationId();
    const licensed =
      instanceOrganizationId !== null &&
      (await this.license.hasValidLicense(instanceOrganizationId));
    const [staff] =
      instanceOrganizationId === null
        ? []
        : await this.db
            .select({ id: member.id })
            .from(member)
            .where(
              and(
                eq(member.organizationId, instanceOrganizationId),
                eq(member.userId, userId),
                inArray(member.role, ['owner', 'admin']),
              ),
            )
            .limit(1);
    return {
      reached: organizations > 0 && !licensed,
      licensed,
      count: organizations,
      instanceStaff: staff !== undefined,
    };
  }

  /** An organization is only visible to its members. */
  async getById(userId: string, organizationId: string) {
    const [org] = await this.db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!org) throw new NotFoundException('Organization not found');

    await this.assertMemberRole(organizationId, userId, [
      'owner',
      'admin',
      'member',
    ]);
    return org;
  }

  /** Marks the membership new sessions should start in. */
  async setDefault(userId: string, organizationId: string, ip?: string) {
    const [callerMember] = await this.db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .limit(1);
    if (!callerMember) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    await this.db
      .update(member)
      .set({ isDefault: false })
      .where(eq(member.userId, userId));
    await this.db
      .update(member)
      .set({ isDefault: true })
      .where(eq(member.id, callerMember.id));

    await this.auditLogs.audit(
      { userId, organizationId, ip },
      {
        action: 'update',
        resourceType: 'organization',
        resourceId: organizationId,
        metadata: { type: 'setDefault' },
      },
    );
    return { success: true };
  }

  /** Any member may read, only the owner may update. */
  async update(
    userId: string,
    organizationId: string,
    data: { name: string; logo?: string },
    ip?: string,
  ) {
    await this.assertOwner(userId, organizationId);
    const [updated] = await this.db
      .update(organization)
      .set(data)
      .where(eq(organization.id, organizationId))
      .returning();

    await this.auditLogs.audit(
      { userId, organizationId, ip },
      {
        action: 'update',
        resourceType: 'organization',
        resourceId: organizationId,
        resourceName: data.name,
      },
    );
    return updated;
  }

  /**
   * Owner only, and the owner must keep at least one organization they own —
   * except a Frozen Organization, which its owner may delete even when it is
   * their only one, so they can always leave (ADR-0052). Afterwards
   * they own none; on the Hosted instance a confirmed person can make another.
   * Every Organization they own counts, Attached ones included.
   *
   * A **Paying Organization** is refused with `ORGANIZATIONS_ATTACHED` while
   * any Organization is attached to it, naming each, frozen or not
   * (ADR-0059): deleting it must never take its customers' Organizations with
   * it. The database's `RESTRICT` backs this up, and an Organization attached
   * between the check and the delete gets the same refusal.
   *
   * The **Instance organization** is refused with
   * `INSTANCE_ORGANIZATION_UNDELETABLE`, frozen or not (ADR-0077): deleting it
   * would leave nobody holding instance authority.
   *
   * Deleting an **Attached Organization** writes the `deleted` link row into
   * both its own log and its Paying Organization's, in place of the plain
   * delete row; its Servers and Cloud Environments leave the pool with it.
   */
  async delete(userId: string, organizationId: string, ip?: string) {
    const org = await this.assertOwner(userId, organizationId);
    await refuseDeletingInstanceOrganization(this.db, [organizationId]);
    await assertNothingAttached(this.db, organizationId, 'delete');

    const ownedOrgs = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.ownerId, userId));
    if (
      ownedOrgs.length <= 1 &&
      !(await this.frozen.isFrozen(organizationId))
    ) {
      throw new ForbiddenException(
        'You must maintain at least one organization where you are the owner',
      );
    }

    // Recorded before the delete: afterwards the organization row is gone and
    // the entry's FK insert would fail silently. The
    // entry survives the delete (the FK is `set null`) but detaches from the
    // organization, so it is no longer visible to the org-scoped query.
    const paying = await payingOrganizationOf(this.db, organizationId);
    if (paying.attached) {
      await this.auditLogs.recordLinkEvent(
        { userId, actedFromOrganizationId: organizationId, ip },
        {
          event: 'deleted',
          attachedOrganizationId: organizationId,
          payingOrganizationId: paying.payingOrganizationId,
        },
      );
    } else {
      await this.auditLogs.audit(
        { userId, organizationId, ip },
        {
          action: 'delete',
          resourceType: 'organization',
          resourceId: organizationId,
          resourceName: org.name,
        },
      );
    }

    try {
      await this.db
        .delete(organization)
        .where(eq(organization.id, organizationId));
    } catch (err) {
      if (!isAttachedRestrict(err)) throw err;
      await assertNothingAttached(this.db, organizationId, 'delete');
      throw err;
    }
    return { success: true };
  }

  private async assertOwner(userId: string, organizationId: string) {
    const [org] = await this.db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!org) throw new NotFoundException('Organization not found');

    const callerMember = await this.assertMemberRole(organizationId, userId, [
      'owner',
      'admin',
      'member',
    ]);
    if (org.ownerId !== userId && callerMember.role !== 'owner') {
      throw new ForbiddenException(
        'Only the organization owner can perform this action',
      );
    }
    return org;
  }

  /**
   * The session's active organization; api-key sessions carry no
   * activeOrganizationId, so fall back to the user's default membership.
   */
  async getActive(userId: string, activeOrganizationId?: string | null) {
    const orgId =
      activeOrganizationId ?? (await this.defaultOrganizationId(userId));
    if (!orgId) throw new NotFoundException('No active organization');

    const [org] = await this.db
      .select()
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException('No active organization');
    return org;
  }

  /**
   * Invite to the session's active organization (better-auth checks the
   * caller's role).
   *
   * The organization is passed explicitly because better-auth's own resolution
   * cannot see it. `enableSessionForAPIKeys` puts a session on the
   * request context for an api-key caller, but the api-key plugin knows nothing
   * about the organization plugin, so that session carries a user and nothing
   * tenant-shaped — `crud-invites.mjs` falls through to
   * `session.session.activeOrganizationId`, finds none, and answers
   * `400 "Organization not found"`, telling the caller their Organization does
   * not exist when what does not exist is a better-auth session. Cloudgate's
   * own `AuthService.validateApiKey` resolved the tenant from the key owner's
   * default membership before the handler ran; it was reaching only the audit
   * call below.
   *
   * The value must come from the resolved session and never from the request
   * body — there is deliberately no `organizationId` on `InviteMemberDto`,
   * because a caller-supplied tenant id on an invitation route is a tenancy
   * hole. Passing the server-resolved one cannot widen anything: better-auth
   * re-checks the caller's membership and `invitation: create` against whatever
   * id it is given.
   */
  async inviteMember(
    headers: IncomingHttpHeaders,
    data: InviteMemberDto,
    actor: { userId: string; organizationId?: string | null; ip?: string },
  ) {
    const { role } = data;
    // An invitation is always to a person, and better-auth writes the member
    // row it becomes on accept, where `member-role.ts` never sees it — so an
    // agent role is refused here, before the invitation exists.
    assertRoleFitsKind({ kind: 'human' }, role);
    const created = isStaticAssignableRole(role)
      ? await this.createInvitation(
          headers,
          { ...data, role },
          actor.organizationId,
        )
      : await this.createCustomRoleInvitation(headers, data, actor);

    await this.auditLogs.audit(
      {
        userId: actor.userId,
        organizationId: created.organizationId ?? actor.organizationId,
        ip: actor.ip,
      },
      {
        action: 'create',
        resourceType: 'organization',
        resourceId: created.id,
        resourceName: data.email,
        metadata: { type: 'inviteMember', role: data.role },
      },
    );
    return created;
  }

  private createInvitation(
    headers: IncomingHttpHeaders,
    data: InviteMemberDto & { role: 'admin' | 'member' },
    organizationId: string | null | undefined,
  ) {
    return callAuthApi(() =>
      this.auth.api.createInvitation({
        body: { ...data, organizationId: organizationId ?? undefined },
        headers: toWebHeaders(headers),
      }),
    );
  }

  /**
   * An invitation straight onto a custom role, so the invitee is never
   * a `member` on the way there — that grant includes restoring backups and
   * deleting volumes, which a custom role is often created to withhold.
   *
   * better-auth cannot resolve a custom role, so it is asked for a `member`
   * invitation — its own membership, permission, already-invited and team
   * checks run unchanged — and `substituteCustomInvitationRole` writes the row
   * on the custom role instead (`invitation-role.ts` carries why).
   *
   * The role is checked here first with the rules a role change applies. The
   * row is read back after, and an invitation that somehow landed on anything
   * but the role asked for is withdrawn rather than left pending: a `member`
   * invitation is exactly the state this exists to prevent.
   */
  private async createCustomRoleInvitation(
    headers: IncomingHttpHeaders,
    data: InviteMemberDto,
    actor: { userId: string; organizationId?: string | null },
  ) {
    const orgId =
      actor.organizationId ?? (await this.defaultOrganizationId(actor.userId));
    if (!orgId) throw new NotFoundException('No active organization');
    await this.assertAssignableRole(orgId, data.role);

    const created = await customInvitationRole.run(data.role, () =>
      this.createInvitation(headers, { ...data, role: 'member' }, orgId),
    );
    if (created.role !== data.role) {
      await this.db.delete(invitation).where(eq(invitation.id, created.id));
      throw new InternalServerErrorException(
        `The invitation was not created on the custom role "${data.role}", so it was withdrawn`,
      );
    }
    return created;
  }

  /** Accepting adds the signed-in invitee as a member with the invitation's role. */
  acceptInvitation(headers: IncomingHttpHeaders, invitationId: string) {
    return callAuthApi(() =>
      this.auth.api.acceptInvitation({
        body: { invitationId },
        headers: toWebHeaders(headers),
      }),
    );
  }

  /**
   * Why the invitation cannot be acted on, as one code the invitee's landing
   * page can key on. Served to the recipient only — this is their own
   * invitation being read back, and it is not membership of the organization
   * that entitles them to it (they have none yet, and no active organization,
   * so listInvitations is not open to them on this path).
   */
  async readInvitationState(invitationId: string, callerEmail: string) {
    const [invite] = await this.db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .limit(1);

    // Not an error response: withdrawn/never-existed is one of the states the
    // page asks about, so it is an answer rather than a refusal.
    //
    // The second half of that reason has expired and is not restated: this said
    // "the global filter would drop the code from an exception body", which was
    // true until H-26 gave `AllExceptionsFilter` an optional `code`. It is no
    // longer an argument for a 200 — but a 200 is still right here for the
    // reason above, and the refusal below now publishes its code like any other.
    if (!invite) {
      return {
        id: invitationId,
        code: 'INVITATION_NOT_FOUND',
        status: null,
        expiresAt: null,
      };
    }

    if (invite.email.toLowerCase() !== callerEmail.toLowerCase()) {
      // The same refusal `acceptInvitation` gets from better-auth, hand-rolled
      // because this route is Cloudgate's own — so it publishes better-auth's
      // spelling of it rather than a second one (H-36, the argument `ban.ts`
      // makes for `BANNED_CODE`). Without the code it was a bare 403 carrying
      // English that happens to match better-auth's, which is the shape the
      // console is no longer allowed to recognise: `/accept` and `/state` refuse
      // the wrong person for one reason and must say so in one word.
      //
      // `HttpException`'s object form rather than `ForbiddenException`, which
      // takes its `description` as `error` and has no way to add a field.
      throw new HttpException(
        {
          message: 'You are not the recipient of the invitation',
          code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return {
      id: invitationId,
      code: invitationStateCode(invite),
      status: invite.status,
      expiresAt: invite.expiresAt,
    };
  }

  /** All invitations of the active organization, pending first. */
  async listInvitations(userId: string, activeOrganizationId?: string | null) {
    const orgId =
      activeOrganizationId ?? (await this.defaultOrganizationId(userId));
    if (!orgId) throw new NotFoundException('No active organization');

    return this.db
      .select()
      .from(invitation)
      .where(eq(invitation.organizationId, orgId))
      .orderBy(desc(invitation.status), desc(invitation.expiresAt));
  }

  /**
   * Members of the active organization, with their user records.
   *
   * `organizationId` is passed for the same reason as on {@link inviteMember}:
   * without it an api-key caller answered `400 "No active
   * organization"` where a cookie answered 200, because better-auth resolves
   * the tenant from its own session store. It is the resolved session's value,
   * never anything the caller sent, and better-auth still refuses a caller who
   * is not a member of the id it is given.
   */
  async listMembers(
    headers: IncomingHttpHeaders,
    organizationId?: string | null,
  ) {
    const answer = await callAuthApi(() =>
      this.auth.api.listMembers({
        query: organizationId ? { organizationId } : undefined,
        headers: toWebHeaders(headers),
      }),
    );

    // The three `accessed*` columns are Cloudgate's, not better-auth's, and the
    // member model declares no `additionalFields` for them (`auth.config.ts`
    // declares them on `user` only) — so better-auth does not select them and
    // this route answered without them, while `Member` in the console's own
    // contract declares all three as required because `GET /organizations`
    // *does* carry them. The write route for these columns came with no
    // read, which is how the gap stayed invisible: nothing rendered them.
    //
    // It surfaced as a crash rather than as a wrong screen, which was the lucky
    // half. The console's dialog seeds itself from this response and sends
    // **whole sets** back — an absent column read as an empty grant would have
    // seeded every box unticked and saved that, revoking on open every grant
    // the Member had. Filled here rather than defended against in the dialog,
    // so the contract the console was already written against becomes true.
    //
    // `user.lastName` is the same gap on the joined user: better-auth
    // joins `id`, `name`, `email` and `image` and nothing it did not define, so
    // the console named every member by first name alone. It is read in the
    // same query, off the member's own `userId`.
    //
    // So is the ban: a member deactivated over SCIM was listed exactly
    // like an active one, because none of the four joined fields says so. It
    // travels as `deactivation` — see {@link memberDeactivation} — rather than
    // as the user's raw columns, so the console reads a decision instead of
    // re-deriving one.
    const rows = answer?.members;
    if (!Array.isArray(rows) || rows.length === 0) return answer;

    const grants = await this.db
      .select({
        id: member.id,
        accessedProjects: member.accessedProjects,
        accessedEnvironments: member.accessedEnvironments,
        accessedServices: member.accessedServices,
        lastName: user.lastName,
        banned: user.banned,
        banReason: user.banReason,
        banExpires: user.banExpires,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        inArray(
          member.id,
          rows.map((row: { id: string }) => row.id),
        ),
      );
    const byId = new Map(grants.map((row) => [row.id, row]));

    return {
      ...answer,
      members: rows.map((row: { id: string; user: object }) => ({
        ...row,
        user: { ...row.user, lastName: byId.get(row.id)?.lastName ?? '' },
        accessedProjects: byId.get(row.id)?.accessedProjects ?? [],
        accessedEnvironments: byId.get(row.id)?.accessedEnvironments ?? [],
        accessedServices: byId.get(row.id)?.accessedServices ?? [],
        deactivation: memberDeactivation(byId.get(row.id)),
      })),
    };
  }

  /**
   * Only owner/admin may change roles, never their own, never to or from
   * owner, and admins cannot change other admins. The role is either static
   * (admin/member) or a custom role the organization has defined — anything
   * else is unknown.
   *
   * A custom role also needs a valid enterprise license, the same one
   * `CustomRolesService.ensureEnterprise` asks for.
   * Without it the assignment would succeed into a state where the member is
   * denied everything.
   *
   * The write itself is `member-role.ts`'s, the one writer of `member.role`:
   * it keeps an Agent on `agentReader`/`agentOperator` and a person
   * off both, so this route moves an Agent between the agent roles and nowhere
   * else. The rules above run first and still apply to an Agent — an admin
   * may change an Agent's role, since an Agent is never an admin.
   */
  async updateMemberRole(
    userId: string,
    activeOrganizationId: string | null | undefined,
    memberId: string,
    role: string,
    ip?: string,
  ) {
    const [target] = await this.db
      .select()
      .from(member)
      .where(eq(member.id, memberId))
      .limit(1);
    if (!target) throw new NotFoundException('Member not found');

    const orgId =
      activeOrganizationId ?? (await this.defaultOrganizationId(userId));
    if (target.organizationId !== orgId) {
      throw new ForbiddenException(
        "You are not allowed to update this member's role",
      );
    }

    const caller = await this.assertMemberRole(orgId, userId, [
      'owner',
      'admin',
    ]);
    if (target.userId === userId) {
      throw new ForbiddenException('You cannot change your own role');
    }
    if (target.role === 'owner' || role === 'owner') {
      throw new ForbiddenException('The owner role is nontransferable');
    }
    if (caller.role === 'admin' && target.role === 'admin') {
      throw new ForbiddenException(
        'Only the organization owner can change admin roles',
      );
    }

    await this.assertAssignableRole(orgId, role);

    const [updated] = await writeMemberRole(
      this.db,
      eq(member.id, memberId),
      role,
    );

    await this.auditLogs.audit(
      { userId, organizationId: orgId, ip },
      {
        action: 'update',
        resourceType: 'user',
        resourceId: target.userId,
        resourceName: await this.emailOf(target.userId),
        metadata: { before: target.role, after: role },
      },
    );
    return updated;
  }

  /**
   * A role a member may be put on — by a role change or by an invitation.
   * Static admin/member always are; anything else must name a custom
   * role this organization has defined, or the member would resolve to no role
   * at all.
   *
   * Existing is not enough. Custom roles are enterprise-only, so without
   * a license PermissionService cannot resolve one — the assignment would not
   * narrow what the member can do, it would refuse them every
   * permission-checked route including the ones the role explicitly grants.
   * `organization_role` rows survive a license lapsing and only the
   * *mutations* on custom-role.controller.ts are gated, so the role picker can
   * be full of names in exactly that state.
   */
  private async assertAssignableRole(orgId: string, role: string) {
    // The agent roles are static and unlicensed; whether *this* member may
    // hold one is the writer's question, not this one's.
    if (isStaticAssignableRole(role) || isAgentRole(role)) return;
    // better-auth reads a comma as two roles, and the member, invitation and
    // team routes delegate to its check — so a comma-named row written before
    // `roleNameSchema` refused one is never newly handed out.
    if (role.includes(',')) {
      throw new BadRequestException('A role name cannot contain a comma');
    }

    const [customRole] = await this.db
      .select({ id: organizationRole.id })
      .from(organizationRole)
      .where(
        and(
          eq(organizationRole.organizationId, orgId),
          eq(organizationRole.role, role),
        ),
      )
      .limit(1);
    if (!customRole) {
      throw new NotFoundException(`Custom role "${role}" not found`);
    }

    const licensed = await this.license.hasValidLicense(orgId);
    if (!licensed) {
      throw new ForbiddenException(
        `Assigning the custom role "${role}" needs a valid enterprise license. Without one Cloudgate cannot resolve it, so the member would be refused every permission-checked action rather than narrowed to what the role grants.`,
      );
    }
  }

  /**
   * Writes a member's row-level grants, the half of member management
   * `PATCH /organizations/members/:id` (the role) does not cover. The grants
   * had no write route at all, so on a real instance every Member was a
   * zero-service Member and nothing could grant them one.
   *
   * A sibling route rather than a wider `UpdateMemberRoleDto`: the existing
   * DTO's `role` is required and widening it would change a contract the
   * console depends on, and `PATCH :id/entitlements` is §2.2's
   * nested-off-the-id shape.
   *
   * Who may call it. Owner or admin **of the caller's own active
   * Organization** — the same assertion the role route makes, because handing
   * out entitlement is delegating authorization and is at least as strong as a
   * role change. `@RequirePermission('member', 'update')` on the route declares
   * the permission and refuses a base Member before the handler runs
   * (`memberRole` has `member: []`); this assertion is the gate, so a licensed
   * custom role holding `member: update` is refused here for exactly the reason
   * it cannot change a role either. Nobody grants themselves anything: a Member
   * cannot reach the route at all.
   *
   * The target is looked up **scoped to the caller's Organization**, so a
   * member id belonging to another Organization reads as `Member not found`
   * rather than as a refusal that confirms it exists (§2.2). The role check runs
   * first for the same reason — an unauthorized caller learns nothing about
   * which member ids are real.
   */
  async updateMemberEntitlements(
    userId: string,
    activeOrganizationId: string | null | undefined,
    memberId: string,
    grants: UpdateMemberEntitlementsDto,
    ip?: string,
  ) {
    const orgId =
      activeOrganizationId ?? (await this.defaultOrganizationId(userId));
    if (!orgId) throw new NotFoundException('No active organization');

    await this.assertMemberRole(orgId, userId, ['owner', 'admin']);

    const [target] = await this.db
      .select()
      .from(member)
      .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)))
      .limit(1);
    if (!target) throw new NotFoundException('Member not found');

    const updated = await this.permissions.setMemberEntitlements(
      orgId,
      memberId,
      grants,
    );

    await this.auditLogs.audit(
      { userId, organizationId: orgId, ip },
      {
        action: 'update',
        resourceType: 'user',
        resourceId: target.userId,
        resourceName: await this.emailOf(target.userId),
        metadata: {
          type: 'updateMemberEntitlements',
          // Both sides, because a replace can revoke as easily as it grants and
          // the entry is the only record of what was taken away.
          before: {
            accessedProjects: target.accessedProjects,
            accessedEnvironments: target.accessedEnvironments,
            accessedServices: target.accessedServices,
          },
          after: {
            accessedProjects: updated.accessedProjects,
            accessedEnvironments: updated.accessedEnvironments,
            accessedServices: updated.accessedServices,
          },
        },
      },
    );
    return updated;
  }

  /**
   * Removes a member from the active organization (better-auth guards owner
   * removal).
   *
   * Carries the resolved organization for this reason: an api-key caller was
   * refused `400 "No active organization"` before the member lookup ran, which
   * is why a bogus id answered that instead of the cookie session's `Member not
   * found`. The two bodies were the tell.
   */
  async removeMember(
    headers: IncomingHttpHeaders,
    memberId: string,
    actor: { userId: string; organizationId?: string | null; ip?: string },
  ) {
    // Read before the removal — afterwards there is no member row to resolve
    // the removed user from.
    const [target] = await this.db
      .select()
      .from(member)
      .where(eq(member.id, memberId))
      .limit(1);

    const result = await callAuthApi(() =>
      this.auth.api.removeMember({
        body: {
          memberIdOrEmail: memberId,
          organizationId: actor.organizationId ?? undefined,
        },
        headers: toWebHeaders(headers),
      }),
    );

    if (target) {
      await this.auditLogs.audit(
        {
          userId: actor.userId,
          organizationId: target.organizationId,
          ip: actor.ip,
        },
        {
          action: 'delete',
          resourceType: 'user',
          resourceId: target.userId,
          // The email alongside the id is what makes the entry readable once
          // the user is gone.
          resourceName: await this.emailOf(target.userId),
        },
      );
    }
    return result;
  }

  private async emailOf(userId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.email;
  }

  /*
   * The six routes below all carry `organizationId`, and all six carry it for
   * the one reason recorded on {@link inviteMember}: better-auth resolves
   * the tenant from *its own* session store, which has never heard of the
   * synthetic session `AuthService.validateApiKey` builds for an api key. Each
   * of the six read `ctx.body/query…organizationId || session.session
   * .activeOrganizationId` and, finding neither, answered
   * `400 "No active organization"` — telling an api-key caller their
   * Organization does not exist when what did not exist was a better-auth
   * session.
   *
   * The outcome chosen for every one of the six is **the key works**, not a
   * `403` naming the credential. A refusal is the right answer only
   * where better-auth cannot be told the tenant; all six accept an explicit
   * organization id, and none of them sits behind `sensitiveSessionMiddleware`.
   *
   * The id is always the resolved session's and never anything the caller
   * sent — there is deliberately no `organizationId` on `CreateTeamDto` or
   * `AddTeamMemberDto`, for the reason `inviteMember`'s block gives. Passing it
   * cannot widen anything: better-auth re-resolves the caller's membership of
   * whatever id it is handed and re-checks the team permission against it, then
   * looks the team up scoped to that id. It is spelled `?? undefined` because a
   * `null` would fail better-auth's `z.string().optional()`.
   *
   * They were left out of the invitation fix because those three routes had
   * been driven and these six had not, and because the id does not go in the
   * same place on all six — `listTeams` takes a query and `updateTeam` takes it
   * nested inside `data`. Each is noted where it differs.
   */

  createTeam(
    headers: IncomingHttpHeaders,
    name: string,
    organizationId?: string | null,
  ) {
    return callAuthApi(() =>
      this.auth.api.createTeam({
        body: { name, organizationId: organizationId ?? undefined },
        headers: toWebHeaders(headers),
      }),
    );
  }

  /**
   * The tenant goes in the **query**, not the body — `list-teams` is a GET, and
   * this is the shape {@link listMembers} already uses.
   */
  listTeams(headers: IncomingHttpHeaders, organizationId?: string | null) {
    return callAuthApi(() =>
      this.auth.api.listOrganizationTeams({
        query: organizationId ? { organizationId } : undefined,
        headers: toWebHeaders(headers),
      }),
    );
  }

  addTeamMember(
    headers: IncomingHttpHeaders,
    teamId: string,
    userId: string,
    organizationId?: string | null,
  ) {
    return callAuthApi(() =>
      this.auth.api.addTeamMember({
        body: { teamId, userId, organizationId: organizationId ?? undefined },
        headers: toWebHeaders(headers),
      }),
    );
  }

  /**
   * The counterpart to addTeamMember, so a mistaken add can be undone without
   * deleting the whole team. better-auth checks the caller's `member: delete`
   * permission and that both the team and the target's membership exist.
   */
  removeTeamMember(
    headers: IncomingHttpHeaders,
    teamId: string,
    userId: string,
    organizationId?: string | null,
  ) {
    return callAuthApi(() =>
      this.auth.api.removeTeamMember({
        body: { teamId, userId, organizationId: organizationId ?? undefined },
        headers: toWebHeaders(headers),
      }),
    );
  }

  /**
   * The tenant goes **inside `data`**, beside `name`, because that is where
   * `update-team` reads it. `data` is `teamSchema.partial()`, so it would also
   * admit `id`, `createdAt` and `updatedAt` — and better-auth destructures only
   * `name` and `organizationId` back out and spreads the remainder onto the
   * row. So exactly `{ name, organizationId }` is sent and nothing more; the id
   * is never written to the team.
   */
  updateTeam(
    headers: IncomingHttpHeaders,
    teamId: string,
    name: string,
    organizationId?: string | null,
  ) {
    return callAuthApi(() =>
      this.auth.api.updateTeam({
        body: {
          teamId,
          data: { name, organizationId: organizationId ?? undefined },
        },
        headers: toWebHeaders(headers),
      }),
    );
  }

  removeTeam(
    headers: IncomingHttpHeaders,
    teamId: string,
    organizationId?: string | null,
  ) {
    return callAuthApi(() =>
      this.auth.api.removeTeam({
        body: { teamId, organizationId: organizationId ?? undefined },
        headers: toWebHeaders(headers),
      }),
    );
  }

  /**
   * Hand-rolled: better-auth's list-team-members only serves members of the
   * team itself, but org members must be able to inspect any of their teams.
   */
  async listTeamMembers(userId: string, teamId: string) {
    const [targetTeam] = await this.db
      .select()
      .from(team)
      .where(eq(team.id, teamId))
      .limit(1);
    if (!targetTeam) throw new NotFoundException('Team not found');

    await this.assertMemberRole(targetTeam.organizationId, userId, [
      'owner',
      'admin',
      'member',
    ]);

    return this.db
      .select()
      .from(teamMember)
      .where(eq(teamMember.teamId, teamId));
  }

  /** Deletes an invitation of the active organization; owner or admin only. */
  async removeInvitation(
    userId: string,
    activeOrganizationId: string | null | undefined,
    invitationId: string,
    ip?: string,
  ) {
    const [invite] = await this.db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .limit(1);
    if (!invite) throw new NotFoundException('Invitation not found');

    const orgId =
      activeOrganizationId ?? (await this.defaultOrganizationId(userId));
    if (invite.organizationId !== orgId) {
      throw new ForbiddenException(
        'You are not allowed to remove this invitation',
      );
    }
    await this.assertMemberRole(orgId, userId, ['owner', 'admin']);

    await this.db.delete(invitation).where(eq(invitation.id, invitationId));

    await this.auditLogs.audit(
      { userId, organizationId: orgId, ip },
      {
        action: 'delete',
        resourceType: 'organization',
        resourceId: invitationId,
        resourceName: invite.email,
        metadata: { type: 'removeInvitation' },
      },
    );
    return { success: true };
  }

  private async assertMemberRole(
    organizationId: string,
    userId: string,
    roles: string[],
  ) {
    const [callerMember] = await this.db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .limit(1);
    if (!callerMember || !roles.includes(callerMember.role)) {
      throw new ForbiddenException(
        'You are not allowed to perform this action',
      );
    }
    return callerMember;
  }

  private async defaultOrganizationId(userId: string) {
    const [defaultMember] = await this.db
      .select()
      .from(member)
      .where(eq(member.userId, userId))
      .orderBy(desc(member.isDefault), desc(member.createdAt))
      .limit(1);
    return defaultMember?.organizationId ?? null;
  }
}
