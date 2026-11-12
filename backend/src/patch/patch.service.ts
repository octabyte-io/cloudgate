import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { quote } from 'shell-quote';
import { findParentService } from '../common/service-parent';
import { DRIZZLE } from '../db/drizzle.module';
import {
  applicationsDirectoryOn,
  composeDirectoryOn,
} from '../deployment-engine/deployment-engine.paths';
import { encodeBase64 } from '../docker/docker.utils';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { patchFilePathProblem } from './patch-file-path';
import { patch } from './patch.schema';
import type { Patch } from './patch.schema';
import type {
  CreatePatchDto,
  ListPatchesDto,
  UpdatePatchDto,
} from './dto/patch.dto';

/** The two service types a patch can attach to. */
export type PatchEntityType = 'application' | 'compose';

/** The owning service's id off a patch row. */
function serviceIdOf(row: Patch): string {
  const serviceId = row.applicationId ?? row.composeId;
  if (!serviceId) {
    throw new InternalServerErrorException('Patch has no associated service');
  }
  return serviceId;
}

/** The service type a patch row's set FK implies. */
function entityTypeOf(row: Patch): PatchEntityType {
  return row.applicationId ? 'application' : 'compose';
}

/** The columns an update may touch — the FKs are not among them. */
type PatchUpdate = Partial<
  Pick<Patch, 'filePath' | 'content' | 'type' | 'enabled'>
>;

