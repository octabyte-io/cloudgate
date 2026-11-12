import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  environment,
  gitProvider,
  project,
  projectConfigLocation,
} from '../db/schema';
import type { Environment, Plan } from '../db/schema';
import type { PushHoldFor } from '../deployments/deployments.service';
import type {
  ConfigPush,
  ConfigPushPlanner,
} from '../git-providers/config-push-planner.port';
import type { PermissionCtx } from '../rbac/permission.service';
import { refusedPlan } from './applier/plan-applier';
import { ConfigLocations } from './config-locations.service';
import { parseProjectConfig } from './format/parse-config';
import { describeError } from '../common/describe-error';
import { inCopy, unreadable } from './plan-errors';
import { PlanStore, repositoryRead } from './plan-store.service';
import type { RepositoryPlace } from './reader/repository-place';

/**
 * Plans of a push to a Config branch (US50, US51), behind the push
 * handlers' {@link ConfigPushPlanner} port.
 */
@Injectable()
export class PushPlans implements ConfigPushPlanner {
  private readonly logger = new Logger(PushPlans.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly locations: ConfigLocations,
    private readonly plans: PlanStore,
  ) {}

  /**
   * Prepares a `push` plan for every Environment that reads the pushed
   * branch of a Project whose config is kept in the pushed repository
   * through the connection the push came by. **Nothing is applied.** An
   * Environment with no Config branch reads the default branch, so its copy
   * is read to learn which branch that is.
   *
   * Answers which builds of the same push to hold (US51), as
   * {@link PushHoldFor}: an Application's, when the push touched the
   * config's file and its Environment's new plan changes the Application's
   * own entry (see decisions). Every other build is left to build as
   * it does today.
   *
   * Never throws: a copy that cannot be read or planned is logged and plans
   * nothing in that Environment, and the push still deploys, since builds
   * never read the config (US53).
   */
  async planPush(push: ConfigPush): Promise<PushHoldFor> {
    const holds = new Map<
      string,
      { planId: string; configNames: ReadonlySet<string> }
    >();
    const holdFor: PushHoldFor = ({ environmentId, configName }) => {
      const hold = holds.get(environmentId);
      return hold?.configNames.has(configName) ? hold.planId : null;
    };
    const { branch } = push;
    if (branch === null) return holdFor;
    let places: Array<{
      projectId: string;
      organizationId: string;
      place: RepositoryPlace;
    }>;
    try {
      places = await this.placesOf(push);
    } catch (error) {
      this.logger.error(
        `A push to ${push.repository} could not look up the configs kept there: ${describeError(error)}`,
      );
      return holdFor;
    }

    for (const { projectId, organizationId, place } of places) {
      const touched =
        push.changedFiles === null ||
        push.changedFiles.some((path) => samePath(path, place.path));
      let environments: Environment[];
      try {
        environments = await this.db
          .select()
          .from(environment)
          .where(
            and(
              eq(environment.projectId, projectId),
              or(
                eq(environment.configBranch, branch),
                isNull(environment.configBranch),
              ),
            ),
          )
          .orderBy(environment.createdAt, environment.environmentId);
      } catch (error) {
        this.logger.error(
          `A push to ${place.repository} could not list the Environments reading it: ${describeError(error)}`,
        );
        continue;
      }
      for (const env of environments) {
        try {
          const made = await this.planPushed(
            env,
            place,
            organizationId,
            branch,
          );
          if (made === null) continue;
          await this.plans.releaseHeld([env.environmentId]);
          if (made.status !== 'open' || !touched) continue;
          holds.set(env.environmentId, {
            planId: made.planId,
            configNames: new Set(
              // A change of no field only reads AWS for Drift.
              made.steps.flatMap((step) =>
                step.action === 'change' && step.fields.length > 0
                  ? [step.configName]
                  : [],
              ),
            ),
          });
        } catch (error) {
          this.logger.warn(
            `A push to ${place.repository} on ${branch} prepared no plan for the ${env.name} Environment: ${describeError(error)}`,
          );
        }
      }
    }
    return holdFor;
  }

  /**
   * The repository-kept configs the push reached: kept in its repository
   * through the connection it came by (another organization's install of
   * the same repository never plans here).
   */
  private async placesOf(push: ConfigPush) {
    const rows = await this.db
      .select({
        projectId: projectConfigLocation.projectId,
        organizationId: project.organizationId,
        repository: projectConfigLocation.repository,
        path: projectConfigLocation.path,
        providerType: gitProvider.providerType,
      })
      .from(projectConfigLocation)
      .innerJoin(
        project,
        eq(projectConfigLocation.projectId, project.projectId),
      )
      .innerJoin(
        gitProvider,
        eq(projectConfigLocation.gitProviderId, gitProvider.gitProviderId),
      )
      .where(
        and(
          eq(projectConfigLocation.kind, 'repository'),
          eq(projectConfigLocation.gitProviderId, push.gitProviderId),
          sql`lower(${projectConfigLocation.repository}) = lower(${push.repository})`,
        ),
      );
    return rows.map((row) => ({
      projectId: row.projectId,
      organizationId: row.organizationId,
      place: {
        gitProviderId: push.gitProviderId,
        providerType: row.providerType,
        repository: row.repository ?? push.repository,
        path: row.path ?? 'cloudgate.yaml',
      },
    }));
  }

  /**
   * One Environment's plan of a pushed copy, stored as source `push` with no
   * person behind it; `null` when the Environment reads another branch (its
   * default branch is not the pushed one) or its copy cannot be read, which
   * is only logged for an Environment that names the pushed branch.
   */
  private async planPushed(
    env: Environment,
    place: RepositoryPlace,
    organizationId: string,
    branch: string,
  ): Promise<Plan | null> {
    const read = await this.locations.readCopy(place, env.configBranch);
    if (!read.ok) {
      if (env.configBranch === null) return null;
      throw unreadable(env.name, place, read);
    }
    if (read.branch !== branch) return null;
    const parsed = parseProjectConfig(read.text);
    if (!parsed.ok) {
      throw inCopy(refusedPlan([parsed.refusal]), env.name, place, read.branch);
    }
    // The connection lookup a create needs is the organization's; a
    // push has no person, so it is scoped by the organization alone.
    const scope: PermissionCtx = {
      user: { id: '' },
      session: { activeOrganizationId: organizationId },
    };
    const planned = await this.plans.planOne(
      scope,
      env,
      parsed.config,
      await this.plans.previousOf(env.environmentId, { kind: 'repository' }),
      place.gitProviderId,
    );
    return this.db.transaction((tx) =>
      this.plans.store(tx, null, planned, repositoryRead(read), {
        source: 'push',
      }),
    );
  }
}

/** A repository path compared the way a push names it, leading `./` or `/` aside. */
function samePath(a: string, b: string): boolean {
  const bare = (path: string) => path.replace(/^(\.\/|\/)+/, '');
  return bare(a) === bare(b);
}
