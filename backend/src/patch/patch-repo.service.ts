import path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ApplicationsService } from '../applications/applications.service';
import { findParentService } from '../common/service-parent';
import { assertShellSafePath } from '../common/shell-safe-path';
import { ComposeService } from '../compose/compose.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { buildHostServerId } from '../deployment-engine/build-host';
import { patchReposDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { SourceCloneService } from '../git-providers/source-clone.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { ServersService } from '../servers/servers.service';
import { resolveRepoPath } from './patch-repo-clone';
import { patch } from './patch.schema';
import type { PatchEntityType } from './patch.service';

/** The git source types a patch repo can be cloned from — docker, drop and
 * raw sources have no repo to browse. */
const CLONABLE_SOURCE_TYPES = new Set([
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'git',
]);

/**
 * Why a source outside {@link CLONABLE_SOURCE_TYPES} has nothing to clone, in
 * the console's own words for it (`sourceSummary`, `COMPOSE_SOURCE_META`).
 * Keyed by source type rather than one sentence, because a message saying
 * "Docker image" to an Application built from uploaded files would be false.
 */
const NO_REPOSITORY: Record<string, string> = {
  docker: 'runs a prebuilt Docker image',
  drop: 'builds from uploaded files',
  raw: 'is a compose file written in Cloudgate',
};

/** The refusal for a source with no repository, naming the source. */
export function noRepositoryMessage(
  type: PatchEntityType,
  sourceType: string,
): string {
  const noun = type === 'application' ? 'Application' : 'Compose stack';
  const why = NO_REPOSITORY[sourceType] ?? `has a ${sourceType} source`;
  return `This ${noun} ${why}, so it has no repository to clone`;
}

/**
 * The absolute path a caller-supplied repo-relative `filePath` names inside an
 * entity's patch-repo clone. It is confined to *that* clone rather than to the
 * patch-repos tree as a whole, because a sibling clone is another service's —
 * potentially another organization's — source. An absolute path is confined
 * into the clone (as `path.join` does) rather than honoured.
 */
export function resolveRepoFilePath(
  repoPath: string,
  filePath: string,
): string {
  const base = path.resolve(repoPath);
  const fullPath = path.resolve(path.join(base, filePath));
  // The path is interpolated into the double-quoted word of a `cat "…"`, so
  // nothing may end those quotes (`common/shell-safe-path.ts`).
  assertShellSafePath(filePath);
  if (filePath.includes('../') || !fullPath.startsWith(`${base}/`)) {
    throw new BadRequestException('Invalid path');
  }
  return fullPath;
}

/**
 * `patch-repo-clone.ts`'s {@link resolveRepoPath}, re-exported under the name
 * this module published it under.
 *
 * **The re-export is not tidiness and the move was not either.** The clone's
 * path expression had to become importable by `ApplicationsService.remove`,
 * which reclaims the clone at the delete that destroys the row naming it — and
 * this file cannot be that import, because it injects `ApplicationsService`.
 * `patch-repo-clone.ts` states why at length. Everything that clones, reads or
 * removes a clone still derives its path from one expression, which is the
 * property that matters and the one the docblock there is about.
 */
export { resolveRepoPath };

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirectoryEntry[];
}

/**
 * A browsable clone of the entity's source under the patch-repos tree, so the
 * patch editor can list and read the files a patch will land on.
 */
