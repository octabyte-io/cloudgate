import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  enterpriseOnlyResources,
  internalResources,
  statements,
} from '../../rbac/access-control';
import { LicenseService } from '../license/license.service';
import { paidFeatureRefusal } from '../license/paid-features';
import { user } from '../../auth/auth.schema';
import { member } from '../../organizations/organizations.schema';
import { writeMemberRole } from '../../rbac/member-role';
import { PermissionService, staticRoles } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { organizationRole } from './custom-role.schema';
import type { OrganizationRole, RolePermissions } from './custom-role.schema';

/**
 * The built-in roles from Phase 06 — their grants are code, not data. Exported
 * because "holds a custom role" is defined as "holds none of these", which is
 * what the lapse check has to ask.
 *
 * Read off {@link staticRoles} rather than restated: the same names
 * `PermissionService.resolveRole` answers from, in the same order, so "built-in"
 * cannot come to mean two different things in two files.
 */
export const STATIC_ROLES = Object.keys(staticRoles);

/**
 * Everything the console needs to answer "what is this role allowed to do", in
 * one read.
 *
 * **Three of these four fields were transcriptions of backend source kept in
 * `frontend/src/lib/api/endpoints/roles.ts` by hand**, and the transcription had
 * drifted in both directions, one issue each. One found `STATIC_ROLE_PERMISSIONS`
 * stale by omission — `service`, `environment` and `project` gained `update` in
 * earlier changes and none of the three arrived, so the roles screen showed an
 * owner as unable to rewrite a Service. The other found the other direction,
 * which is worse because nothing on screen can betray it: the grid iterates
 * {@link statements}, so an entry for a statement that no longer exists renders
 * nowhere and reads as correct forever. Three were sitting there.
 *
 * `use-permission.ts` answers real questions from all three, so a stale entry is
 * a **wrong answer** to "may this caller do this" rather than dead data.
 *
 * **Nothing here is a fourth copy.** `staticRoles`' values are the `ac.newRole`
 * results `checkPermission` authorizes against, and better-auth's `role()` keeps
 * its argument as `.statements` — so the grants served are the ones enforced, by
 * construction rather than by a test. `enterpriseOnlyResources` and
 * `internalResources` are the sets `checkPermission` and `validatePermissions`
 * themselves consult.
 */
export interface RoleVocabulary {
  /** `rbac/access-control.ts`'s `statements`, verbatim: resource → its actions. */
  statements: Record<string, readonly string[]>;
  /** owner / admin / member and the agent roles → the grants each holds. */
  staticRoles: Record<string, Record<string, readonly string[]>>;
  /** The resources `checkPermission` does not check for a static role at all. */
  enterpriseOnlyResources: string[];
  /** The resources {@link validatePermissions} refuses in a custom role. */
  internalResources: string[];
}

/** A member holding a role, as `membersByRole` exposes them. */
export interface RoleMember {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** One role as the listing exposes it — rows sharing a name are merged. */
export interface CustomRoleSummary {
  role: string;
  permissions: RolePermissions;
  createdAt: Date;
  ids: string[];
  memberCount: number;
}

/**
 * Custom roles: per-organization named grant maps that members can hold in
 * place of a built-in role.
 */
@Injectable()
export class CustomRolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly license: LicenseService,
    private readonly permissions: PermissionService,
    private readonly auditLogs: AuditLogService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * Owner or admin, on any plan: the gate deleting a role rides
   * (ADR-0054). Below the paid features the roles are kept and allow nothing,
   * and removing one is always allowed.
   */
  private async ensureManager(ctx: PermissionCtx): Promise<void> {
    const memberRecord = await this.permissions.findMember(ctx);
    if (memberRecord.role !== 'owner' && memberRecord.role !== 'admin') {
      throw new ForbiddenException('Only owners and admins can manage roles');
    }
  }

  /**
   * The gate creating and editing ride: an owner/admin caller and an
   * organization holding a valid enterprise license.
   *
   * The role checked is the caller's role in the organization, not the admin
   * plugin's global user role, which on a self-hosted instance is always 'user'
   * (the same in-service owner/admin check the settings and ai modules use).
   */
  private async ensureEnterprise(ctx: PermissionCtx): Promise<void> {
    await this.ensureManager(ctx);

    const licensed = await this.license.hasValidLicense(
      ctx.session.activeOrganizationId,
    );
    // The license key self-hosted, Business or Enterprise hosted.
    if (!licensed) throw paidFeatureRefusal(this.instanceMode);
  }

