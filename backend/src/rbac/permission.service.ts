import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { isAgentUser } from '../auth/user-kind';
import {
  environment,
  member,
  organizationRole,
  project,
  user,
} from '../db/schema';
import { serviceScope } from '../deployments/service-scope';
import { readInstanceOrganizationPin } from './instance-organization-pin';
import {
  ac,
  adminRole,
  agentOperatorRole,
  agentCallerRole,
  agentReaderRole,
  enterpriseOnlyResources,
  internalResources,
  memberRole,
  ownerRole,
  statements,
} from './access-control';
import { LicenseService } from '../enterprise/license/license.service';
import { customRoleRefusal } from '../enterprise/license/paid-features';
import { InstanceMode } from '../instance-mode/instance-mode.service';

type Statements = typeof statements;
type Resource = keyof Statements;
type Action<R extends Resource> = Statements[R][number];

export type Permissions = {
  [R in Resource]?: Action<R>[];
};

/** The caller identity a permission check runs against (request.user/session). */
export type PermissionCtx = {
  user: { id: string };
  session: { activeOrganizationId: string };
};

/** The member row's row-level grant columns. */
type AccessColumn =
  'accessedProjects' | 'accessedServices' | 'accessedEnvironments';

/**
 * The grants to write on one member row. An absent key leaves that column
 * alone; an empty array clears it. Structurally what
 * `UpdateMemberEntitlementsDto` validates, named here because this service owns
 * the columns and the checks that read them.
 */
export type MemberEntitlements = Partial<Record<AccessColumn, string[]>>;

/** Every grant column, as a new member row holds them: an absent one is empty. */
export function fullEntitlements(
  grants: MemberEntitlements,
): Required<MemberEntitlements> {
  return {
    accessedProjects: grants.accessedProjects ?? [],
    accessedEnvironments: grants.accessedEnvironments ?? [],
    accessedServices: grants.accessedServices ?? [],
  };
}

/** Which resource a rejected grant id was supposed to name, for the refusal. */
const GRANT_ENTITY: Record<AccessColumn, string> = {
  accessedProjects: 'Project',
  accessedEnvironments: 'Environment',
  accessedServices: 'Service',
};

/**
 * The codes a row-level refusal publishes: the member row does not name this
 * Project, Environment or Service.
 *
 * The role's refusal and this one were both a bare 403, and the console has
 * one sentence for an uncoded 403 — *"Your role in this Organization does not
 * allow this … or to change your role"*. So a member whose role granted
 * `service: ['read']` and who had simply not been given the Service was sent
 * to ask for a role change, whose only working form is a promotion to admin,
 * instead of to Members → Manage access. A code rather than the sentence
 * because the console keys on codes and never on English (`AllExceptionsFilter`'s
 * `code`, H-26), and three rather than one because the sentence names the
 * subject that was not granted.
 *
 * **Not an oracle.** The row-level branch tests `includes(id)` on the caller's
 * own member row and never looks the id up, so an id nobody owns and one the
 * caller was not given still answer the same body, code and all
 * (`test/rbac/rbac.e2e-spec.ts` pins the pair). What the code tells a caller is
 * which of their *own* two entitlements is missing, which they are owed.
 *
 * The role's refusal (`checkPermission`) publishes none of these, and a caller
 * with no member row in the active Organization (`findMember`) publishes
 * {@link NOT_A_MEMBER_CODE} instead.
 */
export const ACCESS_NOT_GRANTED_CODE: Record<AccessColumn, string> = {
  accessedProjects: 'PROJECT_ACCESS_NOT_GRANTED',
  accessedEnvironments: 'ENVIRONMENT_ACCESS_NOT_GRANTED',
  accessedServices: 'SERVICE_ACCESS_NOT_GRANTED',
};

/**
 * The code a caller with no member row in their active Organization is refused
 * with — somebody removed from it while signed in, whose session still
 * points there.
 *
 * It was the bare `Permission denied` the role's refusal also answers, and the
 * console has one sentence for an uncoded 403, so every screen told a person
 * who was no longer in the Organization to ask for a role change in it. The
 * name is better-auth's own for the same fact
 * (`ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION`), which
 * its member routes already answer this session with — one fact, one code,
 * whichever surface refused, which is the `BANNED_USER` precedent
 * (`auth/ban.ts`). The message is unchanged: the journal and the specs read it.
 */
export const NOT_A_MEMBER_CODE = 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION';

/** A row-level refusal: the message it always had, plus its code. */
/**
 * The row-level half of {@link PermissionService.checkServiceAccess}: an
 * owner or admin reaches every Service of the Organization, anyone else the
 * ones their `accessedServices` names.
 */
function entitledToService(
  memberRecord: { role: string; accessedServices: string[] },
  serviceId: string,
): boolean {
  return (
    memberRecord.role === 'owner' ||
    memberRecord.role === 'admin' ||
    memberRecord.accessedServices.includes(serviceId)
  );
}

function notGranted(column: AccessColumn, message: string) {
  return new ForbiddenException({
    message,
    code: ACCESS_NOT_GRANTED_CODE[column],
  });
}

/**
 * {@link PermissionService.checkInstanceAuthority}'s refusal, written once so
 * the two ways of failing it are indistinguishable to the caller: whether this
 * instance has an owner at all is not a fact an unauthorized caller is owed.
 */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

/**
 * The code {@link INSTANCE_AUTHORITY_REFUSAL} is published with.
 *
 * Uncoded, it was one more bare 403, and the console has one sentence for
 * those: "Ask an owner or an admin to do it, or to change your role" — false
 * here, because the caller may already be their Organization's owner and no
 * role in it grants this. Coded like {@link NOT_A_MEMBER_CODE}, so the console
 * says who can (`frontend/src/lib/auth/auth-error.ts`). The message is
 * unchanged: the journal and the specs read it.
 */
export const INSTANCE_AUTHORITY_REQUIRED_CODE = 'INSTANCE_AUTHORITY_REQUIRED';

type Role = ReturnType<typeof ac.newRole>;

