import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { environment, pendingSetup, plan, project } from '../../db/schema';
import type { Environment } from '../../db/schema';
import { AuditLogService } from '../../enterprise/audit-logs/audit-log.service';
import { auditTargetFor } from '../../enterprise/audit-logs/audit-routes';
import { PLAN_STALE_CODE, ProjectConfigService } from '../../project-config';
import type { PlanStep, PlanView } from '../../project-config';
import type { PermissionCtx } from '../../rbac/permission.service';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { ServerSetupRuns } from '../../servers/server-setup-runs';
import { readinessOf } from './auto-apply-readiness';
import type { AutoApplyReadiness } from './auto-apply-readiness';
import type { AutoApplyState, PendingSetup } from './pending-setup.schema';

/** The job id the waiting setups are looked at under, so a test can run it as its timer would. */
export const PENDING_SETUP_AUTO_APPLY_JOB_ID = 'pending-setup-auto-apply';

/**
 * Every minute: a bought Server's last stage and an own Server's setup end
 * on no event this module hears in time, and a minute is short beside the
 * minutes either takes. A setup run's end is heard at once (`onRunEnded`).
 */
export const PENDING_SETUP_AUTO_APPLY_CRON = '* * * * *';

/** The route an Apply pressed by hand is recorded under, which this one is recorded as. */
const APPLY_ROUTE = '/environments/:environmentId/plan/apply';

/** Where a get-started wizard's setup stands, as the Environment's Pending setups list it. */
export interface AutoApplyView {
  readonly status: AutoApplyState;
  /** While `waiting`: what for, in words to show as they are; null otherwise. */
  readonly waitingFor: string | null;
  /** While `refused`: why Cloudgate gave the Apply up; null otherwise. */
  readonly message: string | null;
}

/**
 * **The get-started wizard's Apply** (ADR-0073, an amendment of ADR-0065
 * for the wizard only). A setup made with `autoApply` waits on its
 * Environment with `autoApplyState: waiting`; once the Server its
 * Environment deploys to is Ready and set up (`readinessFrom`), Cloudgate
 * applies the Environment's open plan itself, **as the person who set it
 * up**, through the same `ProjectConfigService.applyPlan` an Apply pressed
 * by hand goes through, so every permission and every refusal is the same.
 *
 * It is looked at in three places: straight after the setup, in case the
 * Server is ready already; each time a Setup run ends; and every minute.
 * Each attempt claims the row (`waiting` → `applying`) with a conditional
 * write first, so two of them never both apply.
 *
 * Only a plan made of nothing but this setup's creates is applied. Anything
 * else in it (a change, a destroy, another setup's part, an edit someone
 * made to the config since) was never part of what the wizard was asked to
 * do, so the setup is given up (`refused`) and the plan waits for an Apply
 * by hand. A plan gone stale is made again once, from the stored text,
 * which carries this setup's entries forward (ADR-0065's amendment).
 *
 * An Apply that ran is recorded in the audit trail as one pressed by hand
 * is, with `metadata.autoApply` set. One that ran and failed in part ends
 * `partly-applied` with each step's result, exactly as a pressed one does.
 * One refused before it ran writes its reason on the row, where the wizard
 * reads it.
 */
@Injectable()
export class PendingSetupAutoApply implements OnApplicationBootstrap {
  private readonly logger = new Logger(PendingSetupAutoApply.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projectConfig: ProjectConfigService,
    private readonly auditLogs: AuditLogService,
    private readonly scheduling: SchedulingService,
    private readonly setupRuns: ServerSetupRuns,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // A restart cut off any Apply in flight before its plan was claimed, or
    // after: either way the next attempt reads the plan as it now is, and a
    // claimed one is no longer open, so nothing is applied twice.
    await this.db
      .update(pendingSetup)
      .set({ autoApplyState: 'waiting' })
      .where(eq(pendingSetup.autoApplyState, 'applying'));
    this.scheduling.register(
      PENDING_SETUP_AUTO_APPLY_JOB_ID,
      PENDING_SETUP_AUTO_APPLY_CRON,
      null,
      () => this.tick(),
    );
    this.setupRuns.onRunEnded(() => {
      void this.tick();
    });
  }

