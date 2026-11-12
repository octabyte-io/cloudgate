import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, asc, eq, getTableColumns, inArray } from 'drizzle-orm';
import { listCascadeChildren } from '../common/service-cascade';
import { BucketDeletes } from '../buckets/bucket-deletes.service';
import { BillingService } from '../cloud/billing/billing.service';
import { mapUniqueViolation } from '../common/unique-violation';
import type { CascadeDeleted } from '../common/service-cascade';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, project } from '../db/schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { withStoredCertificates } from '../domains/stored-certificate';
import type { CoveringCertificate } from '../domains/stored-certificate';
import { EnvironmentHealthService } from '../service-health/environment-health.service';
import type { ServiceHealthRow } from '../service-health/environment-health.service';
import { TraefikWriterService } from '../traefik/traefik-writer.service';
import type { DnsRecord } from '../domains/domain.schema';
import { ENVIRONMENT_CLOUD_DELETES } from './environment-cloud-deletes.port';
import type {
  EnvironmentCloudDeletesPort,
  FinishEnvironmentDelete,
} from './environment-cloud-deletes.port';
import {
  deleteEnvironmentTree,
  finishEnvironmentTree,
} from './environment-tree-delete';
import type { EnvironmentTreeDeps } from './environment-tree-delete';
import { listEnvironmentNetworks } from './environment-networks';
import type { EnvironmentNetworkView } from './environment-networks';
import type { EnvironmentServiceSummary } from './environment-services';
import { listEnvironmentServices } from './environment-services';
import { resolveDeployTarget } from './deploy-target';
import type { CloudTargetCheck, ResolvedDeployTarget } from './deploy-target';
import type {
  EnvironmentDeploymentRow,
  EnvironmentDomainRow,
} from './environment-feeds';
import {
  listEnvironmentDeployments,
  listEnvironmentDomains,
} from './environment-feeds';
import type {
  CreateEnvironmentDto,
  UpdateEnvironmentDto,
} from './dto/environment.dto';

/**
 * An Environment's name is unique in its Project regardless of letter case:
 * a write that hits this index is answered 409 with this sentence, which
 * the console shows under the Name field.
 */
const UNIQUE_NAME_INDEX = 'unique_project_environment_name';
const NAME_TAKEN =
  'An Environment with this name already exists in this Project';

/** A `findOne` result: the environment row plus the services deployed in it. */
export type EnvironmentWithServices = typeof environment.$inferSelect & {
  services: EnvironmentServiceSummary[];
};

/** `get_environment`'s read: each Service with its open-Incident count. */
export type EnvironmentWithOpenIncidents = typeof environment.$inferSelect & {
  services: Array<EnvironmentServiceSummary & { openIncidents: number }>;
};