/**
 * The built-in roles by name — their grants are code rather than data.
 *
 * Exported for the second reader: `CustomRolesService`
 * serves each one's grant map off `.statements` (the object `ac.newRole` was
 * handed, kept by better-auth's `role()`) so the console can answer "what can a
 * member do" without transcribing `access-control.ts` — which it did, by hand,
 * and got wrong twice. Keeping a private map here and a second one there would
 * be that drift moved rather than ended, so the resolver and the route read the
 * same objects.
 */
export const staticRoles: Record<string, Role> = {
  owner: ownerRole,
  admin: adminRole,
  member: memberRole,
  // The Agent-only roles. Static, so they resolve with no licence,
  // and in this map rather than beside it so that everything "built-in" means
  // — `STATIC_ROLES`, the lapse check's "holds a custom role", the vocabulary
  // the console renders — counts them without a second list.
  agentReader: agentReaderRole,
  agentOperator: agentOperatorRole,
  agentCaller: agentCallerRole,
};

/**
 * A stored role's grants, split into what a custom role may actually hold and
 * the two kinds of grant that reach `ac.newRole` no longer. See
 * {@link toDeclaredGrants}.
 */
export type DeclaredGrants = {
  /**
   * What reaches `ac.newRole` — every key a declared statement a custom role
   * may be delegated, and every action one that resource declares.
   */
  grants: Record<string, string[]>;
  /**
   * What was left out, as `resource` for an undeclared resource and
   * `resource:action` for an undeclared action of a declared one. Empty for
   * every legitimate role, which is what makes it the log's trigger.
   */
  dropped: string[];
  /**
   * The {@link internalResources} the row granted, by resource name.
   * Reported and remedied separately from {@link dropped}, because an
   * undeclared grant was legal when it was written and one of these never was.
   */
  internal: string[];
};

/**
 * The grants a stored `organization_role` row carries that the vocabulary no
 * longer declares, already reported. Keyed by Organization, role name and the
 * dropped keys, so {@link PermissionService.resolveRole}'s line fires once per
 * stored role per process rather than once per permission check.
 *
 * Bounded by the product rather than by an eviction policy: `CustomRolesService`
 * caps an Organization at ten role names, and a row's dropped set changes only
 * when an operator re-saves the role — at which point `validatePermissions`
 * refuses the undeclared key outright and there is nothing left to report.
 */
const reportedUndeclaredGrants = new Set<string>();

/**
 * The same, for the {@link internalResources} half. Its own set rather
 * than more keys in the one above so that a role carrying both kinds is
 * reported once for each: the two lines name different remedies, and a single
 * set keyed on "everything left out" would have made them one line that has to
 * hedge between them.
 */
const reportedInternalGrants = new Set<string>();

/**
 * A stored role's merged grants, with everything {@link statements} does not
 * declare removed.
 *
 * **What broke first is that nothing here broke.** `resolveRole` handed
 * `ac.newRole` a `Record<string, string[]>` straight off the `organization_role`
 * rows, and better-auth never looks at the catalogue: read at
 * `node_modules/better-auth/dist/plugins/access/access.mjs` in the installed
 * 1.6.33, `createAccessControl(s)` returns `{ newRole: (statements) =>
 * role(statements), statements: s }` — its argument is kept only as its own
 * `.statements` — and `role.authorize` iterates `Object.entries(request)`,
 * looking each **requested** resource up in the role's own grant map. So a
 * stored grant of a retired or misspelled resource resolved without complaint
 * and authorized nothing, silently, and the only trace was a `permission` column
 * nobody reads.
 *
 * That property is load-bearing in the good direction and two sweeps both
 * spent it: five statements have been deleted with no migration precisely
 * because a granted key nothing requests is never read. **The point of dropping
 * the key here is to make that explicit rather than incidental** — after this,
 * the grant map better-auth is given contains nothing the catalogue does not
 * declare, which is a sentence a reader can check instead of a consequence of a
 * vendored `authorize` loop that each sweep had to re-derive.
 *
 * **The drop changes no answer, and that is asserted rather than argued.**
 * `test/rbac/declared-grants.spec.ts` sweeps every request the vocabulary can
 * express against a role granted everything plus all five retired names and
 * finds no disagreement, and pins the filter as the identity on each of the
 * three static roles' own grant maps. If it ever refused something, it would be
 * the migration those two issues declined to write, arriving unannounced.
 *
 * **A misspelling is refused at the write boundary, so a stored one can only
 * pre-date the check.** `validatePermissions` (`custom-roles.service.ts`) is
 * that boundary and it already answers `Unknown resource: srevice` and `Invalid
 * action "writ" for resource "service"`, on `create` and on `update`, before
 * either writes. So the reachable population of undeclared grants is rows
 * written while the statement *was* declared — two in one sweep and three in the
 * next — plus anything a migration or a hand-run `UPDATE` put there. The log
 * below says that rather than "typo", because sending an operator to look for a
 * typo in a role that was valid when they saved it is the wrong errand.
 *
 * **An undeclared *action* of a declared resource leaves the resource behind
 * with an empty array**, rather than dropping the key. Dropping it would move
 * better-auth from its `unauthorized to access resource "x"` branch to its
 * `You are not allowed to access resource: x` one and reword a refusal for no
 * reason; both are 403 on the wire (§2.2, ADR-0008), and changing neither is
 * cheaper than deciding which is better.
 *
 * Rejected: **refusing to resolve the role at all.** It is the lapsed-license
 * failure mode with a new cause — a holder locked out of every guarded route
 * over a grant that never did anything — and the grant map minus the dead key is
 * a working role, so there is nothing to refuse.
 *
 * Rejected: **a migration that rewrites the stored JSON.** The `docker`
 * argument, unchanged: it needs a slot per deletion, and it is the frontend's
 * `pruneEmpty` that already cleans a role the first time an operator saves it.
 * This is the runtime half of the same answer and needs no slot.
 *
 * Rejected: **leaving it inert and only writing it down**, which is the issue's
 * other option. The docblock is here either way; what a paragraph cannot do is
 * stop the next reader concluding from the types that the catalogue is consulted,
 * which is what it looks like and is not.
 *
 * ---
 *
 * **The second bucket: a grant of a resource better-auth owns.**
 * `organization`, `invitation`, `team` and `ac` are declared statements, so
 * everything above kept them. `internal` is theirs, and "declared" in this
 * function's name has only ever meant *declared for a stored role to hold* —
 * these four are declared so `validatePermissions` can **refuse** them
 * (`internalResources`' own docblock in `access-control.ts` carries why), which
 * is the opposite claim.
 *
 * **They were inert too, and for a reason the `src` sweep cannot see on its
 * own — so `ac` was checked before this dropped it.** All four *are* enforced,
 * by better-auth's organization plugin, against its own `defaultRoles`:
 * `hasPermission`
 * (`node_modules/better-auth/dist/plugins/organization/has-permission.mjs`,
 * installed 1.6.33) starts from `input.options.roles || defaultRoles` and keys
 * on the `member.role` column, and the one branch that would read an
 * `organizationRole` row is behind `options.dynamicAccessControl?.enabled &&
 * options.ac`. `createAuth`'s `organization({ … })` passes no `roles`, no `ac`
 * and no `dynamicAccessControl`, so the plugin never sees this grant map at
 * all, and `ac` here is a separate `createAccessControl` instance nothing but
 * `PermissionService` consults. That is the half `use-permission.ts` had
 * already read and written down for the console's side of the same question.
 *
 * **This drop is *not* answer-preserving, and that is the difference from
 * the undeclared-grant drop.** The four are declared, so `role.authorize({ ac:
 * ['read'] })` found the grant before it and does not after —
 * `declared-grants.spec.ts` asserts that disagreement rather than hiding it, and
 * sweeps the differential over the requests a gate can actually make instead.
 * What makes the drop safe is the other half: no `@RequirePermission` and no
 * `checkPermission` in `backend/src` names one of the four, which
 * `test/rbac/access-control.spec.ts`' `UNCONSULTED` sweep establishes over every
 * call site and is cited rather than restated.
 *
 * **Two buckets and two log lines rather than one, because the remedies
 * differ.** An undeclared grant was legal when it was written, so that line
 * sends the operator to re-save the role. An internal one was never legal:
 * `validatePermissions` has refused all four on `create` and on `update` since
 * the surface first landed, so no row carrying one came through the API — it
 * came from a migration or a hand-run `UPDATE`. Folding the two together would
 * make one line that has to hedge about where the row came from, which is the
 * errand the undeclared-grant drop's note was careful to get right.
 *
 * Rejected: **keeping them and only documenting the asymmetry**, the issue's
 * other option. It leaves two adjacent inert-grant cases handled differently
 * for no reason a reader can act on, and the console cannot say anything about
 * such a grant either — `PermissionGrid` renders off the catalogue, so a
 * granted internal resource shows up nowhere. The paragraph is here as well;
 * what it cannot do is make the row stop reaching `ac.newRole`.
 */