  /** Looks at every waiting setup once. A failure on one never stops the rest. */
  async tick(): Promise<void> {
    const waiting = await this.db
      .select({ pendingSetupId: pendingSetup.pendingSetupId })
      .from(pendingSetup)
      .where(eq(pendingSetup.autoApplyState, 'waiting'));
    for (const { pendingSetupId } of waiting) {
      await this.attempt(pendingSetupId).catch((error: unknown) =>
        this.logger.error(
          `Pending setup ${pendingSetupId}: its Apply could not be tried: ${String(error)}`,
        ),
      );
    }
  }

  /**
   * One attempt: nothing while the Server is not ready; given up when it
   * never will be; otherwise claimed and applied. Never throws for what the
   * Apply refuses: that is written on the row.
   */
  async attempt(pendingSetupId: string): Promise<void> {
    const [found] = await this.db
      .select({
        setup: pendingSetup,
        environment,
        organizationId: project.organizationId,
      })
      .from(pendingSetup)
      .innerJoin(
        environment,
        eq(environment.environmentId, pendingSetup.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(eq(pendingSetup.pendingSetupId, pendingSetupId))
      .limit(1);
    if (!found || found.setup.autoApplyState !== 'waiting') return;
    const { setup, environment: env, organizationId } = found;
    if (setup.autoApplyBy === null) {
      await this.giveUp(
        pendingSetupId,
        'waiting',
        'The person who set this app up no longer has an account, so Cloudgate will not apply it in their name. Apply its plan from the Environment',
      );
      return;
    }

    const readiness = await this.readinessOf(env);
    if (readiness.kind === 'waiting') return;
    if (readiness.kind === 'gone') {
      await this.giveUp(pendingSetupId, 'waiting', readiness.reason);
      return;
    }

    const [claimed] = await this.db
      .update(pendingSetup)
      .set({ autoApplyState: 'applying' })
      .where(
        and(
          eq(pendingSetup.pendingSetupId, pendingSetupId),
          eq(pendingSetup.autoApplyState, 'waiting'),
        ),
      )
      .returning({ id: pendingSetup.pendingSetupId });
    if (!claimed) return;

    const ctx: PermissionCtx = {
      user: { id: setup.autoApplyBy },
      session: { activeOrganizationId: organizationId },
    };
    try {
      const applied = await this.apply(ctx, env.environmentId, pendingSetupId);
      await this.auditLogs.audit(
        { userId: ctx.user.id, organizationId },
        {
          // Recorded as the Apply pressed by hand is (`AuditInterceptor`).
          ...auditTargetFor('POST', APPLY_ROUTE)!,
          resourceId: env.environmentId,
          resourceName: env.name,
          metadata: {
            route: `POST ${APPLY_ROUTE}`,
            autoApply: true,
            pendingSetupId,
            planId: applied.planId,
            status: applied.status,
          },
        },
      );
      // Gone when the Apply created every part: nothing is left to say.
      await this.db
        .update(pendingSetup)
        .set({ autoApplyState: 'applied', autoApplyMessage: null })
        .where(eq(pendingSetup.pendingSetupId, pendingSetupId));
    } catch (error) {
      if (!(error instanceof HttpException)) {
        this.logger.error(
          `Pending setup ${pendingSetupId}: its Apply failed: ${String(error)}`,
        );
      }
      await this.giveUp(
        pendingSetupId,
        'applying',
        error instanceof HttpException
          ? error.message
          : 'Cloudgate could not apply this setup. Open its plan on the Environment and Apply it',
      );
    }
  }

  /** Where a setup stands, for the Environment's Pending setups list; null when it asked for no Apply. */
  async viewOf(
    setup: Pick<PendingSetup, 'autoApplyState' | 'autoApplyMessage'>,
    env: Pick<Environment, 'deployTarget'>,
  ): Promise<AutoApplyView | null> {
    if (setup.autoApplyState === null) return null;
    if (setup.autoApplyState !== 'waiting') {
      return {
        status: setup.autoApplyState,
        waitingFor: null,
        message:
          setup.autoApplyState === 'refused' ? setup.autoApplyMessage : null,
      };
    }
    const readiness = await this.readinessOf(env);
    return {
      status: 'waiting',
      waitingFor:
        readiness.kind === 'waiting'
          ? readiness.waitingFor
          : readiness.kind === 'gone'
            ? readiness.reason
            : null,
      message: null,
    };
  }

  private readinessOf(
    env: Pick<Environment, 'deployTarget'>,
  ): Promise<AutoApplyReadiness> {
    return readinessOf(this.db, env.deployTarget, (serverId) =>
      this.setupRuns.inFlight(serverId),
    );
  }

  /**
   * Applies the Environment's open plan when it is this setup's alone; a
   * plan gone stale is made again once and applied if it still is.
   */
  private async apply(
    ctx: PermissionCtx,
    environmentId: string,
    pendingSetupId: string,
  ): Promise<PlanView> {
    const open = await this.openPlanOf(environmentId);
    const first =
      open && createsOnly(open.steps, pendingSetupId)
        ? open
        : await this.projectConfig.requestPlan(ctx, environmentId);
    try {
      return await this.applyIfOurs(ctx, environmentId, first, pendingSetupId);
    } catch (error) {
      if (!isStale(error)) throw error;
      const again = await this.projectConfig.requestPlan(ctx, environmentId);
      return this.applyIfOurs(ctx, environmentId, again, pendingSetupId);
    }
  }

  private async applyIfOurs(
    ctx: PermissionCtx,
    environmentId: string,
    found: Pick<PlanView, 'planId' | 'status' | 'steps'>,
    pendingSetupId: string,
  ): Promise<PlanView> {
    if (found.status !== 'open') {
      throw new ConflictException(
        'There is no plan to apply for this setup any more. Open the Environment to see what is there',
      );
    }
    if (!createsOnly(found.steps, pendingSetupId)) {
      throw new ConflictException(
        "The Environment's plan holds more than this app, so Cloudgate leaves it for you to review. Open the plan on the Environment and Apply it",
      );
    }
    return this.projectConfig.applyPlan(ctx, environmentId, found.planId);
  }

  private async openPlanOf(
    environmentId: string,
  ): Promise<{ planId: string; status: 'open'; steps: PlanStep[] } | null> {
    const [open] = await this.db
      .select({ planId: plan.planId, steps: plan.steps })
      .from(plan)
      .where(
        and(eq(plan.environmentId, environmentId), eq(plan.status, 'open')),
      )
      .limit(1);
    return open ? { ...open, status: 'open' } : null;
  }

  /** Stops trying, saying why, unless another attempt moved the row on first. */
  private async giveUp(
    pendingSetupId: string,
    from: AutoApplyState,
    message: string,
  ): Promise<void> {
    await this.db
      .update(pendingSetup)
      .set({ autoApplyState: 'refused', autoApplyMessage: message })
      .where(
        and(
          eq(pendingSetup.pendingSetupId, pendingSetupId),
          eq(pendingSetup.autoApplyState, from),
        ),
      );
  }
}

/** Whether every step creates a part of this setup, and there is at least one. */
export function createsOnly(
  steps: readonly PlanStep[],
  pendingSetupId: string,
): boolean {
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        step.action === 'create' &&
        step.template?.pendingSetupId === pendingSetupId,
    )
  );
}

function isStale(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === PLAN_STALE_CODE
  );
}