  /**
   * Every role in the organization with the number of members holding it.
   * Rows sharing a role name are merged into one entry, their grants unioned
   * per resource.
   */
  async findAll(ctx: PermissionCtx): Promise<CustomRoleSummary[]> {
    const organizationId = ctx.session.activeOrganizationId;
    const [roles, memberCounts] = await Promise.all([
      this.db
        .select()
        .from(organizationRole)
        .where(eq(organizationRole.organizationId, organizationId)),
      this.db
        .select({ role: member.role, count: count() })
        .from(member)
        .where(eq(member.organizationId, organizationId))
        .groupBy(member.role),
    ]);

    const memberCountByRole = new Map(
      memberCounts.map((row) => [row.role, row.count]),
    );

    const roleMap = new Map<string, CustomRoleSummary>();
    for (const entry of roles) {
      const existing = roleMap.get(entry.role);
      if (existing) {
        for (const [resource, actions] of Object.entries(entry.permission)) {
          existing.permissions[resource] = [
            ...new Set([...(existing.permissions[resource] ?? []), ...actions]),
          ];
        }
        existing.ids.push(entry.id);
      } else {
        roleMap.set(entry.role, {
          role: entry.role,
          permissions: entry.permission,
          createdAt: entry.createdAt,
          ids: [entry.id],
          memberCount: memberCountByRole.get(entry.role) ?? 0,
        });
      }
    }

    return Array.from(roleMap.values());
  }

  /**
   * Creates a role: at most ten distinct role names per organization, each name
   * taken once.
   */
  async create(
    ctx: PermissionCtx,
    data: { roleName: string; permissions: RolePermissions },
    ip?: string,
  ): Promise<OrganizationRole> {
    await this.ensureEnterprise(ctx);

    const existingNames = await this.roleNames(
      ctx.session.activeOrganizationId,
    );
    if (existingNames.size >= 10) {
      throw new BadRequestException(
        'Maximum of 10 custom roles per organization reached',
      );
    }
    if (existingNames.has(data.roleName)) {
      throw new ConflictException(`Role "${data.roleName}" already exists`);
    }

    validatePermissions(data.permissions);
    const [created] = await this.db
      .insert(organizationRole)
      .values({
        organizationId: ctx.session.activeOrganizationId,
        role: data.roleName,
        permission: data.permissions,
      })
      .returning();

    await this.audit(ctx, ip, {
      action: 'create',
      resourceName: data.roleName,
      resourceId: created.id,
    });
    return created;
  }

  /** Replaces a role's grants, optionally renaming it. */
  async update(
    ctx: PermissionCtx,
    data: {
      roleName: string;
      newRoleName?: string;
      permissions: RolePermissions;
    },
    ip?: string,
  ): Promise<OrganizationRole> {
    await this.ensureEnterprise(ctx);
    const organizationId = ctx.session.activeOrganizationId;

    if (STATIC_ROLES.includes(data.roleName)) {
      throw new BadRequestException('Cannot modify built-in roles');
    }

    if (data.newRoleName && data.newRoleName !== data.roleName) {
      const existingNames = await this.roleNames(organizationId);
      if (existingNames.has(data.newRoleName)) {
        throw new ConflictException(
          `Role "${data.newRoleName}" already exists`,
        );
      }
    }

    // Everything that can fail runs before the first write: moving the member
    // rows and then rejecting the grant map would leave everyone pointing at a
    // role name no row carries — they would resolve to no role at all.
    validatePermissions(data.permissions);

    // One transaction, because the member rows move through `member-role.ts`,
    // the one writer of `member.role`, and it can refuse: a rename onto
    // an agent role's name would put people on a role only an Agent holds. A
    // refusal then takes the role row's rename back with it rather than
    // leaving the role renamed and its holders on the old name.
    const updated = await this.db.transaction(async (tx) => {
      const [renamed] = await tx
        .update(organizationRole)
        .set({
          role: data.newRoleName ?? data.roleName,
          permission: data.permissions,
        })
        .where(
          and(
            eq(organizationRole.organizationId, organizationId),
            eq(organizationRole.role, data.roleName),
          ),
        )
        .returning();

      // A role name that does not exist is a 404, as it is in `remove` — not
      // a 200 with an empty body and an audit entry for a change that never
      // happened.
      if (!renamed) {
        throw new NotFoundException(`Role "${data.roleName}" not found`);
      }

      if (data.newRoleName && data.newRoleName !== data.roleName) {
        // The role name is the join key on member.role, so a rename has to
        // move everyone holding it or they would resolve to no role at all.
        await writeMemberRole(
          tx,
          and(
            eq(member.organizationId, organizationId),
            eq(member.role, data.roleName),
          ),
          data.newRoleName,
        );
      }
      return renamed;
    });

    await this.audit(ctx, ip, {
      action: 'update',
      resourceName: data.newRoleName ?? data.roleName,
      resourceId: updated.id,
    });
    return updated;
  }