export function toDeclaredGrants(
  stored: Readonly<Record<string, readonly string[]>>,
): DeclaredGrants {
  const declaredBy = statements as Record<string, readonly string[]>;
  const grants: Record<string, string[]> = {};
  const dropped: string[] = [];
  const internal: string[] = [];

  for (const [resource, actions] of Object.entries(stored)) {
    // Before the declared check and not after, so `team: ['read']` — a real
    // stored shape, and `read` is not a declared `team` action — is reported as
    // the resource `team` rather than as the undeclared action `team:read`.
    // Same order `validatePermissions` refuses in.
    if (internalResources.includes(resource)) {
      internal.push(resource);
      continue;
    }

    const declared = declaredBy[resource];
    if (!declared) {
      dropped.push(resource);
      continue;
    }

    grants[resource] = actions.filter((action) => {
      if (declared.includes(action)) return true;
      dropped.push(`${resource}:${action}`);
      return false;
    });
  }

  return { grants, dropped, internal };
}

/**
 * Role-based permission checks against the access-control statements, plus
 * row-level access via the member row's accessed* arrays.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly license: LicenseService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** Throws ForbiddenException unless the caller's role grants every requested action. */
  async checkPermission(
    ctx: PermissionCtx,
    permissions: Permissions,
  ): Promise<void> {
    const memberRecord = await this.findMember(ctx);

    // Owner/admin bypass enterprise-only resources: those statements only
    // constrain custom (licensed) roles.
    const isPrivilegedStaticRole =
      memberRecord.role === 'owner' || memberRecord.role === 'admin';
    if (isPrivilegedStaticRole) {
      const allEnterprise = Object.keys(permissions).every((resource) =>
        enterpriseOnlyResources.has(resource),
      );
      if (allEnterprise) return;
    }

    const role = await this.resolveRole(
      memberRecord.role,
      ctx.session.activeOrganizationId,
    );
    if (!role) {
      throw new ForbiddenException('Invalid role');
    }

    const result = role.authorize(permissions);
    if (!result.success) {
      throw new ForbiddenException(result.error || 'Permission denied');
    }
  }

  /**
   * {@link checkPermission} as a yes or no, for a read that narrows what it
   * answers by the caller's role rather than refusing outright — the Requests
   * page, which shows a `server: ['read']` holder lines no other caller sees.
   * Still refuses a caller who is not a member at all.
   */
  async holdsPermission(
    ctx: PermissionCtx,
    permissions: Permissions,
  ): Promise<boolean> {
    await this.findMember(ctx);
    try {
      await this.checkPermission(ctx, permissions);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /**
   * Instance-level authority: may this caller configure the **platform host**?
   *
   * ADR-0010 named this question — *not "may you reach this row" but "do you
   * administer this instance"* — answered it with the caller's role in their
   * own organization, and said so in its last consequence: *"There is no
   * instance-level authority in this codebase to gate on, and this decision
   * does not invent one … If an instance-level role is ever introduced, this is
   * one of the call sites that should move to it."* This is that authority, and
   * H-51/H-52 are why it could not wait. An absent `serverId` means the
   * platform host across the whole HTTP surface (ADR-0008's second
   * consequence), so every route that admitted an organization's owner or admin
   * and then took the host branch admitted *any* organization's owner. On the
   * forward-auth settings that is not a misconfiguration: one instance-wide
   * oauth2-proxy fronts every organization's gated Domain, and
   * `OAUTH2_PROXY_EMAIL_DOMAINS=*` admits every identity its issuer mints, so
   * pointing it at an attacker's `sso_provider` is a cross-organization
   * authentication bypass.
   *
   * **The authority is the instance organization's owners and admins** — the
   * Organization **pinned** in `instance_organization` (ADR-0077) by
   * `create-instance-organization` or by a Self-hosted install's first sign-up
   * (`bootstrapDefaultOrganization`). It used to be *found* as the earliest
   * `member` row whose role is `owner`; that moved to the next-earliest owner —
   * on the Hosted instance a paying customer — whenever the row it named was
   * deleted, so it is never derived that way any more. Three properties earn it
   * that name:
   *
   * - **It cannot lock an instance out of itself.** `hasInstanceOwner`
   *   (`sign-up-state.ts`) is the predicate that *closes* sign-up, and the pin
   *   is written with the Organization that closes it. Nor can the
   *   Organization be taken away through the app — `updateMemberRole` refuses
   *   to set or clear `owner` (*"The owner role is nontransferable"*), every
   *   Organization delete refuses it (`refuseDeletingInstanceOrganization`),
   *   and the pin's `restrict` key refuses it to everything else.
   * - **It is a no-op on the single-organization install** that
   *   `deploy/install.sh` produces: there is one Organization, it is the
   *   instance organization, and its owner and admins are exactly who
   *   `SettingsService.requireOwnerOrAdmin` already admitted.
   * - **It is not a new statement.** ADR-0010's first consequence rejected
   *   gating host-level power on anything from `statements`, because a licensed
   *   custom role could be granted it; the same reasoning holds here, so this
   *   reads the static role and nothing else.
   *
   * Rejected: the admin plugin's global `user.role`. It is `'user'` for every
   * row on a self-hosted install and `input: false` means no request can change it
   * (H-10), so gating on it would refuse *everybody* — the lockout this check
   * exists to avoid. Also rejected: the first *user* rather than the first
   * Organization. It is the narrower boundary, but it would strip a
   * single-organization install's admins of routes they hold today while buying
   * nothing against a second organization, which is the whole threat.
   *
   * Fails closed when nothing is pinned, or when the pinned Organization no
   * longer exists: a refusal is the only safe answer to "who administers
   * this?", and there is deliberately no fallback to another Organization.
   *
   * **An Agent never passes, whatever its `member.role` says**
   * (ADR-0023, which narrows ADR-0013 to the instance organization's owners and
   * admins *who are people*). The role is read together with the caller's
   * `user.kind` and an Agent is refused before the role is looked at. The
   * writer of `member.role` (`member-role.ts`) already keeps an Agent off
   * `owner` and `admin`; this condition is what holds if a future writer, a
   * migration or a hand-run `UPDATE` does not, and it sits in the one
   * implementation every surface calls, so it adds no second path.
   */
  async checkInstanceAuthority(ctx: PermissionCtx): Promise<void> {
    if (!(await this.holdsInstanceAuthority(ctx))) {
      throw new ForbiddenException({
        message: INSTANCE_AUTHORITY_REFUSAL,
        code: INSTANCE_AUTHORITY_REQUIRED_CODE,
      });
    }
  }

  /**
   * {@link checkInstanceAuthority} as a yes or no, for a surface that refuses
   * in its own words: the Operator page (ADR-0050), whose authority is this
   * one but whose subject is other Organizations, not the platform host. One
   * implementation, so the two cannot disagree about who holds it.
   */
  async holdsInstanceAuthority(ctx: {
    user: { id: string };
  }): Promise<boolean> {
    const instanceOrganizationId = await this.instanceOrganizationId();
    if (!instanceOrganizationId) return false;

    const [callerMember] = await this.db
      .select({ role: member.role, kind: user.kind })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(member.userId, ctx.user.id),
          eq(member.organizationId, instanceOrganizationId),
        ),
      )
      .limit(1);

    if (!callerMember || isAgentUser(callerMember)) return false;
    return callerMember.role === 'owner' || callerMember.role === 'admin';
  }

  /**
   * Which Organization is the **instance organization**: the one pinned in
   * `instance_organization` (CONTEXT.md, ADR-0077), and `null` when nothing is
   * pinned (an instance nobody has claimed yet) **or when the pinned
   * Organization no longer exists**. The second is logged as an error on every
   * read: nobody holds instance authority until an operator restores it, and
   * that is the point — the earliest remaining owner row is never consulted.
   *
   * {@link checkInstanceAuthority} is one of the two readers and this is where
   * that definition lives. **The second reader is why
   * this is public**: an instance-wide *enterprise* column asks two orthogonal
   * things — is this caller entitled, and is this instance licensed — and the
   * licence half has to name a subject. It used to be
   * `ctx.session.activeOrganizationId`, which is the wrong subject for a column
   * that reaches every Organization, so `SettingsService.requireInstanceLicense`
   * asks `LicenseService.hasValidLicense` of *this* Organization instead.
   *
   * That composition happens in `SettingsService` rather than inside
   * `LicenseService`, and not for convenience: `LicenseService` reads `member`
   * directly and says why — this service injects it to resolve custom roles, so
   * a dependency the other way closes a cycle. Reading the pin over there was
   * the alternative, and it is the drift {@link staticRoles} above exists to
   * refuse: the definition of the instance organization is a decision
   * (ADR-0013, ADR-0077), and a second reader of it is a second decision
   * waiting to disagree.
   *
   * A caller doing both must call this **after** the authority check, never
   * instead of it: this answers "which Organization" and nothing about who is
   * asking.
   */
  async instanceOrganizationId(): Promise<string | null> {
    const pin = await readInstanceOrganizationPin(this.db);
    if (!pin) return null;
    if (!pin.exists) {
      this.logger.error(
        `The pinned Instance organization ${pin.organizationId} no longer exists: ` +
          'nobody holds instance authority (ADR-0077). Restore that Organization; ' +
          'authority never falls back to another one.',
      );
      return null;
    }
    return pin.organizationId;
  }

  /**
   * Project access: 'create'/'update'/'delete' require the project permission;
   * 'read' is row-level only — there is no project:read statement, and member
   * reads are enforced by filtering on accessedProjects in each query.
   * Owner/admin skip the row-level check.
   *
   * **`'update'` is the new action, and `'read'` is what it was called before.**
   * `PATCH /projects/:id` carries no `@RequirePermission`, so
   * `ProjectsService.findOne` was its only gate and asked for `'read'` — the
   * one branch here that skips `checkPermission` entirely, because there is no
   * `project: ['read']` statement to consult. So the write was gated by
   * `accessedProjects` and nothing else, for every role. `POST` and
   * `DELETE /tags/:id/projects/:projectId` ran the same check for the same
   * reason. The three now pass `'update'`, which does consult the statement.
   *
   * `'read'` stays what a read asks for, and there is no default here to
   * change: every call site names its action, which is what makes the claim
   * legible at the call site rather than in this signature.
   *
   * **Operator-facing note, the same one `docker-ops.service.ts`'s
   * `containerOp` carries for `docker: write` and `checkServiceAccess` below
   * carries for `service: update`.** A custom (licensed) role that could reach `PATCH /projects/:id` —
   * which, since the read branch consulted no statement, was *any* role whose
   * member row named the Project, including one holding no `project` action at
   * all — no longer can. Nothing was migrated on its behalf, deliberately; see
   * the `project` statement in `access-control.ts` for why a backfill is the
   * hole rather than the fix. **To restore what such a role could do before,
   * add `update` to its `project` actions**; to keep it able to see a Project
   * without rewriting it, which is the level that did not previously exist,
   * leave it alone.
   *
   * **The other half of that note, and the one an operator needs *before*
   * granting the action (ADR-0014): it is authority over everything
   * under the Project, not over the Project's row.** `PATCH /projects/:id`
   * writes `project.env`, and every `${{project.KEY}}` reference in every
   * Service in every Environment beneath the Project resolves against that
   * column at its next deploy — including Services and Environments this
   * caller's own member row does not name, since the row-level branch below
   * consults `accessedProjects` alone. So a holder can change what another
   * Environment's Services see, and can fail their next deploy by removing a
   * key they reference, which `prepareEnvironmentVariables` throws on. That is
   * decided rather than tolerated: ADR-0014 records why bounding the write by
   * every child's entitlement was rejected. **Grant `project: ['update']` to
   * somebody who administers the whole Project**; to let somebody rewrite only
   * the Environments they are entitled to, grant `environment: ['update']` and
   * name those Environments in their member row instead.
   *
   * What such a role does **not** lose is anything beneath the Project.
   * Environments have their own statement and Services theirs, and
   * `DELETE /projects/:id` still asks for `project: ['delete']` alone — a role
   * granted the delete is not refused it for want of the new action, which is
   * the service level's carve-out and the reason `remove` still goes through
   * `ProjectsService.findOne` at read level.
   *
   * **Owner and admin hold `update`; the base `member` role does not**, which
   * is the one place this change alters a static role rather than preserving it.
   * `memberRole`'s `project` line in `access-control.ts` argues it: the write
   * reaches `project.env`, which every Service in every Environment under the
   * Project inherits, and the row-level branch below consults
   * `accessedProjects` only — so it crosses the other two entitlement columns.
   *
   * Both refusals answer 403: a role missing the action is refused by
   * `checkPermission`, a member missing the id in `accessedProjects` by the
   * row-level branch, which carries {@link ACCESS_NOT_GRANTED_CODE} so the
   * console can point at Manage access rather than at the role. Neither tells an
   * unentitled id from an absent one (§2.2, ADR-0008).
   */
  async checkProjectAccess(
    ctx: PermissionCtx,
    action: 'read' | 'create' | 'update' | 'delete',
    projectId?: string,
  ): Promise<void> {
    const memberRecord = await this.findMember(ctx);

    if (action !== 'read') {
      await this.checkPermission(ctx, { project: [action] });
    }

    if (
      action !== 'create' &&
      projectId &&
      memberRecord.role !== 'owner' &&
      memberRecord.role !== 'admin'
    ) {
      if (!memberRecord.accessedProjects.includes(projectId)) {
        throw notGranted(
          'accessedProjects',
          "You don't have access to this project",
        );
      }
    }
  }

  /**
   * Service access: the service permission plus, for non-privileged roles, a
   * row-level accessedServices check.
   * For 'create' the id is the target project's — creating a service needs
   * access to the project it lands in.
   *
   * **`'update'` is the named write, and `'read'` stays the default.** The
   * default is what the finding was: `PATCH /compose/:id`, `PATCH
   * /applications/:id` and the `PATCH /{engine}/:id` family carry no
   * `@RequirePermission`, so this method was their only gate, and every one of
   * them reached it without a third argument. A wholesale rewrite of a
   * Service's definition was authorized by `service: ['read']`. Changing the
   * default to `'update'` was the alternative and is worse: it would silently
   * raise the level of the thirty-odd genuine *reads* that also omit the
   * argument, and a gate that tightens by default tightens the reads first.
   * Every mutation now passes `'update'` explicitly instead, so the omission
   * reads as the claim it is.
   *
   * **Operator-facing note, the same one `docker-ops.service.ts`'s
   * `containerOp` carries for `docker: write`.** A custom (licensed) role
   * holding `service: ['read']` was able to rewrite the definition of the
   * services it was entitled to and no longer is. Nothing was migrated on its
   * behalf, deliberately — see the `service` statement in `access-control.ts`
   * for why a backfill is the hole rather than the fix. **To restore what such a
   * role could do before, add `update` to its `service` actions**; to keep it
   * genuinely read-only, which is the level that did not previously exist, leave
   * it alone. The three static roles — owner, admin and member — all hold
   * `update` and are unaffected.
   *
   * What such a role does **not** lose is the ability to *operate* the
   * services it is entitled to. `start`, `stop`, `reload`, `deploy`,
   * `changeStatus`, `rebuild` and `removeContainers` still take `'read'` here
   * and their own `deployment: ['create']`, so a role built to run a workload
   * it may not redefine keeps working untouched — which is the level this
   * action exists to make expressible, and is why raising them too was
   * rejected.
   *
   * The refusals are two and both answer 403: a role missing the action is
   * refused by `checkPermission` below, a member missing the id in
   * `accessedServices` by the row-level branch. The second carries
   * {@link ACCESS_NOT_GRANTED_CODE}, because the remedy differs — Manage
   * access, not a role change — and the console said the role's. Neither tells
   * an unentitled id from an absent one (§2.2, ADR-0008); the container gates
   * that reach this translate both into their one denial anyway.
   */
  async checkServiceAccess(
    ctx: PermissionCtx,
    serviceId: string,
    action: 'create' | 'read' | 'update' | 'delete' | 'call' = 'read',
  ): Promise<void> {
    const memberRecord = await this.findMember(ctx);

    await this.checkPermission(ctx, { service: [action] });

    if (memberRecord.role !== 'owner' && memberRecord.role !== 'admin') {
      if (action === 'create') {
        if (!memberRecord.accessedProjects.includes(serviceId)) {
          throw notGranted(
            'accessedProjects',
            "You don't have access to this project",
          );
        }
      } else if (!entitledToService(memberRecord, serviceId)) {
        throw notGranted(
          'accessedServices',
          "You don't have access to this service",
        );
      }
    }
  }

  /**
   * {@link checkServiceAccess} as a predicate, for a read that keeps the
   * Services the caller may reach out of many rather than refusing one: the
   * same `service: [action]` permission and the same row-level rule, answered
   * `false` where that method throws. `create` is not offered, its row-level
   * rule being the Project's.
   */
  async serviceAccess(
    ctx: PermissionCtx,
    action: 'read' | 'update' | 'delete' | 'call' = 'read',
  ): Promise<(serviceId: string) => boolean> {
    const memberRecord = await this.findMember(ctx);
    const holds = await this.holdsPermission(ctx, { service: [action] });
    return (serviceId) => holds && entitledToService(memberRecord, serviceId);
  }

  /**
   * Environment access; 'create' is permission-only.
   *
   * **`'update'` is the new action, and `'read'` stays the default.** The
   * default is what the finding was: `PATCH /environments/:id` carries no
   * `@RequirePermission`, so `EnvironmentsService.findOwned` was its only gate
   * and reached this method with `'read'` — and the route writes
   * `environment.env`, the column every Service in the Environment inherits at
   * its next deploy. Keeping `'read'` as the default is
   * {@link checkServiceAccess}'s reasoning one resource over: raising it would
   * silently raise the reads that omit the argument, and a gate that tightens
   * by default tightens the reads first. The one mutating caller passes
   * `'update'` explicitly through
   * `EnvironmentsService.findOwnedForUpdate`.
   *
   * **Operator-facing note.** A custom (licensed) role holding
   * `environment: ['read']` was able to rename and reconfigure the
   * Environments it was entitled to and no longer is. Nothing was migrated on
   * its behalf, deliberately — see the `environment` statement in
   * `access-control.ts`. **To restore what such a role could do before, add
   * `update` to its `environment` actions**; to keep it genuinely read-only,
   * which is the level that did not previously exist, leave it alone. All
   * three static roles — owner, admin and member — hold `update` and are
   * unaffected.
   *
   * **The other half of that note, and what granting the action reaches
   * (ADR-0014).** `PATCH /environments/:id` writes `environment.env`, and every
   * `${{environment.KEY}}` reference in every Service in that Environment
   * resolves against it at the Service's next deploy — including Services the
   * caller's `accessedServices` does not name, since the row-level branch below
   * consults `accessedEnvironments` alone. It is the same decision as
   * {@link checkProjectAccess}'s and the narrower end of it: the grant is per
   * Environment, so it names the rows the write reaches, which is why the base
   * member role holds this action and holds no `project` one.
   *
   * What such a role does **not** lose is the delete. `DELETE
   * /environments/:id` asks for `environment: ['delete']` at the guard and its
   * per-child gate asks `checkServiceAccess(…, 'delete')`, so
   * `EnvironmentsService.remove` still resolves the row at read level — the
   * service level's carve-out, and
   * `test/projects/service-cascade-delete.e2e-spec.ts`'s `deployer` role, which
   * holds `environment: ['read', 'delete']` and no `update`, is what would have
   * caught raising it.
   */
  async checkEnvironmentAccess(
    ctx: PermissionCtx,
    environmentId: string,
    action: 'read' | 'create' | 'update' | 'delete' = 'read',
  ): Promise<void> {
    const memberRecord = await this.findMember(ctx);

    await this.checkPermission(ctx, { environment: [action] });

    if (
      action !== 'create' &&
      memberRecord.role !== 'owner' &&
      memberRecord.role !== 'admin'
    ) {
      if (!memberRecord.accessedEnvironments.includes(environmentId)) {
        throw notGranted(
          'accessedEnvironments',
          "You don't have access to this environment",
        );
      }
    }
  }

  /** Grant-on-create: the creator gets row-level access to what they created. */
  async addNewProject(ctx: PermissionCtx, projectId: string): Promise<void> {
    await this.grantAccess(ctx, 'accessedProjects', projectId);
  }

  async addNewService(ctx: PermissionCtx, serviceId: string): Promise<void> {
    await this.grantAccess(ctx, 'accessedServices', serviceId);
  }

  async addNewEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<void> {
    await this.grantAccess(ctx, 'accessedEnvironments', environmentId);
  }

  /**
   * Grant (or revoke) another Member's row-level access — the write
   * `accessedServices` never had.
   *
   * What broke first: nothing in the product could put an id into any of the
   * three columns for anyone but the creator. `addNewService` below is
   * grant-on-create, and `memberRole` has no `service: create`, so a base
   * Member was permanently a zero-service Member and the row-level half of
   * {@link checkServiceAccess} could only ever refuse. The entitlement gate
   * was correct and untestable in its allowing direction — the VPS run had to
   * write `member.accessed_services` by hand to see a member's own container
   * logs at all, which is the feature removal `container-access.service.ts`
   * says the gate exists *not* to be.
   *
   * Each supplied key replaces its whole column; see
   * `dto/update-member-entitlements.dto.ts` for why replacement rather than
   * add-one/remove-one, and why that is the safer of the two under a concurrent
   * grant. Concretely: this does **not** reuse `grantAccess`. One `UPDATE`, no
   * read — the set arrives whole from the caller and never has to be computed
   * from what is already there. (`grantAccess` did compute its write from a
   * read, and lost a grant to a concurrent one for it; a later fix moved the
   * append into the statement. Sharing it would still be wrong here, because
   * this replaces a set rather than appending to one.)
   *
   * Every id must resolve inside `organizationId` first. A foreign id is inert
   * today — `container-access.service.ts` refuses on the Organization mismatch
   * before it ever reaches `checkServiceAccess` — but storing one leaves a trap
   * for the next check written without that guard, and the refusal is a 404
   * naming the resource rather than a 403, so the route is not an enumeration
   * oracle for another Organization's services (§2.2).
   *
   * Not transactional: a Service deleted between the check and the write leaves
   * an inert id in the array, which is the same state deleting it a second
   * later leaves. Holding a transaction open over four statements to tidy that
   * would buy nothing.
   */
  async setMemberEntitlements(
    organizationId: string,
    memberId: string,
    grants: MemberEntitlements,
  ) {
    const changes = Object.fromEntries(
      Object.entries(grants).filter(([, ids]) => ids !== undefined),
    ) as MemberEntitlements;

    await this.assertEntitlementsResolve(organizationId, changes);

    // An empty body is a valid no-op — an absent key means "leave this column
    // alone" — and drizzle answers `.set({})` with "No values to set", so the
    // row is read back rather than written.
    if (Object.keys(changes).length === 0) {
      const [current] = await this.db
        .select()
        .from(member)
        .where(
          and(
            eq(member.id, memberId),
            eq(member.organizationId, organizationId),
          ),
        )
        .limit(1);
      return current;
    }

    // Each column named rather than `set(changes)`: drizzle leaves an
    // `undefined` key alone, so this is the same write, and a write the
    // census of `member.role` writers can read (`member-role-writes.spec.ts`).
    const [updated] = await this.db
      .update(member)
      .set({
        accessedProjects: changes.accessedProjects,
        accessedEnvironments: changes.accessedEnvironments,
        accessedServices: changes.accessedServices,
      })
      .where(
        and(eq(member.id, memberId), eq(member.organizationId, organizationId)),
      )
      .returning();
    return updated;
  }

  /**
   * Refuses a grant unless every id in it names a row of `organizationId` —
   * the check {@link setMemberEntitlements} makes before it writes, for a
   * caller that writes the grant with a new member row instead of onto an
   * existing one (`AgentsService.create`), so an Agent can never be
   * born holding another Organization's id.
   */
  async assertEntitlementsResolve(
    organizationId: string,
    grants: MemberEntitlements,
  ): Promise<void> {
    for (const [column, ids] of Object.entries(grants) as [
      AccessColumn,
      string[] | undefined,
    ][]) {
      if (ids) await this.assertGrantsResolve(organizationId, column, ids);
    }
  }

  /** Refuses the grant unless every id names a row of `organizationId`. */
  private async assertGrantsResolve(
    organizationId: string,
    column: AccessColumn,
    ids: string[],
  ): Promise<void> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return;

    const found = await this.resolveGrantIds(organizationId, column, wanted);
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `${GRANT_ENTITY[column]} not found: ${missing.join(', ')}`,
      );
    }
  }

  /**
   * Which of `ids` this Organization actually owns. Services are reached
   * through `serviceScope` — the eight service tables as one relation — joined
   * environment → project for the organization, the same path
   * `container-access.service.ts` takes to answer which Service a container
   * belongs to.
   */
  private async resolveGrantIds(
    organizationId: string,
    column: AccessColumn,
    ids: string[],
  ): Promise<Set<string>> {
    if (column === 'accessedProjects') {
      const rows = await this.db
        .select({ id: project.projectId })
        .from(project)
        .where(
          and(
            eq(project.organizationId, organizationId),
            inArray(project.projectId, ids),
          ),
        );
      return new Set(rows.map((row) => row.id));
    }

    if (column === 'accessedEnvironments') {
      const rows = await this.db
        .select({ id: environment.environmentId })
        .from(environment)
        .innerJoin(project, eq(environment.projectId, project.projectId))
        .where(
          and(
            eq(project.organizationId, organizationId),
            inArray(environment.environmentId, ids),
          ),
        );
      return new Set(rows.map((row) => row.id));
    }

    const service = serviceScope(this.db);
    const rows = await this.db
      // Through `sql` for its type: a union subquery's columns arrive untyped.
      .select({ id: sql<string>`${service.serviceId}` })
      .from(service)
      .innerJoin(
        environment,
        eq(service.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(project.organizationId, organizationId),
          inArray(service.serviceId, ids),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The one write behind grant-on-create. Postgres appends; nothing computed
   * from a read reaches the statement.
   *
   * What broke first: this read the member row and wrote
   * `[...memberRecord[column], id]` back. Two Services created concurrently by
   * one Member both read the array before either wrote it, so the second
   * `UPDATE` overwrote the first grant and one id was simply gone — reproduced
   * deterministically in `rbac.e2e-spec.ts`, where a `Promise.all` of two
   * grants left only the second id in every one of the three columns.
   *
   * A transaction was the alternative, and §2.3 rejects it for this call site
   * by name: `applications.service.ts:68` grants *after* the commit precisely
   * so a later failure cannot roll the grant back and the grant cannot hold a
   * transaction open. `array_append` needs neither — there is no invariant
   * spanning two statements once the append happens inside the write.
   *
   * `findMember` stays. It is no longer read for the value, only for the
   * `ForbiddenException` a caller with no member row in the active
   * Organization has always been given; dropping it would smuggle a second
   * behaviour change in with this one.
   *
   * `array_append` appends unconditionally, which is exactly what the spread
   * did, so a repeated grant still duplicates the id. That is deliberate and
   * inert — every row-level check reads the column with `includes` — and
   * deduplicating is its own behaviour change.
   */
  private async grantAccess(
    ctx: PermissionCtx,
    column: AccessColumn,
    id: string,
  ): Promise<void> {
    const memberRecord = await this.findMember(ctx);
    await this.db
      .update(member)
      .set({ [column]: sql`array_append(${member[column]}, ${id})` })
      .where(
        and(
          eq(member.id, memberRecord.id),
          eq(member.organizationId, ctx.session.activeOrganizationId),
        ),
      );
  }

  /**
   * The grants behind a role name. `null` means nothing defines the name, which
   * is what `checkPermission` reports as `Invalid role`; an unlicensed custom
   * role throws its own refusal instead, because the name *is* defined and the
   * license is the thing that is missing.
   *
   * **Nothing undeclared reaches `ac.newRole`.** A stored
   * `organization_role` row is a plain JSON column written when the vocabulary
   * was whatever it then was, so it can still grant a statement that has since
   * been retired — `logs`, `envVars`, `api`, `projectEnvVars`,
   * `environmentEnvVars`, five of them across two sweeps.
   * {@link toDeclaredGrants} removes those and says which, and its docblock
   * carries the mechanism, the proof that the removal is inert, and the
   * alternatives. Before this the grant was merely unreachable — a property two
   * issues had already depended on and nothing in the tree stated.
   *
   * **Nor anything better-auth's organization plugin owns.** The same
   * filter drops a stored grant of `organization`, `invitation`, `team` or `ac`
   * — declared statements, so the undeclared-grant drop kept them, and inert all
   * the same: no gate in `src` asks for one (`test/rbac/access-control.spec.ts`'
   * `UNCONSULTED` sweep) and the plugin that does enforce them reads its own
   * `defaultRoles` off the `member.role` column, never the map assembled here.
   * It is reported on its own line because its remedy is not the
   * undeclared-grant drop's — see {@link
   * PermissionService.reportInternalGrants}.
   *
   * **How often the line below actually fires.** Once per (Organization, role
   * name, dropped set) per process. Not once per check: `resolveRole` runs on
   * every `checkPermission`, so a bare `logger.warn` here would be one line per
   * guarded request for every holder of a role saved before a deletion, which
   * is how a warning stops being read. And not on the hot path at all for the
   * overwhelming majority of callers — the three static roles return above,
   * before any of this, and an unlicensed custom role throws.
   */
  private async resolveRole(
    roleName: string,
    organizationId: string,
  ): Promise<Role | null> {
    if (staticRoles[roleName]) {
      return staticRoles[roleName];
    }

    // Custom roles are a paid feature (a license on a Self-hosted instance,
    // Business or Enterprise on the Hosted one), so without it this
    // role grants nothing and its holder is refused every @RequirePermission
    // route — not narrowed to what the role says, refused outright.
    //
    // Assigning one is license-gated (OrganizationsService.updateMemberRole),
    // but `organization_role` rows and the member rows pointing at them survive
    // a license lapsing, so somebody can still be holding one. Saying so is the
    // whole point: this used to fall through to `Invalid role`, which
    // reads as a broken assignment and sends an operator looking at the role
    // instead of at the license.
    //
    // Falling back to `memberRole` was the alternative. It is not kinder: the
    // static member role grants backups, volumes and env vars outright, so a
    // lapse would silently *widen* what a deliberately narrow custom role can
    // do, and nobody would be told it had happened.
    const licensed = await this.license.hasValidLicense(organizationId);
    if (!licensed) {
      throw customRoleRefusal(this.instanceMode, roleName);
    }

    const customRoles = await this.db
      .select()
      .from(organizationRole)
      .where(
        and(
          eq(organizationRole.organizationId, organizationId),
          eq(organizationRole.role, roleName),
        ),
      );

    if (customRoles.length === 0) {
      return null;
    }

    // Rows sharing a role name are unioned per resource: the name is the join
    // key on member.role, so every row carrying it contributes its grants.
    const merged: Record<string, string[]> = {};
    for (const entry of customRoles) {
      for (const [resource, actions] of Object.entries(entry.permission)) {
        merged[resource] = [
          ...new Set([...(merged[resource] ?? []), ...actions]),
        ];
      }
    }

    const { grants, dropped, internal } = toDeclaredGrants(merged);
    if (dropped.length > 0) {
      this.reportUndeclaredGrants(roleName, organizationId, dropped);
    }
    if (internal.length > 0) {
      this.reportInternalGrants(roleName, organizationId, internal);
    }

    return ac.newRole(grants);
  }

  /** {@link resolveRole}'s once-per-role line; see {@link toDeclaredGrants}. */
  private reportUndeclaredGrants(
    roleName: string,
    organizationId: string,
    dropped: string[],
  ): void {
    const reported = `${organizationId}:${roleName}:${dropped.join(',')}`;
    if (reportedUndeclaredGrants.has(reported)) return;
    reportedUndeclaredGrants.add(reported);

    this.logger.warn(
      `Role "${roleName}" in organization ${organizationId} grants ${dropped.join(', ')}, which the access-control statements no longer declare. Those grants authorize nothing and have been dropped from the role; the rest of it is unaffected. They are almost certainly left over from a statement this Cloudgate version has retired — saving the role again on the roles screen clears them.`,
    );
  }

  /**
   * The same for the internal half, and a **different sentence** rather
   * than the same one with a longer list.
   *
   * `validatePermissions` has refused these four on `create` and on `update`
   * since the custom-role surface landed, so no row carrying one was written
   * through the API and "a statement this version has retired" — the errand the
   * line above sends the operator on — would be false here. What is true is
   * that something wrote the row outside the API, and that better-auth enforces
   * these resources from the `member.role` column and never from a custom
   * role's grants, so nothing was ever delegated by it.
   */
  private reportInternalGrants(
    roleName: string,
    organizationId: string,
    internal: string[],
  ): void {
    const reported = `${organizationId}:${roleName}:${internal.join(',')}`;
    if (reportedInternalGrants.has(reported)) return;
    reportedInternalGrants.add(reported);

    this.logger.warn(
      `Role "${roleName}" in organization ${organizationId} grants ${internal.join(', ')}, which better-auth's organization plugin manages itself and a custom role cannot be delegated. Those grants authorize nothing and have been dropped from the role; the rest of it is unaffected. Creating or updating a role has refused them since custom roles shipped, so this row was written by something other than the API — a migration or a hand-run UPDATE — and saving the role again on the roles screen clears it.`,
    );
  }

  /** The caller's member row; feature services use it for row-level filtering. */
  async findMember(ctx: PermissionCtx) {
    const [result] = await this.db
      .select()
      .from(member)
      .where(
        and(
          eq(member.userId, ctx.user.id),
          eq(member.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);

    if (!result) {
      throw new ForbiddenException({
        message: 'Permission denied',
        code: NOT_A_MEMBER_CODE,
      });
    }
    return result;
  }
}
