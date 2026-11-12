import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, gitProvider, projectConfigLocation } from '../db/schema';
import type { Environment, MovedOutOf, Plan } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { refusedPlan } from './applier/plan-applier';
import { ConfigLocations } from './config-locations.service';
import { DEFAULT_CONFIG_PATHS, findDefaultPath } from './default-config-path';
import type { ConfigLocationTarget, ConfigRead } from './dto/plan.dto';
import { parseProjectConfig } from './format/parse-config';
import {
  inCopy,
  inEnvironment,
  MOVE_STALE_CODE,
  PROJECT_CONFIG_NOT_REPOSITORY_KEPT_CODE,
  unreadable,
} from './plan-errors';
import { keptRead, PlanStore, repositoryRead } from './plan-store.service';
import type { Planned, PreviousSource, StoredRead } from './plan-store.service';
import type {
  ConfigLocationView,
  ConfirmedMove,
  MovePreview,
  ResolvedTarget,
} from './project-config.views';
import type { RepositoryPlace } from './reader/repository-place';
import { textHash } from './saved-settings';

/** One Environment's side of a move: its plan, and what it read. */
interface MovedEnvironment {
  readonly env: Environment;
  readonly planned: Planned;
  /** What a confirm checks the preview's reads against. */
  readonly stamp: {
    readonly commitSha: string | null;
    readonly textHash: string;
  };
  /** Where the Environment will read it; all `null` for a move out. */
  readonly at: {
    readonly branch: string | null;
    readonly commitSha: string | null;
    readonly fileUrl: string | null;
  };
  /** What its plan stores as read. */
  readonly stored: StoredRead;
}

/**
 * Moving a Project config (US60–US66): into a repository, out of
 * one, or between two. A move changes only where the config is read and
 * applies nothing; its preview and its confirm both need `project: update`.
 */