@Injectable()
export class EnvironmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    // Delete tears every Service in the Environment down before the row goes,
    // which reaches the exec layer and — for its Applications — the Traefik
    // dynamic config the writer owns.
    private readonly remoteExec: RemoteExecService,
    private readonly traefikWriter: TraefikWriterService,
    private readonly health: EnvironmentHealthService,
    // A cloud Deploy target is checked by the Cloud account's own service:
    // its statement, its Organization, and the region check.
    private readonly cloudAccounts: CloudAccountsService,
    // An Environment's Delete in a Cloud account, whose work is in a
    // module that imports this one's importers.
    private readonly moduleRef: ModuleRef,
    // Whether each bucket holds files, read before the teardown.
    private readonly bucketDeletes: BucketDeletes,
    // On the Hosted instance a Deploy target is never the platform host
    // (ADR-0053).
    private readonly instanceMode: InstanceMode,
    // A cloud Deploy target on an Environment not yet counted is one more
    // Cloud Environment on a Hosted plan (ADR-0048).
    private readonly billing: BillingService,
  ) {}

  private readonly checkCloud: CloudTargetCheck = (ctx, given) =>
    this.cloudAccounts.checkDeployTarget(ctx, given);

  /**
   * Creates an Environment, org-scoped through the parent Project. The
   * creator gets row-level access so the environment stays visible to them
   * regardless of role.
   *
   * **This was a cross-tenant write.** `projectId` arrives in the body,
   * `createEnvironmentSchema` binds it to nothing, and the foreign key only
   * requires the Project to *exist* — so nothing on the path constrained it to
   * the caller's own organization, and `POST /environments` inserted a row
   * into another organization's Project for anyone holding
   * `environment: ['create']`. `addNewEnvironment` then granted the creator
   * access to it and it appeared in that organization's
   * `GET /environments?projectId=`. `ProjectsService.create` is the contrast
   * that made it visible: it pins `organizationId` from the session instead of
   * reading a parent id off the body.
   *
   * {@link findParentProject} answers the two questions in the order
   * {@link findOwned} and `ProjectsService.findOne` already use — entitlement
   * first, then tenancy — and see that method for why the tenancy half is a
   * select here rather than a `checkProjectAccess` argument.
   *
   * **Not `project: ['update']`.** The `project` docblock in
   * `access-control.ts` scopes that action to the Project's own row and says
   * pointedly that it gates nothing beneath it; Environments have their own
   * statement, and `POST /environments` already carries
   * `@RequirePermission('environment', 'create')`. Creating an Environment is
   * not a write to the Project's row, so asking for `update` would refuse a
   * role deliberately granted the create — the shape of the carve-out the
   * service and project levels both make for `delete`.
   *
   * **The Deploy target is asked for only when there is a choice**:
   * `resolveDeployTarget` takes the platform host when the organization has no
   * deploy Server and refuses a missing choice when it has one. It runs after
   * the Project resolves, so a refusal about the target never answers for a
   * Project the caller cannot reach. On the Hosted instance there is always a
   * choice, and the platform host is not one of them (ADR-0053).
   *
   * A Cloud account as the target also needs `cloudAccount: read` on
   * it and passes the region check; the check's warnings (a VPC quota nearly
   * reached) come back as `warnings`, beside the saved row.
   */
  async create(ctx: PermissionCtx, data: CreateEnvironmentDto) {
    await this.findParentProject(ctx, data.projectId);
    const { deployTarget, warnings } = await this.checkDeployTarget(
      ctx,
      data.deployTarget,
    );
    let created: typeof environment.$inferSelect;
    try {
      [created] = await this.db
        .insert(environment)
        .values({ ...data, deployTarget })
        .returning();
    } catch (error) {
      throw mapUniqueViolation(error, UNIQUE_NAME_INDEX, NAME_TAKEN);
    }
    await this.permissions.addNewEnvironment(ctx, created.environmentId);
    return { ...created, warnings };
  }

  /**
   * A new Environment's Deploy target as {@link create} checks it, with no
   * Environment yet: `resolveDeployTarget`, then room on a Hosted plan for
   * one more Cloud Environment. A Template setup into a new Project asks it
   * before it makes the Project (#1376), so a refused target saves nothing.
   */
  async checkDeployTarget(
    ctx: PermissionCtx,
    given: CreateEnvironmentDto['deployTarget'],
  ): Promise<ResolvedDeployTarget> {
    const resolved = await resolveDeployTarget(
      this.db,
      ctx,
      given,
      this.checkCloud,
      this.instanceMode,
    );
    if (resolved.deployTarget.kind === 'cloud') {
      await this.billing.assertRoomForCloudTarget(
        ctx.session.activeOrganizationId,
        null,
      );
    }
    return resolved;
  }

  /**
   * The parent Project a caller named, resolved inside their own organization
   * — the guard {@link create} was missing.
   *
   * **Why the select, when `checkProjectAccess` is right there.** It answers
   * only the entitlement question and never touches the `project` table: its
   * `'read'` branch skips `checkPermission` by design (there is no
   * `project: ['read']` statement to consult) and its row-level branch tests
   * `memberRecord.accessedProjects.includes(projectId)`, which owner and admin
   * skip outright. So for the caller this defect was reported against — an
   * owner or admin of organization A — `checkProjectAccess(ctx, 'read', …)`
   * runs no check at all, and a Project id from organization B passes it. It is
   * the right call for the *lesser* question and the wrong one for tenancy, so
   * both are made: `PermissionService` decides entitlement, and the
   * organization-scoped select decides existence, exactly the split
   * `findOwned` and `ProjectsService.findOne` already make.
   *
   * **The two refusals are indistinguishable, per §2.2 and ADR-0008.** A
   * Project in another organization and an id that names nothing anywhere both
   * reach the same `NotFoundException('Project not found')` — the message
   * `ProjectsService.findOne` already answers, so the pair is identical across
   * both routes as well as within this one. A caller must not learn from a
   * refusal that an id they guessed is somebody else's Project.
   * `test/environments/environment-tenancy.e2e-spec.ts` asserts the pair
   * rather than each half.
   *
   * **Not a transaction with the insert.** `updateProjectSchema` carries no
   * `organizationId` — a Project cannot move between organizations — so there
   * is no window between this select and the insert for the answer to change,
   * and the `onDelete: 'cascade'` foreign key handles the only other race.
   *
   * **The name and the privacy are the house shape, not a new one.** Every
   * module that inserts under a parent it was handed writes exactly this — a
   * private org-filtered resolve named for the parent — rather than injecting
   * the owning module's service for one select: `findParentEnvironment` in
   * `ApplicationsService`, `ComposeService`, `BaseDatabaseService`,
   * `TemplatesService` and `AiService`, and `findParentApplication` in the
   * three `networking/` services. `common/service-parent.ts` and
   * `common/owned-server.ts` are shared only because a `serviceId` and a
   * `serverId` are asked about from seven modules each; a Project id resolved
   * from a request body is asked about here and nowhere else in `src`, which
   * a sweep confirmed, so extracting a `common/owned-project.ts` now would be
   * a shared helper with one caller instead of five copies.
   */
  private async findParentProject(ctx: PermissionCtx, projectId: string) {
    await this.permissions.checkProjectAccess(ctx, 'read', projectId);
    const [found] = await this.db
      .select({ projectId: project.projectId })
      .from(project)
      .where(
        and(
          eq(project.projectId, projectId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Project not found');
    return found;
  }

  /**
   * {@link findOwned} at the write level.
   *
   * `findOwned` is correctly `'read'` — it is the lookup {@link findOne},
   * {@link listDeployments}, {@link listDomains} and the two writers all
   * share, and raising it would raise those three reads with it — so the
   * `'update'` claim is made here instead. `ApplicationsService`,
   * `ComposeService` and `BaseDatabaseService` carry the same pair for the
   * identical reason one resource down.
   *
   * **{@link remove} deliberately keeps `findOwned`.** `DELETE
   * /environments/:id` already carries
   * `@RequirePermission('environment', 'delete')` and authorizes every child
   * with `checkServiceAccess(…, 'delete')`, so the level of that write is set
   * by two mutating statements already. Requiring `update` as well would
   * destroy the level `environment: update` exists to create in the act of
   * creating it — "may retire this Environment but not reconfigure it" is
   * unsayable if retiring it needs the reconfigure action — and it would refuse
   * a role deliberately granted the delete:
   * `test/projects/service-cascade-delete.e2e-spec.ts`'s `deployer` holds
   * `environment: ['read', 'delete']`. This is the service level's carve-out,
   * which its own e2e caught rather than its review.
   *
   * The order is the point of the method. Asking for `'update'` *before*
   * `findOwned` runs means a caller holding `read` and not `update` is refused
   * without learning whether the id resolves, so the route is not an
   * enumeration oracle for an Environment the caller may read about but not
   * change (§2.2). The redundant `'read'` check inside `findOwned` afterwards
   * costs a second pass over the member row and is deliberate: a custom role
   * granted `update` without `read` is refused, because there is no writing a
   * row you cannot see.
   */
  private async findOwnedForUpdate(ctx: PermissionCtx, environmentId: string) {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'update');
    return this.findOwned(ctx, environmentId);
  }

  /**
   * Loads one environment. Row-level access via checkEnvironmentAccess
   * (owner/admin skip it), then org-scoped through the parent project — an
   * environment never resolves outside its own organization.
   *
   * Read-level, and stays so: {@link findOwnedForUpdate} is the write-path
   * entry.
   */
  private async findOwned(ctx: PermissionCtx, environmentId: string) {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'read');
    const [found] = await this.db
      .select(getTableColumns(environment))
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

  /**
   * The environment, carrying the services deployed in it: before
   * this, a client could reach an Environment and then name nothing inside
   * it, since every service type is findOne-only. The children ride on the
   * read the Environment screen already makes rather than on a fan-out route,
   * mirroring `ProjectsService.list`.
   *
   * The services are reached only after `findOwned` has resolved the
   * environment inside the caller's organization and past its row-level
   * access check — an environment in another organization reads as absent,
   * services and all. The Environment grant is not a grant on what is in it,
   * though: a restricted member is named only the services in their member
   * row, the scope {@link listDeployments} and {@link listDomains} already
   * applied (this read alone skipped it, so the Services screen listed
   * every service beside the one granted).
   */
  async findOne(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<EnvironmentWithServices> {
    const found = await this.findOwned(ctx, environmentId);
    const services = await listEnvironmentServices(
      this.db,
      found.environmentId,
      await this.serviceScopeOf(ctx),
    );
    return { ...found, services };
  }

  /**
   * {@link findOne}'s answer with each Service's open-Incident count, its
   * checks' and its threshold's — `get_environment`'s join. Gated like
   * {@link findOne} (`checkEnvironmentAccess(ctx, …, 'read')`) and handed only
   * what `findOne` already answered, so the counts cover exactly the Services
   * the caller was named, computed by the Health column's own
   * `EnvironmentHealthService.of`.
   */
  async withOpenIncidents(
    ctx: PermissionCtx,
    found: EnvironmentWithServices,
  ): Promise<EnvironmentWithOpenIncidents> {
    await this.permissions.checkEnvironmentAccess(
      ctx,
      found.environmentId,
      'read',
    );
    const rows = await this.health.of(found.services);
    return {
      ...found,
      services: found.services.map((service, index) => ({
        ...service,
        openIncidents: rows[index].openIncidents,
      })),
    };
  }

  /**
   * Every Deployment of every service in this Environment, newest first.
   *
   * The Deployments tab used to be a stated absence: every Deployment list
   * route is keyed by a *service* id, so composing this feed on the client
   * meant one request per service on every open — and then a decision about
   * what the screen says when three of eleven of them fail. One request has no
   * such state, and that absence of a new failure mode is why this is a route
   * rather than a fan-out.
   *
   * **Scoped exactly like `findOne`**, because it goes through the same
   * `findOwned`: an Environment in another organization reads as absent, and a
   * member without a row-level grant on the Environment is refused before any
   * history is touched. On top of that a restricted member sees only the
   * services granted in their member row — the row-level half
   * `checkServiceAccess` applies one row at a time on each per-service list,
   * mirroring what the Organization feed does for the same reason: otherwise
   * this feed would hand somebody the history those routes refuse them.
   */
  /**
   * The Environment's networks in Cloud accounts: each one's status,
   * its idle cost even when no Service runs in it, and its newest run. Read
   * with the Environment itself (spec US112: `environment: read`).
   */
  async listNetworks(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<EnvironmentNetworkView[]> {
    const found = await this.findOwned(ctx, environmentId);
    return listEnvironmentNetworks(this.db, found.environmentId);
  }

  async listDeployments(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<EnvironmentDeploymentRow[]> {
    const found = await this.findOwned(ctx, environmentId);
    await this.permissions.checkPermission(ctx, { deployment: ['read'] });
    return listEnvironmentDeployments(
      this.db,
      found.environmentId,
      await this.serviceScopeOf(ctx),
    );
  }

  /**
   * The Services table's Health column in one request: each Service
   * this caller may see, with its open-Incident flag and worst current state
   * (`worstState` in `service-health/environment-health.service.ts`).
   *
   * Exactly {@link findOne}'s `services`, the same `findOwned` and the same
   * {@link serviceScopeOf}, so the column and the rows it sits in cannot
   * disagree about which Services exist: a restricted member is answered only
   * the Services their member row grants, and no health read reaches past a
   * Service's entitlement. `service: ['read']` is on the route.
   */
  async listHealth(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<{ environmentId: string; services: ServiceHealthRow[] }> {
    const found = await this.findOwned(ctx, environmentId);
    const services = await listEnvironmentServices(
      this.db,
      found.environmentId,
      await this.serviceScopeOf(ctx),
    );
    return {
      environmentId: found.environmentId,
      services: await this.health.of(services),
    };
  }

  /**
   * Every domain answered by a service in this Environment, by host
   * — the Domains tab's sibling of {@link listDeployments}, with
   * the same scoping argument and the same single request.
   *
   * A managed database contributes nothing: a `domain` row hangs off an
   * Application or a Compose stack, which is also why there is no "Add a
   * domain" control at this level — a domain has to say which service answers
   * it.
   */
  async listDomains(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<
    (EnvironmentDomainRow & { storedCertificate: CoveringCertificate | null })[]
  > {
    const found = await this.findOwned(ctx, environmentId);
    await this.permissions.checkPermission(ctx, { domain: ['read'] });
    const scope = await this.serviceScopeOf(ctx);
    const rows = await listEnvironmentDomains(
      this.db,
      found.environmentId,
      scope,
    );
    // The stored certificate Traefik serves for each host, by the same
    // rule as a service's own Domains listing: this organization's
    // certificates on the machine the row's service runs on. The services'
    // machines come from the Environment's own service list, so the feed's
    // wire shape stays as it was.
    const serverOf = new Map(
      (await listEnvironmentServices(this.db, found.environmentId, scope)).map(
        (service) => [service.serviceId, service.serverId],
      ),
    );
    return withStoredCertificates(
      this.db,
      ctx.session.activeOrganizationId,
      rows,
      (row) => serverOf.get(row.service.serviceId) ?? null,
    );
  }

  /**
   * The service ids the read and its feeds may show this caller, or `null`
   * for "every service in the Environment" — owner and admin skip the
   * row-level check exactly as `checkServiceAccess` lets them.
   *
   * An empty array is a real answer, not a missing one: a restricted member
   * granted no service sees an empty feed rather than every row.
   */
  private async serviceScopeOf(ctx: PermissionCtx): Promise<string[] | null> {
    const memberRecord = await this.permissions.findMember(ctx);
    const isPrivileged =
      memberRecord.role === 'owner' || memberRecord.role === 'admin';
    return isPrivileged ? null : memberRecord.accessedServices;
  }

  /**
   * Updates an Environment, access-scoped through findOwnedForUpdate.
   *
   * The write is not only the Environment's name: `updateEnvironmentSchema` is
   * `createEnvironmentSchema.omit({ projectId: true }).partial()`, so `env`
   * comes through here and `prepareEnvironmentVariables` merges it into every
   * Service in this Environment at its next deploy. That is why the level is
   * `environment: ['update']` and not the `'read'` it rode on before.
   *
   * The Deploy target rides the same write and the same statement. It
   * is the Environment's own column and nothing else: no Service's run Server
   * is touched and no Deployment is queued, so a change moves nothing that
   * already runs. That holds for a switch to or from a Cloud account, or to
   * another one or another region: only the region check runs, which
   * creates nothing in AWS.
   */
  async update(
    ctx: PermissionCtx,
    environmentId: string,
    data: UpdateEnvironmentDto,
  ) {
    const current = await this.findOwnedForUpdate(ctx, environmentId);
    const resolved =
      data.deployTarget === undefined
        ? null
        : await resolveDeployTarget(
            this.db,
            ctx,
            data.deployTarget,
            this.checkCloud,
            this.instanceMode,
          );
    if (resolved?.deployTarget.kind === 'cloud') {
      await this.billing.assertRoomForCloudTarget(
        ctx.session.activeOrganizationId,
        current.environmentId,
      );
    }
    const changes =
      resolved === null
        ? data
        : { ...data, deployTarget: resolved.deployTarget };
    try {
      const [updated] = await this.db
        .update(environment)
        .set(changes)
        .where(eq(environment.environmentId, current.environmentId))
        .returning();
      return { ...updated, warnings: resolved?.warnings ?? [] };
    } catch (error) {
      throw mapUniqueViolation(error, UNIQUE_NAME_INDEX, NAME_TAKEN);
    }
  }

  /**
   * Deletes an Environment, access-scoped through findOwned — and
   * Delete in `CONTEXT.md`'s sense for every Service in it.
   *
   * The same defect and the same fix as `ProjectsService.remove`, one level
   * down: `application.environmentId`, `compose.environmentId` and every
   * database table's `environmentId` are `onDelete: 'cascade'`, so this used to
   * drop every Service's row in one statement with no teardown attempted and no
   * per-Service access check — which per ADR-0008 hands every one of their
   * still-running containers to every organization on the host as unmanaged.
   * Read that method's docblock for why the answer is refuse-the-whole-delete
   * rather than a partial one; both drive `common/service-cascade.ts` so the
   * two roots cannot disagree about what Delete means.
   *
   * **`findOwned` and not `findOwnedForUpdate`.** Two mutating
   * statements already set this write's level — `environment: ['delete']` at
   * the guard and `service: ['delete']` per child, below — so the read-level
   * resolve is answering entitlement only, which is exactly what `'read'` is
   * for. See {@link findOwnedForUpdate} for the carve-out and the role that
   * would have gone red.
   */
  async remove(
    ctx: PermissionCtx,
    environmentId: string,
    force = false,
  ): Promise<
    CascadeDeleted<typeof environment.$inferSelect> & {
      /** What its Domains leave at the DNS provider, on a cloud Delete. */
      dnsRecordsLeft?: readonly DnsRecord[];
    }
  > {
    const current = await this.findOwned(ctx, environmentId);
    // In a Cloud account the Delete destroys what the Environment made there
    // first, in Cloud runs (ADR-0038): the row stays, `deleting`,
    // until AWS is clean, and is answered at once.
    const cloud = this.cloudDeletes;
    if ((await cloud.inCloud([current.environmentId])).length > 0) {
      await this.authorizeChildren(ctx, current.environmentId);
      const started = await cloud.request(ctx, current, {
        retrying: false,
        force,
        finish: this.finisher(ctx, current, force),
      });
      return {
        ...started.environment,
        dnsRecordsLeft: started.dnsRecordsLeft,
        ...(started.bucketsLeftBehind.length > 0
          ? { bucketsLeftBehind: [...started.bucketsLeftBehind] }
          : {}),
      };
    }
    return deleteEnvironmentTree(this.treeDeps, ctx, current, force);
  }

  /**
   * **Retry** an Environment's incomplete Delete (ADR-0038): the same
   * steps again from the kept states. Needs `environment: delete` (the
   * route's), and `service: delete` on each Service in it, as the Delete.
   */
  async retryCloudDelete(ctx: PermissionCtx, environmentId: string) {
    const current = await this.findOwned(ctx, environmentId);
    await this.authorizeChildren(ctx, current.environmentId);
    const started = await this.cloudDeletes.request(ctx, current, {
      retrying: true,
      force: current.cloudDelete?.force ?? false,
      finish: this.finisher(ctx, current, current.cloudDelete?.force ?? false),
    });
    return {
      ...started.environment,
      dnsRecordsLeft: started.dnsRecordsLeft,
      ...(started.bucketsLeftBehind.length > 0
        ? { bucketsLeftBehind: [...started.bucketsLeftBehind] }
        : {}),
    };
  }

  /**
   * Cloudgate's own Retry of an Environment's Delete at Google's subnet
   * hold (S13), queued by `SubnetHoldRetries`: the same steps again
   * as whoever asked the Delete, whose access was checked when they did.
   * It keeps the tries Cloudgate has left, where a Retry by hand clears
   * them. Refused, as any Retry, while the Delete runs.
   */
  async retryCloudDeleteByCloudgate(environmentId: string): Promise<void> {
    const [current] = await this.db
      .select()
      .from(environment)
      .where(eq(environment.environmentId, environmentId));
    const asked = current?.cloudDelete?.requestedBy;
    if (!current || !asked) return;
    const ctx: PermissionCtx = {
      user: { id: asked.userId },
      session: { activeOrganizationId: asked.organizationId },
    };
    const force = current.cloudDelete?.force ?? false;
    await this.cloudDeletes.request(ctx, current, {
      retrying: true,
      force,
      finish: this.finisher(ctx, current, force),
      byCloudgate: true,
    });
  }

  /**
   * **Forget** an Environment's incomplete Delete (ADR-0038): its
   * rows dropped with what is left still in AWS, the list written into the
   * audit entry. Its Services on a Server go as a Delete takes them.
   */
  async forgetCloudDelete(ctx: PermissionCtx, environmentId: string) {
    const current = await this.findOwned(ctx, environmentId);
    await this.authorizeChildren(ctx, current.environmentId);
    return this.cloudDeletes.forget(
      ctx,
      current,
      this.finisher(ctx, current, current.cloudDelete?.force ?? false),
    );
  }

  /** The cloud Delete's work, in the Project config module. */
  private get cloudDeletes(): EnvironmentCloudDeletesPort {
    return this.moduleRef.get<EnvironmentCloudDeletesPort>(
      ENVIRONMENT_CLOUD_DELETES,
      { strict: false },
    );
  }

  private get treeDeps(): EnvironmentTreeDeps {
    return {
      db: this.db,
      permissions: this.permissions,
      remoteExec: this.remoteExec,
      traefikWriter: this.traefikWriter,
      bucketDeletes: this.bucketDeletes,
    };
  }

  /** The rest of a cloud Delete: every Service not in a Cloud account, then the row. */
  private finisher(
    ctx: PermissionCtx,
    current: { environmentId: string; name: string },
    force: boolean,
  ): FinishEnvironmentDelete {
    return finishEnvironmentTree(this.treeDeps, ctx, current, force);
  }

  /**
   * `service: delete` on every Service in the Environment, before anything
   * is removed: the cascade asks it per child, but a cloud Delete reaches
   * the cascade only after its Cloud runs.
   */
  private async authorizeChildren(ctx: PermissionCtx, environmentId: string) {
    for (const child of await listCascadeChildren(this.db, [environmentId])) {
      await this.permissions.checkServiceAccess(ctx, child.serviceId, 'delete');
    }
  }

  /**
   * Lists a project's environments, row-level scoped: owner/admin see every
   * environment of the project, other roles only those granted in their member
   * row's accessedEnvironments.
   */
  async listByProject(ctx: PermissionCtx, projectId: string) {
    const memberRecord = await this.permissions.findMember(ctx);
    const scope = and(
      eq(environment.projectId, projectId),
      eq(project.organizationId, ctx.session.activeOrganizationId),
    );

    const isPrivileged =
      memberRecord.role === 'owner' || memberRecord.role === 'admin';
    if (!isPrivileged && memberRecord.accessedEnvironments.length === 0) {
      return [];
    }

    return this.db
      .select(getTableColumns(environment))
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        isPrivileged
          ? scope
          : and(
              scope,
              inArray(
                environment.environmentId,
                memberRecord.accessedEnvironments,
              ),
            ),
      )
      .orderBy(asc(environment.createdAt));
  }
}