  /** Deletes a role; it can only be deleted once nobody holds it. */
  async remove(
    ctx: PermissionCtx,
    roleName: string,
    ip?: string,
  ): Promise<{ deleted: number }> {
    await this.ensureManager(ctx);
    const organizationId = ctx.session.activeOrganizationId;

    if (STATIC_ROLES.includes(roleName)) {
      throw new BadRequestException('Cannot delete built-in roles');
    }

    const assignedMembers = await this.db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.role, roleName),
        ),
      );
    if (assignedMembers.length > 0) {
      throw new BadRequestException(
        `Cannot delete role "${roleName}": ${assignedMembers.length} member(s) are currently assigned to it. Reassign them first.`,
      );
    }

    const deleted = await this.db
      .delete(organizationRole)
      .where(
        and(
          eq(organizationRole.organizationId, organizationId),
          eq(organizationRole.role, roleName),
        ),
      )
      .returning();

    if (deleted.length === 0) {
      throw new NotFoundException(`Role "${roleName}" not found`);
    }

    await this.audit(ctx, ip, { action: 'delete', resourceName: roleName });
    return { deleted: deleted.length };
  }

  /**
   * Who currently holds a role. Open to any member of the organization, like
   * the listing.
   */
  async membersByRole(
    ctx: PermissionCtx,
    roleName: string,
  ): Promise<RoleMember[]> {
    return this.db
      .select({
        id: member.id,
        userId: member.userId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(
          eq(member.organizationId, ctx.session.activeOrganizationId),
          eq(member.role, roleName),
        ),
      );
  }

  /**
   * The resource→actions catalogue a custom role's grants are drawn from, so a
   * client can offer only valid combinations — plus the three
   * constants a reader needs to interpret it.
   *
   * **A second, third and fourth field on this response rather than sibling
   * routes**, and the route keeps its path. Four screens read this
   * (`RolesCard`, `RolePreview` through `ChangeRoleModal`, `RolesSection` and
   * `RoleBuilderModal`) and every one of them needs the catalogue *and* at least
   * one of the annotations in the same paint: `PermissionGrid` renders a row per
   * statement and marks it "managed by Cloudgate" or "not checked for the
   * built-in roles" from the other two sets. Splitting them across requests
   * would put a second terminal-state order (§3.5: `error` → `isPending` →
   * `empty`) in front of one grid and let its rows come from a different read
   * than its annotations, which is how a grid ends up rendered against a stale
   * catalogue. They are also one thing: constants of the running build, not rows,
   * which is why the console's key for this sits under `instance` and why
   * `staleTime: Infinity` is honest — and a second route would need a second key
   * making the same claim.
   *
   * Renaming the path to match the widened payload was the alternative and is
   * rejected: it changes the contract and the OpenAPI document's `operationId`
   * to buy a tidier noun, for a 200 the document does not describe either way
   * (§2.11 reflects request DTOs, and this GET has no request). The path names
   * the subject of the read; the response is that subject plus what it means.
   *
   * **No DTO, and that is §2.4 read rather than skirted.** A `createZodDto` is a
   * *request* shape for the one global pipe to validate; there is no request
   * here. What the route lacked — and part of why nothing
   * noticed the drift — is a declared *response*, and the house form for that is
   * an exported service interface, as `CustomRoleSummary` above already is.
   * {@link RoleVocabulary} is it, and the frontend's `RoleVocabulary` in
   * `endpoints/roles.ts` is its counterpart (§3.5: the endpoint modules are
   * hand-written and `openapi.json` is not the frontend's type source).
   */
  getStatements(): RoleVocabulary {
    return {
      statements,
      staticRoles: Object.fromEntries(
        Object.entries(staticRoles).map(([name, role]) => [
          name,
          role.statements,
        ]),
      ),
      enterpriseOnlyResources: [...enterpriseOnlyResources],
      internalResources: [...internalResources],
    };
  }

  /** Every role mutation lands in the audit trail, attributed to the caller. */
  private audit(
    ctx: PermissionCtx,
    ip: string | undefined,
    event: {
      action: 'create' | 'update' | 'delete';
      resourceName: string;
      resourceId?: string;
    },
  ): Promise<string | null> {
    return this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
        ip,
      },
      { ...event, resourceType: 'customRole' },
    );
  }

  /** The distinct role names defined in an organization. */
  private async roleNames(organizationId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ role: organizationRole.role })
      .from(organizationRole)
      .where(eq(organizationRole.organizationId, organizationId));
    return new Set(rows.map((row) => row.role));
  }
}

/**
 * Every resource must be a known statement that isn't internally managed, and
 * every action must belong to it.
 */
function validatePermissions(permissions: RolePermissions): void {
  for (const [resource, actions] of Object.entries(permissions)) {
    if (internalResources.includes(resource)) {
      throw new BadRequestException(
        `Resource "${resource}" is managed internally and cannot be assigned to custom roles`,
      );
    }

    if (!(resource in statements)) {
      throw new BadRequestException(`Unknown resource: ${resource}`);
    }

    const validActions: readonly string[] =
      statements[resource as keyof typeof statements];
    for (const action of actions) {
      if (!validActions.includes(action)) {
        throw new BadRequestException(
          `Invalid action "${action}" for resource "${resource}". Valid actions: ${validActions.join(', ')}`,
        );
      }
    }
  }
}