@Injectable()
export class PatchRepoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly sourceClone: SourceCloneService,
    private readonly applications: ApplicationsService,
    private readonly composeService: ComposeService,
    private readonly servers: ServersService,
  ) {}

  /**
   * Clones (or refreshes) the entity's source into the patch-repos tree on its
   * build server; returns the repo path.
   *
   * **A source with no repository is refused with a 409 naming it.** It
   * used to run a bare `set -e;` and answer 200 with a path nothing had been
   * cloned into, so the console toasted "Repository cloned" over an empty
   * directory listing. 409 rather than 400: the body is well formed, and what
   * refuses it is the Service's current source, which the caller can change.
   *
   * **`.command` and no environment, which is a claim rather than a shortcut.**
   * `SourceCloneService.cloneProgram` now returns the values its
   * program reads out of the environment alongside the program, and this is the
   * one of its three call sites that does not carry them: the only source type
   * that fills that map is `docker`, whose credential is a private image's pull
   * password, and {@link CLONABLE_SOURCE_TYPES} excludes `docker` outright
   * because a prebuilt image has no repository to browse. So the branch that
   * would need `RemoteExecOptions.env` plumbed through `execOnServer` is
   * unreachable from here, and adding it would be plumbing for a call that
   * cannot happen. If a future source type both clones *and* carries a
   * credential, this is the site to convert — the type will not force it,
   * because dropping a field is legal.
   */
  async ensureRepo(
    ctx: PermissionCtx,
    input: { id: string; type: PatchEntityType },
  ): Promise<string> {
    await this.checkAccess(ctx, input.id, input.type, 'update');
    const { entity, serverId } = await this.findEntity(input.id, input.type);
    if (!CLONABLE_SOURCE_TYPES.has(entity.sourceType)) {
      throw new ConflictException(
        noRepositoryMessage(input.type, entity.sourceType),
      );
    }
    const repoPath = resolveRepoPath(input.type, entity.appName, serverId);

    const clone = await this.sourceClone.cloneProgram(entity, repoPath, {
      on: { serverId, serviceId: input.id },
    });
    await this.exec(serverId, `set -e;${clone.command}`);
    return repoPath;
  }

  /**
   * The repo's tracked files (git ls-tree) folded into a directory tree. The
   * directory listed is *derived* from the access-checked parent, the same
   * expression `ensureRepo` clones into and `readRepoFile` reads from — taking
   * it from the caller would make a sibling clone (another service's,
   * potentially another organization's, source) listable and let a closing `"`
   * append commands to the `cd`.
   *
   * **The machine is {@link findEntity}'s, not the parent row's `serverId`, and
   * that was a live defect.** This read used to take `parent.serverId` —
   * with a comment calling it a kept quirk — while {@link ensureRepo} clones on
   * the build host and {@link catRepoFile} `cat`s there. So on any install with
   * a dedicated build Server the listing was issued to a machine that had never
   * held the clone: `cd` failed, and the route answered 500 *"Failed to read
   * repository"* about a repository that existed, on the other Server. It is
   * the same wrong-machine defect fixed for the source tree's `rm -rf`,
   * and it was invisible for the same reason — the two ids coincide on the
   * default single-Server install, so the words of the command are identical
   * and only the host differs.
   *
   * The fix is to ask the one question rather than to copy the answer:
   * `findEntity` resolves it through `buildHostServerId`, so the clone's
   * *machine* comes from the same place its *path* does — and that
   * is literal rather than figurative: the answer is the argument
   * `resolveRepoPath` derives the **root** from, so the two cannot fork. That
   * costs the `findDeployable` read this route did not previously pay — the same
   * one {@link readRepoFile} pays for the same reason, and the same shape
   * rejected adding to a shared projection instead (`ServiceParent` serves
   * eight service types, seven of which have no build-Server concept, and it
   * would carry a null literal for each).
   */
  async readRepoDirectory(
    ctx: PermissionCtx,
    input: { id: string; type: PatchEntityType },
  ): Promise<DirectoryEntry[]> {
    const parent = await this.checkAccess(ctx, input.id, input.type, 'read');
    const { serverId } = await this.findEntity(input.id, input.type);
    // The machine and the root, from one answer: `findEntity` is what
    // resolves which host holds the clone, and it is also what
    // decides which of the two platform roots the clone sits under, so this
    // read cannot look for the right host's clone under this instance's root.
    const repoPath = resolveRepoPath(input.type, parent.appName, serverId);

    const command = `cd "${repoPath}" && git ls-tree -r --name-only HEAD`;
    let stdout: string;
    try {
      stdout = (await this.exec(serverId, command)).stdout;
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to read repository: ${String(error)}`,
      );
    }

    return buildDirectoryTree(stdout.trim().split('\n').filter(Boolean));
  }

  /**
   * A delete patch shows the repo file it will remove (with a fallback message
   * when it's already gone), a content patch shows its stored content, anything
   * else reads the repo file.
   *
   * `source: 'repo'` skips that resolution and reads the repository's own copy
   * of the path unconditionally, so an `update` patch — the default type — can
   * be diffed against what it replaces; absent that copy the answer is a 404
   * rather than the delete branch's sentinel, which claims a removal.
   */
  async readRepoFile(
    ctx: PermissionCtx,
    input: {
      id: string;
      type: PatchEntityType;
      filePath: string;
      source?: 'patch' | 'repo';
    },
  ): Promise<string> {
    const parent = await this.checkAccess(ctx, input.id, input.type, 'read');
    // Resolved here rather than inside {@link catRepoFile}, and the *only*
    // reason is that the clone's root now comes from the same answer as its
    // machine, so a route that derives the path has to know the host before it
    // can name the file. The cost is one `findDeployable` on the branch below
    // that answers out of the `patch` row and execs nothing — the same read
    // `readRepoDirectory` already pays for the same reason, and the same
    // shape rejected adding to the shared `ServiceParent` projection
    // instead.
    const { serverId } = await this.findEntity(input.id, input.type);
    const repoPath = resolveRepoPath(input.type, parent.appName, serverId);
    const fullPath = resolveRepoFilePath(repoPath, input.filePath);

    if (input.source === 'repo') {
      try {
        return await this.catRepoFile(serverId, repoPath, fullPath);
      } catch (error) {
        // A link out of the clone is refused, not reported missing.
        if (error instanceof BadRequestException) throw error;
        // Same shape of guess as the delete branch below: a failed `cat` on a
        // path inside the clone reads as "the repository has no such file".
        throw new NotFoundException(
          `File not found in repository: ${input.filePath}`,
        );
      }
    }

    const existing = await this.findPatchByFilePath(
      input.filePath,
      input.id,
      input.type,
    );
    if (existing?.type === 'delete') {
      try {
        return await this.catRepoFile(serverId, repoPath, fullPath);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        return '(File not found in repo - will be removed if it exists)';
      }
    }
    if (existing?.content) {
      return existing.content;
    }
    return this.catRepoFile(serverId, repoPath, fullPath);
  }

  /**
   * Deletes every clone in the patch-repos tree; owners and admins only, and
   * the serverId is org-scoped through ServersService.
   *
   * **The host branch takes instance authority (ADR-0013).** The
   * `serverId` branch was never the hole — `ServersService.findOne` is
   * organization-scoped, so a Server this caller may not see reads as a 404 —
   * but `serverId` is `string | null` and `null` is the **platform host**,
   * whose `patch-repos` tree holds every organization's clones side by
   * side: the layout is
   * `{patchReposDirectoryOn(serverId)}/{application|compose}/{appName}` (see
   * {@link resolveRepoPath}) and the command below globs the *tree*, not
   * the caller's subtree. So the own-organization role check above was
   * ADR-0010's fourth consequence verbatim — *"an owner or admin of **any**
   * organization on the instance passes"* — on a destructive call ADR-0013 did
   * not enumerate: an owner of a second Organization deleted every other
   * organization's clones in one request.
   *
   * **Scoping the glob to the caller's organization was the first choice and
   * was rejected, for three reasons rather than by preference.** It is the
   * stronger shape in the abstract — a blast radius that is structural needs no
   * permission check to hold — but there is no per-organization segment on
   * disk to glob, and putting one there costs more than it buys:
   *
   * - It orphans every clone on every existing install. The two-segment tree is
   *   what is on disk today, and this route is the only thing that removes
   *   anything from it, so a three-segment layout would leave the old tree
   *   permanently unreachable by the disk-reclamation route that exists to
   *   reclaim it — with an operator's only remedy an `rm -rf` over SSH.
   * - Reclaiming a *deleted* service's clone is the route's job, and no query
   *   can name one. **Half of that is closed now** — an Application's
   *   clone is now reclaimed by the delete that destroys its row, in ADR-0016's
   *   slot (`patch-repo-clone.ts`'s `reclaimApplicationPatchRepos`) — and half
   *   is not: a Compose stack's clone still outlives its row, as does an
   *   Application's whose build Server was unreachable at delete time, which
   *   that delete names in `unreclaimedArtifacts` and cannot do anything else
   *   about. So the residue this route clears is still residue no query can
   *   name, and a delete built from the organization's rows would still leave
   *   it, quietly, while looking like it had run.
   * - It would answer the question in a second place. `POST /settings/cleanup/*`
   *   is the same act on the same machine — ADR-0013's H-63 moved
   *   `docker volume prune --all --force` on the platform host, which destroys
   *   other tenants' *data* rather than a re-clonable cache, to this same check
   *   rather than scoping it per tenant.
   *
   * What that costs a legitimate operator is what H-63 already priced: *"The
   * only caller it newly refuses is a **different** organization's admin, who
   * has no host here to keep tidy."* It is a no-op on the single-organization
   * install `deploy/install.sh` produces, the clones are a cache
   * {@link ensureRepo} rebuilds on demand, and a caller who names one of their
   * own Servers is unaffected — ADR-0013's second consequence, that
   * organization-level authority *is* the right question for a route that names
   * a Server, holds here too.
   *
   * The own-organization role check stays in front of both branches and keeps
   * its sentence: it is the narrower question (a plain member of any
   * organization is refused for what they are, without learning whether this
   * instance has an owner), and it is the one `PatchController`'s undecorated
   * route is recorded against in `test/coding-standards/route-permissions.spec.ts`.
   */
  async cleanRepos(
    ctx: PermissionCtx,
    // `string | null`, not `string | undefined`: the DTO hands the platform host
    // through as an explicit `null` now rather than 400ing on it, and every
    // dispatch below is `execByServer`'s truthiness test, which already read the
    // two the same way.
    input: { serverId?: string | null },
  ): Promise<boolean> {
    const member = await this.permissions.findMember(ctx);
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can clean patch repos',
      );
    }
    const serverId = input.serverId
      ? (await this.servers.findOne(ctx, input.serverId)).serverId
      : null;
    if (!serverId) {
      await this.permissions.checkInstanceAuthority(ctx);
    }

    // The tree on the machine being cleaned, not this instance's. Under
    // the local root a glob aimed at a Server matched nothing there, and the
    // command ends `|| true`, so the route answered `true` having deleted
    // nothing — the one arm of this defect that reports success.
    const command = `rm -rf "${patchReposDirectoryOn(serverId)}"/* 2>/dev/null || true`;
    await this.exec(serverId, command);
    return true;
  }

  /**
   * `cat` on the machine that holds the clone, of a file whose **real** path is
   * inside it.
   *
   * Takes the `serverId` rather than resolving it: the caller
   * resolves the host once through {@link findEntity} and derives the path's
   * *root* from that same answer, so the file this `cat`s and the host it is
   * `cat`'d on cannot come from two different questions.
   *
   * **The symlinks are resolved first, on that machine, and a path that
   * resolves out of the clone is refused.** `resolveRepoFilePath`
   * confines the path's *text*, and the repository is the caller's own: a
   * committed `leak -> /etc/default/cloudgate-backend` passed it and `cat`
   * followed the link, which on the Hosted platform host handed any member
   * the instance's secrets. So `realpath` answers for the clone and the file
   * together, the file must resolve under the clone, and the `cat` is of that
   * resolved path rather than the one asked for, so nothing between the two
   * calls is followed again. A link that stays inside the clone still reads.
   *
   * Plain `realpath`, not `-e`: GNU coreutils prints a missing last component
   * without failing, so a file the clone lacks still fails at the `cat` as it
   * always did; a `realpath` that refuses a missing file instead fails here,
   * and either failure reads to the caller as "not in the repository". Only
   * the confinement answers `BadRequestException`, which the caller does not
   * fold into a 404.
   *
   * Argv, both calls. `resolveRepoFilePath` (`assertShellSafePath` plus a
   * traversal check) still refuses a hostile `filePath` before it gets here;
   * argv takes the words out of shell-word review (CODING_STANDARDS.md §2.9).
   */
  private async catRepoFile(
    serverId: string | null,
    repoPath: string,
    fullPath: string,
  ): Promise<string> {
    const { stdout } = await this.exec(serverId, [
      'realpath',
      '--',
      repoPath,
      fullPath,
    ]);
    const [realRepo, realFile, ...rest] = stdout.replace(/\n$/, '').split('\n');
    if (
      !realRepo ||
      !realFile ||
      rest.length > 0 ||
      !realFile.startsWith(`${realRepo}/`)
    ) {
      throw new BadRequestException('Invalid path');
    }
    return (await this.exec(serverId, ['cat', realFile])).stdout;
  }

  /**
   * The deployable entity plus where its patch repo lives — the **build host**
   * for an Application, the run Server for a compose stack.
   *
   * `buildHostServerId` rather than the `buildServerId || serverId` this had
   * inline. Same expression, same answer; the point is that it is now
   * the one statement of the rule rather than a fifth copy of it, which is what
   * `deployment-engine/build-host.ts` exists for — the copies are how the
   * question came to be answered two ways in this very file, `ensureRepo`
   * cloning on the build host while `readRepoDirectory` read the run Server.
   *
   * The compose arm stays `entity.serverId` and that is not an inconsistency:
   * compose has no build-Server concept at all (`DeploymentsService.findCompose`
   * hard-codes `buildServerId: null`), so there is no second machine for the
   * rule to choose between.
   */
  private async findEntity(id: string, type: PatchEntityType) {
    if (type === 'application') {
      const entity = await this.applications.findDeployable(id);
      return { entity, serverId: buildHostServerId(entity) };
    }
    const entity = await this.composeService.findDeployable(id);
    return { entity, serverId: entity.serverId };
  }

  /** The patch for one file of one entity, if any. */
  private async findPatchByFilePath(
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

  /**
   * `PatchService.checkAccess`'s twin, and it took the same `'create'`-with-a-
   * service-id for `ensureRepo` that later moved to `'update'` — see that
   * docblock for why the wrong entitlement column was being read.
   */
  private async checkAccess(
    ctx: PermissionCtx,
    serviceId: string,
    type: PatchEntityType,
    action: 'read' | 'update' | 'delete',
  ) {
    const parent = await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      serviceId,
      type,
    );
    await this.permissions.checkServiceAccess(ctx, serviceId, action);
    return parent;
  }

  /**
   * Local or remote by serverId — `remote/exec-dispatch.ts`'s fork,
   * so a `string[]` is one program and its arguments (the `cat` above) and a
   * `string` is a shell program (the `rm -rf …/* 2>/dev/null || true` in
   * `cleanRepos`, whose `||` and redirect are the point).
   */
  private exec(serverId: string | null, command: string | string[]) {
    return execOnServer(this.remoteExec, serverId, command);
  }
}

/** Folds `git ls-tree` paths into a nested directory tree. */
function buildDirectoryTree(files: string[]): DirectoryEntry[] {
  const root: DirectoryEntry[] = [];
  const dirMap = new Map<string, DirectoryEntry>();

  for (const filePath of files) {
    const parts = filePath.split('/');
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isFile = i === parts.length - 1;
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!dirMap.has(currentPath)) {
        const entry: DirectoryEntry = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'directory',
          children: isFile ? undefined : [],
        };

        dirMap.set(currentPath, entry);

        if (parentPath) {
          dirMap.get(parentPath)?.children?.push(entry);
        } else {
          root.push(entry);
        }
      }
    }
  }

  return root;
}