@Injectable()
export class PatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Service create permission plus row access to the owning service; enabled
   * is forced true on create.
   *
   * **The row is written from the id this method resolved, never from the
   * body.** It used to insert `{ ...data, enabled: true }`, which
   * writes *both* foreign keys, while `data.applicationId ?? data.composeId`
   * short-circuits and access-checks only the first — so a body carrying the
   * caller's own `applicationId` beside another organization's `composeId`
   * passed the gate and landed a `patch` row on the victim's Compose stack,
   * which `generateApplyPatchesCommand` turns into a `base64 -d >` inside
   * their build tree at their next deploy.
   *
   * `createPatchSchema`'s `superRefine` now refuses that body outright, and
   * this is the other half rather than a duplicate of it: the refinement
   * guards the two fields it was written for, whereas naming the columns here
   * means *no* caller-supplied key reaches the insert — the next foreign key
   * this DTO grows is inert by construction, and an internal caller at the
   * service seam (which never passes through the global pipe, and is how the
   * suite and the deploy paths reach this) obeys the same rule. The `!serviceId`
   * throw stays for that seam too, since the DTO's "exactly one" only runs over
   * the wire.
   *
   * `insertRow` is the shared insert (§1.4) — the one `saveFileAsPatch` and
   * `markFileForDeletion` already write through, forcing `enabled: true` and
   * raising the same failure when nothing comes back.
   *
   * **A second patch for a path that already has one replaces it**, which
   * is what the form's File hint has always promised and what `save-file`
   * already did. This used to insert blind, so the second add hit
   * `patch_filepath_application_unique` and answered a 500. `insertRow` now
   * upserts on that constraint and its compose twin, so the row keeps its id
   * and becomes what a first add with this body would have written. Rejected:
   * a 409 naming the path. It would have made the hint false, and the editor's
   * "Save as a patch" would still replace the file while "Add a patch" refused
   * the same thing.
   */
  async create(ctx: PermissionCtx, data: CreatePatchDto) {
    const serviceId = data.applicationId ?? data.composeId;
    if (!serviceId) {
      throw new BadRequestException(
        'Either applicationId or composeId must be provided',
      );
    }
    const type: PatchEntityType = data.applicationId
      ? 'application'
      : 'compose';
    await this.checkAccess(ctx, serviceId, type, 'update');

    return this.insertRow(
      { id: serviceId, type },
      {
        filePath: data.filePath,
        content: data.content,
        type: data.type,
      },
    );
  }

  /** One patch, access-scoped through the owning service. */
  async findOne(ctx: PermissionCtx, patchId: string) {
    const row = await this.findRow(patchId);
    await this.checkAccess(ctx, serviceIdOf(row), entityTypeOf(row), 'read');
    return row;
  }

  /** A service's patches, ordered by filePath. */
  async byEntityId(ctx: PermissionCtx, query: ListPatchesDto) {
    await this.checkAccess(ctx, query.id, query.type, 'read');
    return this.findByEntityId(query.id, query.type);
  }

  /** Updates a patch; content gains a trailing newline if missing. */
  async update(ctx: PermissionCtx, patchId: string, data: UpdatePatchDto) {
    const row = await this.findRow(patchId);
    await this.checkAccess(ctx, serviceIdOf(row), entityTypeOf(row), 'update');
    return this.updateRow(patchId, data);
  }

  /** An update on the enabled column. */
  async toggleEnabled(ctx: PermissionCtx, patchId: string, enabled: boolean) {
    const row = await this.findRow(patchId);
    await this.checkAccess(ctx, serviceIdOf(row), entityTypeOf(row), 'update');
    return this.updateRow(patchId, { enabled });
  }

  /**
   * Upserts by (filePath, entity) — the editor's save button either creates the
   * patch or replaces its content.
   */
  async saveFileAsPatch(
    ctx: PermissionCtx,
    input: {
      id: string;
      type: PatchEntityType;
      filePath: string;
      content: string;
      patchType?: 'create' | 'update';
    },
  ) {
    await this.checkAccess(ctx, input.id, input.type, 'update');
    const patchType = input.patchType ?? 'update';
    const existing = await this.findByFilePath(
      input.filePath,
      input.id,
      input.type,
    );
    if (!existing) {
      return this.insertRow(
        { id: input.id, type: input.type },
        {
          filePath: input.filePath,
          content: input.content,
          type: patchType,
        },
      );
    }
    return this.updateRow(existing.patchId, {
      content: input.content,
      type: patchType,
    });
  }

  /**
   * An existing patch for the file flips to a delete patch, otherwise one is
   * created.
   */
  async markFileForDeletion(
    ctx: PermissionCtx,
    input: { id: string; type: PatchEntityType; filePath: string },
  ) {
    await this.checkAccess(ctx, input.id, input.type, 'update');
    const existing = await this.findByFilePath(
      input.filePath,
      input.id,
      input.type,
    );
    if (existing) {
      return this.updateRow(existing.patchId, { type: 'delete', content: '' });
    }
    return this.insertRow(
      { id: input.id, type: input.type },
      {
        filePath: input.filePath,
        content: '',
        type: 'delete',
      },
    );
  }

  /** Deletes a patch. */
  async remove(ctx: PermissionCtx, patchId: string) {
    const row = await this.findRow(patchId);
    await this.checkAccess(ctx, serviceIdOf(row), entityTypeOf(row), 'delete');
    const [removed] = await this.db
      .delete(patch)
      .where(eq(patch.patchId, patchId))
      .returning();
    return removed;
  }

  /**
   * The shell block a deploy runs on the build server after the clone — enabled
   * patches only, filePath order, content carried over base64 so quoting can't
   * break the write. Returns '' when the entity has no enabled patches. No
   * access decision: this is the deploy-engine seam, running with no user
   * session.
   *
   * **`serverId` is the machine holding the clone this block patches, and it is
   * a parameter because neither answer is derivable here**. The block is
   * spliced into `DeploymentEngineService`'s own program and dispatched by it,
   * so the caller is the only thing that knows where it will land: for a
   * Compose stack that is `compose.serverId`, and for an Application it is
   * `buildHostServerId`'s answer — the **build host**, which `findParentService`
   * cannot give, since `SERVICE_TABLES` projects `serverId` (the run Server)
   * and no `buildServerId`. Deriving it from the row read here would therefore
   * have been derivable-and-wrong: it would name the runner for an Application
   * built on a dedicated builder. `preview-teardown.ts`'s `previewCodeDirectory`
   * took the same signature change for the same reason, and that change
   * is its own verification — one id decides the root, so the path cannot name
   * a machine other than the one the program runs on.
   *
   * **Both arms were resolving locally, and the application arm is a live bug
   * rather than the compose arm's dormant one.** They read
   * `composeDirectory()`/`applicationsDirectory()`, i.e.
   * `localCloudgateDirectory()`, for every machine alike. The compose arm is
   * one of `composeDirectoryOn`'s nine call sites and moved with them. The
   * application arm is a **sixth** call site of `applicationsDirectoryOn`,
   * missed by the other five: `DeploymentEngineService`'s `codeDirectory` clones
   * to `{applicationsDirectoryOn(buildHostServerId(app))}/{appName}/code`, and
   * this block then `mkdir -p`'d and wrote under a *different* root on that
   * same machine. Because `mkdir -p` succeeds, `set -e` never fired: the write
   * reported success, the build read the unpatched tree, and the deploy went
   * green having silently applied no patch. Reachable on an install that sets
   * `CLOUDGATE_DIRECTORY` and builds on a dedicated Server; invisible without
   * one, because the two roots are then the same literal.
   */
  async generateApplyPatchesCommand(options: {
    id: string;
    type: PatchEntityType;
    serverId: string | null;
  }): Promise<string> {
    const entity = await findParentService(
      this.db,
      null,
      options.id,
      options.type,
    );
    const basePath =
      options.type === 'compose'
        ? composeDirectoryOn(options.serverId)
        : applicationsDirectoryOn(options.serverId);
    const codePath = path.join(basePath, entity.appName, 'code');

    const rows = await this.findByEntityId(options.id, options.type);
    const enabled = rows.filter((row) => row.enabled);
    if (enabled.length === 0) {
      return '';
    }

    // Every row is checked before any is rendered, so a deploy carrying one
    // unsafe Patch runs none of them rather than half. The schemas
    // refuse such a path now; this is for a row saved before they did, and it
    // throws a plain `Error` because the deploy writes that message to its log
    // as the reason it failed.
    for (const row of enabled) {
      const problem = patchFilePathProblem(row.filePath);
      if (problem !== null) {
        throw new Error(
          `Patch ${JSON.stringify(row.filePath)} cannot be applied: its path ${problem}. ` +
            'Edit or delete the Patch, then deploy again.',
        );
      }
    }

    // `quote()`, not a double-quoted interpolation: double quotes stop neither
    // `$(…)` nor a backtick (CODING_STANDARDS.md §2.9). The check above is
    // what keeps the path's text inside the checkout, which no quoting can;
    // the link check below keeps what it reaches there.
    let command = `echo "Applying ${enabled.length} patch(es)...";`;
    for (const row of enabled) {
      command += linkCheckFor(codePath, row);
    }
    for (const row of enabled) {
      const filePath = quote([path.join(codePath, row.filePath)]);
      if (row.type === 'delete') {
        command += `
rm -f -- ${filePath};
`;
      } else {
        command += `
file=${filePath}
dir="$(dirname -- "$file")"
mkdir -p -- "$dir"
echo "${encodeBase64(row.content)}" | base64 -d > "$file"
`;
      }
    }
    return command;
  }

  /**
   * The insert behind create (enabled forced true, no access decision).
   *
   * **The owning service is a parameter of its own, and the spread cannot
   * reach either foreign key**. It used to take one
   * `typeof patch.$inferInsert`, which *includes* `applicationId` and
   * `composeId`, so the three callers each wrote the same pair of ternaries
   * and the shared insert's `{ ...values }` was the one place in this module
   * where a both-ids row was still expressible — the earlier fix covered the DTO
   * and the `create` call site, and left this reachable by any fourth caller.
   * Splitting the parent off means this method sets the two columns and nothing
   * spread into it can, which is the same rule `updateRow`'s narrowed parameter
   * states for the update direction and the one
   * `test/coding-standards/parent-id-writes.spec.ts` now holds over the whole
   * tree.
   *
   * The ternaries moved here rather than being deleted: exactly one column is
   * set and the other is left `undefined`, which drizzle's dialect renders as
   * `DEFAULT` and therefore `NULL` (confirmed in the dialect). The
   * `CHECK ((application_id IS NULL) <> (compose_id IS NULL))` is what makes
   * that a database fact rather than this method's promise.
   *
   * **It is an upsert on `(file_path, <parent>)`**: the two unique
   * constraints in `patch.schema.ts` are the conflict targets, so a path that
   * already has a patch is rewritten in place rather than refused as a 500.
   * The replaced row takes the incoming `content` and `type` through
   * `excluded` (the value already encrypted for the insert) and is enabled
   * again, as a fresh insert would be. For `saveFileAsPatch` and
   * `markFileForDeletion`, which look the row up first, the conflict arm only
   * decides a race between two saves that previously 500'd the loser.
   */
  private async insertRow(
    parent: { id: string; type: PatchEntityType },
    values: Omit<typeof patch.$inferInsert, 'applicationId' | 'composeId'>,
  ) {
    const [created] = await this.db
      .insert(patch)
      .values({
        ...values,
        enabled: true,
        applicationId: parent.type === 'application' ? parent.id : undefined,
        composeId: parent.type === 'compose' ? parent.id : undefined,
      })
      .onConflictDoUpdate({
        target: [
          patch.filePath,
          parent.type === 'application' ? patch.applicationId : patch.composeId,
        ],
        set: {
          content: sql`excluded.content`,
          type: sql`excluded.type`,
          enabled: true,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();
    if (!created) {
      throw new BadRequestException('Error creating the patch');
    }
    return created;
  }

  /** The patch for one file of one entity, if any. */
  private async findByFilePath(
    filePath: string,
    id: string,
    type: PatchEntityType,
  ) {
    const [row] = await this.db
      .select()
      .from(patch)
      .where(
        and(
          eq(patch.filePath, filePath),
          eq(
            type === 'application' ? patch.applicationId : patch.composeId,
            id,
          ),
        ),
      )
      .limit(1);
    return row;
  }

  /** An entity's patches (no access decision — deploy paths). */
  private findByEntityId(id: string, type: PatchEntityType) {
    return this.db
      .select()
      .from(patch)
      .where(
        eq(type === 'application' ? patch.applicationId : patch.composeId, id),
      )
      .orderBy(asc(patch.filePath));
  }

  /**
   * Trailing-newline fix + updatedAt bump.
   *
   * The parameter is the four editable columns rather than `Partial<Patch>`,
   * which admitted the two foreign keys. Nothing may re-point a patch at
   * another service, and every caller here has access-checked the row's
   * **current** parent — so an FK arriving in this `set` would be authorized
   * against the service the patch is leaving, not the one it would join.
   * `updatePatchSchema` keeps the ids off the wire already (it omits them, and a
   * plain `z.object` strips them off a body that sends them anyway); this is the
   * same rule stated where the compiler holds it for an internal caller too.
   */
  private async updateRow(patchId: string, data: PatchUpdate) {
    const [updated] = await this.db
      .update(patch)
      .set({
        ...data,
        ...(data.content && {
          content: data.content.endsWith('\n')
            ? data.content
            : `${data.content}\n`,
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(patch.patchId, patchId))
      .returning();
    return updated;
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(patchId: string) {
    const [row] = await this.db
      .select()
      .from(patch)
      .where(eq(patch.patchId, patchId))
      .limit(1);
    if (!row) throw new NotFoundException('Patch not found');
    return row;
  }

  /**
   * The owning service must exist in the caller's organization (cross-org reads
   * look absent) and the caller needs the service permission plus row access.
   *
   * **`'update'` is the mutating action here, and `'create'` was a bug.**
   * Every write through this helper — `create`, `update`, `toggleEnabled`,
   * `saveFileAsPatch`, `markFileForDeletion` — used to pass `'create'` with a
   * **service** id, and `PermissionService.checkServiceAccess` branches on
   * `action === 'create'` to check `accessedProjects` rather than
   * `accessedServices`, because at its five genuine create sites the id is the
   * target *project*'s. So the row-level half of these five checks was reading
   * the wrong column and could only ever refuse. It was latent rather than
   * exploitable — the branch runs only for non-privileged roles, and
   * `@RequirePermission('service', 'create')` on the routes refuses those
   * first — but it is the exact failure `create`-for-updates was rejected
   * over, so the six sites moved with the rest. `'create'` is now unreachable
   * from this module, which is why it is off the parameter's type: nothing
   * here creates a Service.
   */
  private async checkAccess(
    ctx: PermissionCtx,
    serviceId: string,
    type: PatchEntityType,
    action: 'read' | 'update' | 'delete',
  ) {
    await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      serviceId,
      type,
    );
    await this.permissions.checkServiceAccess(ctx, serviceId, action);
  }
}

/**
 * The shell lines that stop a deploy when a Patch's path goes through a link
 * committed in the repository.
 *
 * {@link patchFilePathProblem} confines the path's *text*; the repository is
 * the customer's own, so a committed `leak -> /etc/cron.d/x` or `dir -> /etc`
 * passes it and the write, `mkdir -p` or `rm` follows the link out of the
 * checkout — as root on the Hosted platform host. So every component of the
 * path that already exists must be a real file or folder, not a link: tested
 * with `[ -L ]` on the machine that holds the checkout, for every Patch before
 * any is applied, so a deploy carrying one such Patch applies none. A delete
 * Patch's own last component may be a link: `rm` removes the link, never what
 * it points at. A link that stays inside the checkout is refused as well; the
 * Patch can name the file it leads to instead.
 */
function linkCheckFor(codePath: string, row: Patch): string {
  const segments = row.filePath
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  const checked = row.type === 'delete' ? segments.slice(0, -1) : segments;
  if (checked.length === 0) return '';
  const prefixes = checked.map((_, index) =>
    path.join(codePath, ...checked.slice(0, index + 1)),
  );
  const refusal =
    `❌ Patch ${JSON.stringify(row.filePath)} cannot be applied: its path goes through a link ` +
    'committed in the repository, and a Patch is never written or removed through a link. ' +
    'Point the Patch at the file the link leads to, or remove the link from the repository, then deploy again.';
  return `
for cg_part in ${quote(prefixes)}; do if [ -L "$cg_part" ]; then echo ${quote([refusal])}; exit 1; fi; done
`;
}
