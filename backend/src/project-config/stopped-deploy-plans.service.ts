import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment, environment, project } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { CloudServiceDeploys } from './applier/cloud-service-deploys.service';
import { ConfigLocations } from './config-locations.service';
import { parseProjectConfig } from './format/parse-config';
import { describeError } from '../common/describe-error';
import { PlanStore, keptRead, repositoryRead } from './plan-store.service';
import type { Planned, StoredRead } from './plan-store.service';
import type { CloudRead, PlanStep } from './planner/plan.types';

/** The cloud Service whose deploy stopped, as its plan step names it. */
export interface StoppedService {
  readonly applicationId: string;
  readonly environmentId: string;
  readonly configName: string;
  readonly name: string;
}

/**
 * **The plan a stopped deploy leaves open** (the AWS spec "Auto-apply rule"). A
 * cloud Service's deploy that no Apply queued (a push, a console
 * Save, an Agent's redeploy) and whose own read of AWS found more than its
 * new image ends `error` before any change, and its whole plan becomes the
 * Environment's open plan, replacing any open one.
 *
 * That plan is the Environment's plan of the config in effect, as "Check
 * for changes" would make it, with the stopped Service's step carrying the
 * AWS lines the deploy read: its config change when it has one, else a
 * change of no field. So its Apply approves what the deploy met, and the
 * Deployment that Apply queues applies exactly that (`CloudServiceDeploys`).
 * The deploy's row names the plan (`deployment.review_plan_id`), and the
 * plan's view names the row back.
 *
 * A config that cannot be read or planned stores no plan: the deploy still
 * stops, and its log says to Check for changes.
 */
@Injectable()
export class StoppedDeployPlans implements OnModuleInit {
  private readonly logger = new Logger(StoppedDeployPlans.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly locations: ConfigLocations,
    private readonly plans: PlanStore,
    private readonly deploys: CloudServiceDeploys,
  ) {}

  onModuleInit(): void {
    this.deploys.reviewWith(this);
  }

  /**
   * Stores the stopped deploy's plan as the Environment's open plan and
   * links the Deployment to it. Answers the plan's id, or why none was
   * stored.
   */
  async open(
    deploymentId: string,
    service: StoppedService,
    cloudRead: Extract<CloudRead, { status: 'read' }>,
  ): Promise<{ ok: true; planId: string } | { ok: false; reason: string }> {
    let made: { planned: Planned; read: StoredRead };
    try {
      made = await this.planned(service);
    } catch (error) {
      const reason = describeError(error);
      this.logger.warn(
        `Deployment ${deploymentId} stopped, and its plan could not be made: ${reason}`,
      );
      return { ok: false, reason };
    }
    const planned: Planned = {
      ...made.planned,
      steps: withCloudRead(made.planned.steps, service, cloudRead),
    };
    const stored = await this.db.transaction(async (tx) => {
      const row = await this.plans.store(tx, null, planned, made.read, {
        source: 'deploy',
      });
      await tx
        .update(deployment)
        .set({ reviewPlanId: row.planId })
        .where(eq(deployment.deploymentId, deploymentId));
      return row;
    });
    await this.plans.releaseHeld([service.environmentId]);
    return { ok: true, planId: stored.planId };
  }

  /** The Environment's plan of the config in effect, as a push's is made. */
  private async planned(
    service: StoppedService,
  ): Promise<{ planned: Planned; read: StoredRead }> {
    const [found] = await this.db
      .select({ env: environment, organizationId: project.organizationId })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(environment.environmentId, service.environmentId));
    if (!found) throw new Error('Its Environment is gone');
    const { env, organizationId } = found;
    // No person asked: scoped by the organization alone, as a push's plan.
    const scope: PermissionCtx = {
      user: { id: '' },
      session: { activeOrganizationId: organizationId },
    };
    const place = await this.locations.repositoryPlace(env.projectId);
    if (place) {
      const read = await this.locations.readCopy(place, env.configBranch);
      if (!read.ok) throw new Error(read.message);
      const parsed = parseProjectConfig(read.text);
      if (!parsed.ok) throw new Error(parsed.refusal.message);
      const planned = await this.plans.planOne(
        scope,
        env,
        parsed.config,
        await this.plans.previousOf(env.environmentId, { kind: 'repository' }),
        place.gitProviderId,
      );
      return { planned, read: repositoryRead(read) };
    }
    const stored = await this.locations.storedText(env.projectId);
    // A Template setup's entries, held only by the open plan until Apply.
    const text = await this.plans.withPendingEntries(env.environmentId, stored);
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const planned = await this.plans.planOne(
      scope,
      env,
      parsed.config,
      await this.plans.previousOf(env.environmentId, {
        kind: 'cloudgate',
        text: stored,
      }),
    );
    return { planned, read: keptRead(text, stored) };
  }
}

/**
 * The plan's steps with the stopped Service's carrying the deploy's AWS
 * lines: its change, or a change of no field after the others. A plan that
 * destroys the Service is left as it is: its Apply deletes it.
 */
export function withCloudRead(
  steps: readonly PlanStep[],
  service: StoppedService,
  cloudRead: CloudRead,
): PlanStep[] {
  const own = (step: PlanStep) =>
    (step.action === 'change' ||
      step.action === 'redeploy' ||
      step.action === 'destroy') &&
    step.serviceId === service.applicationId;
  if (steps.some((step) => own(step) && step.action === 'destroy')) {
    return [...steps];
  }
  if (steps.some(own)) {
    return steps.map((step): PlanStep => {
      if (!own(step)) return step;
      if (step.action === 'change') return { ...step, cloudRead };
      // A redeploy carries no AWS lines; a change of no field does.
      if (step.action === 'redeploy') {
        return {
          action: 'change',
          configName: step.configName,
          kind: step.kind,
          serviceType: step.serviceType,
          serviceId: step.serviceId,
          name: step.name,
          fields: [],
          cloudRead,
        };
      }
      return step;
    });
  }
  const change: PlanStep = {
    action: 'change',
    configName: service.configName,
    kind: 'web',
    serviceType: 'application',
    serviceId: service.applicationId,
    name: service.name,
    fields: [],
    cloudRead,
  };
  const destroysAt = steps.findIndex((step) => step.action === 'destroy');
  return destroysAt === -1
    ? [...steps, change]
    : [...steps.slice(0, destroysAt), change, ...steps.slice(destroysAt)];
}
