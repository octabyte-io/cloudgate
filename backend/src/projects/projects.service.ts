import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
} from 'drizzle-orm';
import {
  applicationIdsOf,
  cascadeDelete,
  listCascadeChildren,
} from '../common/service-cascade';
import { BucketDeletes } from '../buckets/bucket-deletes.service';
import { mapUniqueViolation } from '../common/unique-violation';
import type { CascadeDeleted } from '../common/service-cascade';
import { DRIZZLE } from '../db/drizzle.module';
import type { DnsRecord } from '../domains/domain.schema';
import { ENVIRONMENT_CLOUD_DELETES } from '../environments/environment-cloud-deletes.port';
import type {
  EnvironmentCloudDeletesPort,
  StartedEnvironmentDelete,
} from '../environments/environment-cloud-deletes.port';
import { finishEnvironmentTree } from '../environments/environment-tree-delete';
import type { Environment } from '../environments/environment.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, project, projectTag, tag } from '../db/schema';
import type { Project, Tag } from '../db/schema';
import { tearDownApplicationPreviews } from '../preview-deployments/preview-teardown';
import type { PermissionCtx } from '../rbac/permission.service';
import { ProjectConfigService } from '../project-config';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { reclaimPreservedImages } from '../rollbacks/preserved-images';
import { TraefikWriterService } from '../traefik/traefik-writer.service';
import type { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

/**
 * A Project's name is unique in its organization regardless of letter case:
 * a write that hits this index is answered 409 with this sentence, which
 * the console shows under the Name field.
 */
const UNIQUE_NAME_INDEX = 'unique_org_project_name';
const NAME_TAKEN =
  'A Project with this name already exists in your organization';

/** A `list` row: the project columns plus the children the Projects list shows. */
export type ProjectListRow = typeof project.$inferSelect & {
  environmentCount: number;
  tags: Tag[];
};

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    // Delete tears every Service in the Project down before the row goes, which
    // reaches the exec layer and — for its Applications — the Traefik dynamic
    // config the writer owns. The writer rather than
    // TraefikAppConfigService for `applications.service.ts`'s reason: Delete
    // wants the file gone unconditionally, and `regenerate` would rewrite it.
    private readonly remoteExec: RemoteExecService,
    private readonly traefikWriter: TraefikWriterService,
    private readonly projectConfig: ProjectConfigService,
    // A Project's Environments in a Cloud account are deleted through their
    // own cloud Delete first.
    @Inject(ENVIRONMENT_CLOUD_DELETES)
    private readonly cloudDeletes: EnvironmentCloudDeletesPort,
    // Whether each bucket holds files, read before the teardown.
    private readonly bucketDeletes: BucketDeletes,
  ) {}

  private readonly logger = new Logger(ProjectsService.name);

  /**
   * Creates a Project, scoped to the session's active organization.
   * The creator gets row-level access so the project stays visible to them
   * regardless of role.
   */
  async create(ctx: PermissionCtx, data: CreateProjectDto) {
    let created: Project;
    try {
      // The Project and its empty config are one write (US13): no
      // Project created from here on is ever without a config.
      created = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(project)
          .values({
            ...data,
            organizationId: ctx.session.activeOrganizationId,
          })
          .returning();
        await this.projectConfig.createEmpty(tx, row.projectId);
        return row;
      });
    } catch (error) {
      throw mapUniqueViolation(error, UNIQUE_NAME_INDEX, NAME_TAKEN);
    }
    await this.permissions.addNewProject(ctx, created.projectId);
    return created;
  }

  /**
   * {@link findOne} at the write level.
   *
   * `findOne` is correctly `'read'` — it is the lookup `GET /projects/:id`,
   * {@link update} and {@link remove} all share, and it is the *only* one of
   * the three `check*Access` methods whose read branch consults no statement
   * at all (there is no `project: ['read']`), so raising it would both raise
   * the read and change what a read means — so the `'update'` claim is made
   * here instead. `ApplicationsService.findOwnedForUpdate` is the service-level
   * shape of the same pair.
   *
   * **{@link remove} deliberately keeps `findOne`.** `DELETE /projects/:id`
   * already carries `@RequirePermission('project', 'delete')` and authorizes
   * every child with `checkServiceAccess(…, 'delete')`, so its level is set by
   * two mutating statements already. Requiring `update` as well would refuse a
   * role deliberately granted the delete —
   * `test/projects/service-cascade-delete.e2e-spec.ts`'s `deployer` holds
   * `project: ['delete']` and no `update`, and it is the only way to reach
   * that suite's per-child gate at all — and it would make "may retire this
   * Project but not rewrite it" unsayable in the act of creating the level.
   * That is the service level's carve-out, which its own e2e caught rather than
   * its review.
   *
   * The order is the point of the method. Asking for `'update'` *before*
   * `findOne` runs means a caller holding read access and not `update` is
   * refused without learning whether the id resolves, so the route is not an
   * enumeration oracle for a Project the caller may read about but not change
   * (§2.2). The `accessedProjects` check inside `findOne` afterwards is
   * redundant with the one `checkProjectAccess(…, 'update')` already ran and
   * is deliberate: `findOne` remains correct on its own for its own callers.
   */
  private async findOneForUpdate(ctx: PermissionCtx, projectId: string) {
    await this.permissions.checkProjectAccess(ctx, 'update', projectId);
    return this.findOne(ctx, projectId);
  }

  /**
   * A project is only visible inside its own organization, and to members
   * only when granted in their accessedProjects (owner/admin skip that).
   *
   * Read-level, and stays so: {@link findOneForUpdate} is the write-path entry.
   */
  async findOne(ctx: PermissionCtx, projectId: string) {
    await this.permissions.checkProjectAccess(ctx, 'read', projectId);
    const [found] = await this.db
      .select()
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
   * Updates a Project, org-scoped through findOneForUpdate.
   *
   * The write is not only the Project's name: `updateProjectSchema` is
   * `createProjectSchema.partial()`, so `env` comes through here and
   * `prepareEnvironmentVariables` merges it into every Service in **every**
   * Environment under this Project at each one's next deploy. Before `project:
   * update` the only gate was `findOne`'s `accessedProjects` check — no
   * statement at all — so that write crossed both of the other entitlement
   * columns: one grant on the Project reached Environments and Services the
   * caller was refused individually.
   */
  async update(ctx: PermissionCtx, projectId: string, data: UpdateProjectDto) {
    const current = await this.findOneForUpdate(ctx, projectId);
    try {
      const [updated] = await this.db
        .update(project)
        .set(data)
        .where(eq(project.projectId, current.projectId))
        .returning();
      return updated;
    } catch (error) {
      throw mapUniqueViolation(error, UNIQUE_NAME_INDEX, NAME_TAKEN);
    }
  }

  /**
   * Deletes a Project, org-scoped through findOne — and Delete in
   * `CONTEXT.md`'s sense for every Service beneath it.
   *
   * This used to be `db.delete(project)` and nothing else. Every foreign key
   * down the tree — the Environment's `projectId`, and the `environmentId` of
   * `application`, `compose` and all six database tables — is
   * `onDelete: 'cascade'`, so that one
   * statement dropped the rows of every Application, compose stack and database
   * in the tree while every one of their swarm services, containers, networks
   * and project directories kept running — and per ADR-0008 a container that
   * resolves to no Service is *unmanaged*, reached through machine-level
   * `docker:read` "where there is no Service to ask about". Once unmanaged
   * containers were opened up that made deleting one Project move every
   * workload under it from private-to-one-organization to readable and actable
   * by every organization on the host, at once. An earlier fix closed the same
   * hole for a single Service; this is it in bulk, and by the path an operator
   * is most likely to take.
   *
   * Two gates, in this order, both before anything is torn down:
   *
   * 1. `checkProjectAccess` through {@link findOne}, unchanged — and left
   *    at read level on purpose. `project: ['delete']` at the guard and
   *    `service: ['delete']` per child are two mutating statements already, so
   *    this resolve is answering entitlement only; see
   *    {@link findOneForUpdate} for the carve-out and the role that would have
   *    gone red.
   * 2. **`checkServiceAccess` on every child.** The Project-level permission
   *    used to be the only gate, so a member granted a Project but only some of
   *    its Services could delete the ones they were refused individually. Every
   *    child is checked before the first exec, or the route becomes both a way
   *    to destroy Services you may not touch and a way to make Docker calls you
   *    are not entitled to.
   *
   * Then teardown → confirm → row, exactly as the per-Service deletes do, and
   * **there is no partial delete**: one child still `'present'` or `'unknown'`
   * refuses the whole Project with the tree intact. Deleting what could be torn
   * down and reporting the rest was rejected: it leaves an operator holding half
   * a Project whose remaining rows they cannot reason about, and the retry that
   * would fix it has nothing left to tear down for the half already gone.
   * `force` is the same escape hatch as everywhere else, and it names every
   * workload it left behind rather than answering a bare 200.
   */
  async remove(
    ctx: PermissionCtx,
    projectId: string,
    force = false,
  ): Promise<
    CascadeDeleted<typeof project.$inferSelect> & {
      /** The Environments whose cloud Delete runs first. */
      deletingEnvironments?: string[];
      dnsRecordsLeft?: DnsRecord[];
    }
  > {
    const current = await this.findOne(ctx, projectId);
    const environments = await this.db
      .select()
      .from(environment)
      .where(eq(environment.projectId, current.projectId));
    const environmentIds = environments.map((row) => row.environmentId);
    const inCloud = new Set(await this.cloudDeletes.inCloud(environmentIds));
    if (inCloud.size > 0) {
      return this.removeAfterCloud(
        ctx,
        current,
        environments.filter((row) => inCloud.has(row.environmentId)),
        force,
      );
    }
    const children = await listCascadeChildren(this.db, environmentIds);

    return cascadeDelete({
      deps: {
        remoteExec: this.remoteExec,
        traefikWriter: this.traefikWriter,
      },
      children,
      parent: { kind: 'Project', name: current.name },
      force,
      authorizeChild: (child) =>
        this.permissions.checkServiceAccess(ctx, child.serviceId, 'delete'),
      // The preserved `${appName}:v${version}` tags of every Application under
      // it, dropped before the cascade destroys the only rows that name them.
      // One line rather than shared, on `deleteRow`'s reasoning: it
      // closes over this service's `DrizzleDB` and `PermissionCtx`.
      reclaimPreserved: (remoteExec, release) =>
        reclaimPreservedImages(
          this.db,
          remoteExec,
          ctx,
          applicationIdsOf(children),
          release,
        ),
      // The Swarm service and source tree of every preview deployment under it,
      // dropped before the cascade destroys the only rows that name them.
      // A preview row has no `service_type` and so is not a
      // `CascadeChild`; it is reached through its parent Application's id.
      tearDownPreviews: (remoteExec) =>
        tearDownApplicationPreviews(
          this.db,
          remoteExec,
          applicationIdsOf(children),
        ),
      // Every bucket that holds files is kept and named; an empty one goes
      // whole. Never asked to delete files.
      bucketFiles: (bucketIds) => this.bucketDeletes.cascadeFiles(bucketIds),
      deleteRow: async () => {
        const [removed] = await this.db
          .delete(project)
          .where(eq(project.projectId, current.projectId))
          .returning();
        return removed;
      },
    });
  }

  /**
   * A Project with Environments in a Cloud account (ADR-0038): each
   * such Environment's Delete runs first — its cloud Services, then its
   * Environment networks, in Cloud runs — and the Project goes, as above,
   * once every one of them is gone. Every Service is authorized and every
   * such Environment asked first, so a refusal removes nothing. One that
   * ends Delete incomplete keeps the Project, with that Environment's Retry
   * and Forget; delete the Project again once it is gone.
   */
  private async removeAfterCloud(
    ctx: PermissionCtx,
    current: Project,
    environments: Environment[],
    force: boolean,
  ) {
    for (const child of await listCascadeChildren(
      this.db,
      environments.map((row) => row.environmentId),
    )) {
      await this.permissions.checkServiceAccess(ctx, child.serviceId, 'delete');
    }
    for (const row of environments) {
      await this.cloudDeletes.refusal(row, false);
    }
    const deps = {
      db: this.db,
      permissions: this.permissions,
      remoteExec: this.remoteExec,
      traefikWriter: this.traefikWriter,
      bucketDeletes: this.bucketDeletes,
    };
    const started: StartedEnvironmentDelete[] = [];
    for (const row of environments) {
      started.push(
        await this.cloudDeletes.request(ctx, row, {
          retrying: false,
          force,
          finish: finishEnvironmentTree(deps, ctx, row, force),
        }),
      );
    }
    void Promise.all(started.map((one) => one.ended))
      .then(async (gone) => {
        if (gone.every(Boolean))
          await this.remove(ctx, current.projectId, force);
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Project ${current.projectId}: its delete after its cloud Environments failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return {
      ...current,
      deletingEnvironments: environments.map((row) => row.name),
      dnsRecordsLeft: started.flatMap((one) => [...one.dnsRecordsLeft]),
      ...bucketsKeptBy(started),
    };
  }

  /**
   * Lists projects: owner/admin see the whole organization, other roles only
   * the projects granted in their member row's accessedProjects.
   *
   * Rows also carry `environmentCount` and `tags` so the Projects list is one
   * request rather than one per row per column. Both children are
   * aggregated in grouped subqueries and left-joined, so this stays a single
   * round trip no matter how many projects come back — swapping an HTTP N+1
   * for a SQL N+1 would be no fix.
   *
   * The aggregates are scoped exactly like the endpoints they replace: the
   * count only sees environments this caller could read via
   * `GET /environments?projectId=`, and tags only those in the active
   * organization. A join must never widen what a restricted member sees.
   */
  async list(ctx: PermissionCtx): Promise<ProjectListRow[]> {
    const memberRecord = await this.permissions.findMember(ctx);
    const organizationId = ctx.session.activeOrganizationId;
    const orgScope = eq(project.organizationId, organizationId);

    const isPrivileged =
      memberRecord.role === 'owner' || memberRecord.role === 'admin';
    if (!isPrivileged && memberRecord.accessedProjects.length === 0) {
      return [];
    }

    // Mirrors EnvironmentsService.listByProject: plain members only count the
    // environments granted in their accessedEnvironments.
    const environmentScope = isPrivileged
      ? undefined
      : memberRecord.accessedEnvironments.length === 0
        ? sql`false`
        : inArray(environment.environmentId, memberRecord.accessedEnvironments);

    const environmentCounts = this.db
      .select({
        projectId: environment.projectId,
        environmentCount: count().as('environment_count'),
      })
      .from(environment)
      .where(environmentScope)
      .groupBy(environment.projectId)
      .as('environment_counts');

    // Mirrors TagsService.listByProject: every tag assigned to the project,
    // by name, org-scoped.
    const assignedTags = this.db
      .select({
        projectId: projectTag.projectId,
        tags: sql<Tag[]>`json_agg(json_build_object(
          'tagId', ${tag.tagId},
          'name', ${tag.name},
          'color', ${tag.color},
          'createdAt', ${tag.createdAt},
          'organizationId', ${tag.organizationId}
        ) order by ${tag.name})`.as('tags'),
      })
      .from(projectTag)
      .innerJoin(tag, eq(projectTag.tagId, tag.tagId))
      .where(eq(tag.organizationId, organizationId))
      .groupBy(projectTag.projectId)
      .as('assigned_tags');

    return this.db
      .select({
        ...getTableColumns(project),
        environmentCount: sql<number>`coalesce(${environmentCounts.environmentCount}, 0)::int`,
        tags: sql<Tag[]>`coalesce(${assignedTags.tags}, '[]'::json)`,
      })
      .from(project)
      .leftJoin(
        environmentCounts,
        eq(environmentCounts.projectId, project.projectId),
      )
      .leftJoin(assignedTags, eq(assignedTags.projectId, project.projectId))
      .where(
        isPrivileged
          ? orgScope
          : and(
              orgScope,
              inArray(project.projectId, memberRecord.accessedProjects),
            ),
      )
      .orderBy(desc(project.createdAt));
  }
}

/**
 * The buckets on AWS a cloud Delete kept because they hold files,
 * named once in its answer; absent when it kept none.
 */
function bucketsKeptBy(started: readonly StartedEnvironmentDelete[]) {
  const kept = started.flatMap((one) => [...one.bucketsLeftBehind]);
  return kept.length > 0 ? { bucketsLeftBehind: kept } : {};
}