@Injectable()
export class ConfigMoves {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly locations: ConfigLocations,
    private readonly plans: PlanStore,
  ) {}

  /**
   * A move's preview (US61, US62), on `project: update`: reads every
   * Environment's copy at the new place (a repository's from that
   * Environment's Config branch) and plans it. Refused, naming the
   * Environment, repository and branch, when any copy cannot be read
   * (`CONFIG_UNREADABLE`) or planned (`PLAN_REFUSED`). Stores nothing.
   *
   * A move out of a repository (US64) reads the one copy kept — the
   * chosen Environment's Config branch, else the default branch — and plans
   * it in every Environment; it is refused for a Cloudgate-kept config
   * (`PROJECT_CONFIG_NOT_REPOSITORY_KEPT`).
   */
  async preview(
    ctx: PermissionCtx,
    projectId: string,
    to: ConfigLocationTarget,
  ): Promise<MovePreview> {
    const { target, moved } = await this.planMove(ctx, projectId, to);
    return {
      to: target,
      reads: moved.map(({ env, stamp }) => ({
        environmentId: env.environmentId,
        ...stamp,
      })),
      environments: moved.map(({ env, at, planned }) => ({
        environmentId: env.environmentId,
        name: env.name,
        ...at,
        steps: planned.steps,
        notes: planned.notes,
      })),
    };
  }

  /**
   * A move's confirm (US63), on `project: update`. Reads and plans
   * again, and is refused (`MOVE_STALE`) unless every Environment read what
   * the preview's `reads` say. Then, in one transaction, switches the
   * location, dismisses every open plan and stores each Environment's plan
   * of its new copy (source `move`), open when it has steps. **Nothing is
   * applied**: what the plans would do waits for an Apply.
   *
   * A move out (US65) stores the kept copy as the text, records the
   * file it came from (`movedOutOf`, so the config page can say it is no
   * longer read) and clears every Environment's Config branch. Every
   * Environment's read is the kept copy's, so the confirm is refused when
   * that copy moved on.
   */
  async confirm(
    ctx: PermissionCtx,
    projectId: string,
    to: ConfigLocationTarget,
    reads: readonly ConfigRead[],
  ): Promise<ConfirmedMove> {
    const { target, moved, from } = await this.planMove(ctx, projectId, to);
    const expected = new Map(reads.map((read) => [read.environmentId, read]));
    const unchanged =
      expected.size === moved.length &&
      moved.every(({ env, stamp }) => {
        const previewed = expected.get(env.environmentId);
        return (
          previewed !== undefined &&
          previewed.commitSha === stamp.commitSha &&
          previewed.textHash === stamp.textHash
        );
      });
    if (!unchanged) {
      const where =
        target.kind === 'cloudgate'
          ? target.copy.repository
          : target.repository;
      throw new ConflictException({
        message: `The config at ${where} changed since the preview, or the Project's Environments did. Preview the move again, then confirm what it shows`,
        code: MOVE_STALE_CODE,
      });
    }

    const now = new Date().toISOString();
    const plans = await this.db.transaction(async (tx) => {
      if (target.kind === 'cloudgate') {
        // Out of the repository: the chosen copy becomes the text, and no
        // Environment reads a Config branch any more (US64, US65).
        const movedOutOf: MovedOutOf = {
          providerType: from?.providerType ?? null,
          repository: target.copy.repository,
          path: target.copy.path,
          movedAt: now,
        };
        await tx
          .update(projectConfigLocation)
          .set({
            kind: 'cloudgate',
            text: target.copy.text,
            gitProviderId: null,
            repository: null,
            path: null,
            movedOutOf,
            updatedAt: now,
          })
          .where(eq(projectConfigLocation.projectId, projectId));
        await tx
          .update(environment)
          .set({ configBranch: null })
          .where(eq(environment.projectId, projectId));
      } else {
        const values = {
          kind: 'repository' as const,
          text: null,
          gitProviderId: target.gitProviderId,
          repository: target.repository,
          path: target.path,
          movedOutOf: null,
          updatedAt: now,
        };
        await tx
          .insert(projectConfigLocation)
          .values({ projectId, ...values })
          .onConflictDoUpdate({
            target: projectConfigLocation.projectId,
            set: values,
          });
      }
      const made: Plan[] = [];
      for (const { planned, stored } of moved) {
        made.push(
          await this.plans.store(tx, ctx.user.id, planned, stored, {
            source: 'move',
            replacedAs: 'dismissed',
          }),
        );
      }
      return made;
    });
    await this.plans.releaseHeld(moved.map(({ env }) => env.environmentId));
    const location = await this.locations.locationView(projectId);
    return {
      location: location as ConfigLocationView,
      plans: await this.plans.views(plans),
    };
  }

  /**
   * Every Environment's plan of what the move's target would have it read,
   * or the refusal of the first that cannot be read or planned.
   *
   * - Into a repository (from Cloudgate, or between repositories or paths):
   *   each Environment's copy there, from its Config branch. The target's
   *   connection must be the caller's organization's (404 otherwise). With
   *   no path, the path is {@link findDefaultPath}'s, and the target
   *   answers it.
   * - Out of a repository: the one chosen copy (`fromEnvironmentId`'s Config
   *   branch, else the default branch), planned in every Environment.
   *
   * Each Environment's `previous` is the config in effect there before the
   * move ({@link PlanStore.previousOf}): the stored text of a Cloudgate-kept
   * config, or the outline of its last settled plan of a repository-kept one.
   */
  private async planMove(
    ctx: PermissionCtx,
    projectId: string,
    to: ConfigLocationTarget,
  ) {
    await this.permissions.checkProjectAccess(ctx, 'update', projectId);
    await this.permissions.checkProjectAccess(ctx, 'read', projectId);
    await this.locations.projectInOrganization(ctx, projectId);
    const environments = await this.locations.environmentsOf(projectId);
    const from = await this.locations.repositoryPlace(projectId);
    const source: PreviousSource = from
      ? { kind: 'repository' }
      : {
          kind: 'cloudgate',
          text: (await this.locations.findLocation(projectId))?.text ?? null,
        };
    const previousOf = (env: Environment) =>
      this.plans.previousOf(env.environmentId, source);

    const moved: MovedEnvironment[] = [];
    if (to.kind === 'cloudgate') {
      if (!from) {
        throw new ConflictException({
          message:
            "This Project's config is already kept in Cloudgate, so there is no repository to move it out of",
          code: PROJECT_CONFIG_NOT_REPOSITORY_KEPT_CODE,
        });
      }
      const fromEnvironmentId = to.fromEnvironmentId ?? null;
      let chosen: Environment | null = null;
      if (fromEnvironmentId !== null) {
        chosen =
          environments.find((env) => env.environmentId === fromEnvironmentId) ??
          null;
        if (!chosen) throw new NotFoundException('Environment not found');
      }
      const read = await this.locations.readCopy(
        from,
        chosen?.configBranch ?? null,
      );
      if (!read.ok) throw unreadable(chosen?.name ?? null, from, read);
      const parsed = parseProjectConfig(read.text);
      if (!parsed.ok) {
        throw inCopy(
          refusedPlan([parsed.refusal]),
          chosen?.name ?? null,
          from,
          read.branch,
        );
      }
      const stamp = {
        commitSha: read.commitSha,
        textHash: textHash(read.text),
      };
      for (const env of environments) {
        let planned: Planned;
        try {
          planned = await this.plans.planOne(
            ctx,
            env,
            parsed.config,
            await previousOf(env),
          );
        } catch (error) {
          throw inEnvironment(error, env.name);
        }
        moved.push({
          env,
          planned,
          stamp,
          at: { branch: null, commitSha: null, fileUrl: null },
          stored: keptRead(read.text, read.text),
        });
      }
      const target: ResolvedTarget = {
        kind: 'cloudgate',
        fromEnvironmentId,
        copy: {
          repository: from.repository,
          path: from.path,
          branch: read.branch,
          commitSha: read.commitSha,
          fileUrl: read.fileUrl,
          text: read.text,
        },
      };
      return { target, moved, from };
    }

    const [connection] = await this.db
      .select()
      .from(gitProvider)
      .where(
        and(
          eq(gitProvider.gitProviderId, to.gitProviderId),
          eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!connection) {
      throw new NotFoundException('Git provider connection not found');
    }
    const at = {
      gitProviderId: connection.gitProviderId,
      providerType: connection.providerType,
      repository: to.repository,
    };
    // No path named: found once here, from every Config branch, and the
    // copies it read are the ones planned and stamped, so the preview and
    // the confirm each plan the file they chose (#1344).
    const found =
      to.path === undefined
        ? await findDefaultPath(environments, at, (place, ref) =>
            this.locations.readCopy(place, ref),
          )
        : null;
    const place: RepositoryPlace = {
      ...at,
      path: found?.path ?? to.path ?? DEFAULT_CONFIG_PATHS[0],
    };
    const target: ResolvedTarget = {
      ...to,
      path: place.path,
      providerType: connection.providerType,
      connectionName: connection.name,
    };
    for (const env of environments) {
      const read =
        found?.copies.get(env.environmentId) ??
        (await this.locations.readCopy(place, env.configBranch));
      if (!read.ok) throw unreadable(env.name, place, read);
      const parsed = parseProjectConfig(read.text);
      if (!parsed.ok) {
        throw inCopy(
          refusedPlan([parsed.refusal]),
          env.name,
          place,
          read.branch,
        );
      }
      let planned: Planned;
      try {
        planned = await this.plans.planOne(
          ctx,
          env,
          parsed.config,
          await previousOf(env),
          place.gitProviderId,
        );
      } catch (error) {
        throw inCopy(error, env.name, place, read.branch);
      }
      moved.push({
        env,
        planned,
        stamp: { commitSha: read.commitSha, textHash: textHash(read.text) },
        at: {
          branch: read.branch,
          commitSha: read.commitSha,
          fileUrl: read.fileUrl,
        },
        stored: repositoryRead(read),
      });
    }
    return { target, moved, from };
  }
}
