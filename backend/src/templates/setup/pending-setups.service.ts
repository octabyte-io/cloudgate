import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';

import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  environment,
  expiredSetup,
  pendingSetup,
  plan,
  project,
  projectConfigLocation,
} from '../../db/schema';
import type { Environment } from '../../db/schema';
import type { DrizzleTx } from '../../environments/config-name';
import { configNamesIn } from '../../environments/config-name';
import { ProjectConfigService, serviceEntries } from '../../project-config';
import type { PlanView } from '../../project-config';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import type { PendingSetup } from './pending-setup.schema';
import { PendingSetupAutoApply } from './pending-setup-auto-apply.service';
import type { AutoApplyView } from './pending-setup-auto-apply.service';
import { dropPendingSetups, dropUnusedSetupRecords } from './pending-setups';
import { pendingSetupView } from './template-setups.service';
import type { PendingSetupView } from './template-setups.service';

/** How long a Pending setup waits before the sweep drops it (ADR-0065). */
export const PENDING_SETUP_DAYS = 30;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A Pending setup as its Environment lists it: no value, only presence. */
export interface ListedPendingSetup extends PendingSetupView {
  readonly templateName: string;
  /** The Config names it has not created yet. */
  readonly configNames: readonly string[];
  /** When the sweep drops it, unless an Apply uses it up first. */
  readonly expiresAt: string;
  /**
   * Where the Apply Cloudgate makes for a get-started wizard's setup stands
   * (ADR-0073); null for every other setup, whose plan waits for Apply.
   */
  readonly autoApply: AutoApplyView | null;
}

/** The note a setup the sweep dropped leaves on its Environment. */
export interface ExpiredSetupNote {
  readonly expiredSetupId: string;
  readonly templateId: string;
  readonly templateName: string;
  readonly setupName: string;
  readonly configNames: readonly string[];
  readonly setUpAt: string;
  readonly expiredAt: string;
}

export interface PendingSetupList {
  readonly pendingSetups: readonly ListedPendingSetup[];
  /** Setups the 30-day sweep dropped here, newest first. */
  readonly expired: readonly ExpiredSetupNote[];
}

export interface CancelledPendingSetup {
  readonly pendingSetup: ListedPendingSetup;
  /**
   * The Environment's plan made again after the cancel, when its open plan
   * was to create the cancelled parts; null when it was not, or when that
   * plan could not be made (the open plan then stays, and its Apply refuses
   * the parts the cancel took away).
   */
  readonly plan: PlanView | null;
}

/**
 * An Environment's **Pending setups**, listed and cancelled (ADR-0065
 * "When it is dropped"; #1374). Listing asks `environment: read`, cancelling
 * `environment: update`, each past the Environment's row-level check. Each
 * value is reported as present, never as itself (ADR-0019). No Agent reaches
 * either: an Agent's key is refused on every REST route (ADR-0023) and no MCP
 * tool calls these, since a Pending setup holds secrets.
 */
@Injectable()
export class PendingSetups {
  private readonly logger = new Logger(PendingSetups.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly projectConfig: ProjectConfigService,
    private readonly autoApply: PendingSetupAutoApply,
  ) {}

  /** The Environment's Pending setups, oldest first, and the sweep's notes. */
  async list(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<PendingSetupList> {
    const env = await this.environmentOf(ctx, environmentId, 'read');
    const [rows, notes] = await Promise.all([
      this.db
        .select()
        .from(pendingSetup)
        .where(eq(pendingSetup.environmentId, environmentId))
        .orderBy(asc(pendingSetup.createdAt)),
      this.db
        .select()
        .from(expiredSetup)
        .where(eq(expiredSetup.environmentId, environmentId))
        .orderBy(desc(expiredSetup.createdAt)),
    ]);
    const pendingSetups: ListedPendingSetup[] = [];
    for (const row of rows) {
      pendingSetups.push(listed(row, await this.autoApply.viewOf(row, env)));
    }
    return {
      pendingSetups,
      expired: notes.map((note) => ({
        expiredSetupId: note.expiredSetupId,
        templateId: note.templateId,
        templateName: note.templateName,
        setupName: note.setupName,
        configNames: note.configNames,
        setUpAt: note.setUpAt,
        expiredAt: note.createdAt,
      })),
    };
  }

  /**
   * Cancels one Pending setup: drops it, and its Setup record when that then
   * records nothing. On a Cloudgate-kept config whose open plan was to
   * create its parts, the Environment is planned again from the stored text,
   * which no longer carries those parts forward (ADR-0065's amendment), so
   * the plan on screen is not one whose Apply must refuse.
   */
  async cancel(
    ctx: PermissionCtx,
    environmentId: string,
    pendingSetupId: string,
  ): Promise<CancelledPendingSetup> {
    const env = await this.environmentOf(ctx, environmentId, 'update');
    const dropped = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(pendingSetup)
        .where(
          and(
            eq(pendingSetup.pendingSetupId, pendingSetupId),
            eq(pendingSetup.environmentId, environmentId),
          ),
        )
        .for('update');
      if (!row) throw new NotFoundException('Pending setup not found');
      await dropSetups(tx, env, [row.pendingSetupId]);
      return row;
    });
    return {
      pendingSetup: listed(dropped, null),
      plan: await this.planAgain(ctx, env, pendingSetupId),
    };
  }

  /**
   * Plans the Environment again when its open plan creates a part of the
   * cancelled setup and its config is Cloudgate-kept. A repository-kept
   * config's plans come from pushes, and its open plan is left for the next
   * one. A refused plan is not the cancel's failure: the cancel has
   * happened, and the open plan's Apply refuses the parts it lost.
   */
  private async planAgain(
    ctx: PermissionCtx,
    env: Environment,
    pendingSetupId: string,
  ): Promise<PlanView | null> {
    const [location] = await this.db
      .select({ kind: projectConfigLocation.kind })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, env.projectId));
    if (location?.kind !== 'cloudgate') return null;
    const [open] = await this.db
      .select({ steps: plan.steps })
      .from(plan)
      .where(
        and(eq(plan.environmentId, env.environmentId), eq(plan.status, 'open')),
      )
      .limit(1);
    const used = open?.steps.some(
      (step) =>
        step.action === 'create' &&
        step.template?.pendingSetupId === pendingSetupId,
    );
    if (!used) return null;
    try {
      return await this.projectConfig.requestPlan(ctx, env.environmentId);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.logger.warn(
        `The plan of ${env.name} was not made again after a cancelled Pending setup: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * The Environment, in the caller's organization, past its row-level check
   * at `action`; the check comes first, so a caller without it learns
   * nothing about whether the id resolves.
   */
  private async environmentOf(
    ctx: PermissionCtx,
    environmentId: string,
    action: 'read' | 'update',
  ): Promise<Environment> {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, action);
    const [found] = await this.db
      .select({ environment })
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
    return found.environment;
  }
}

/**
 * ADR-0019: each value as present; the parts' names; when it expires; and
 * where a wizard setup's Apply stands.
 */
function listed(
  row: PendingSetup,
  autoApply: AutoApplyView | null,
): ListedPendingSetup {
  return {
    autoApply,
    ...pendingSetupView(row.pendingSetupId, row),
    templateName: row.templateName,
    configNames: row.parts.map((part) => part.configName),
    expiresAt: new Date(
      Date.parse(row.createdAt) + PENDING_SETUP_DAYS * DAY_MS,
    ).toISOString(),
  };
}

/**
 * Drops these Pending setups of one Environment, and each Setup record that
 * then records nothing: no Pending setup points at it, none of its Config
 * names is in the Project's stored text, and no Service in the Project has
 * one (a part an Apply made, which a repository-kept config's stored text
 * would not show). Shared by the cancel and the sweep.
 */
export async function dropSetups(
  tx: DrizzleTx,
  env: Pick<Environment, 'environmentId' | 'projectId'>,
  pendingSetupIds: readonly string[],
): Promise<void> {
  const records = await dropPendingSetups(
    tx,
    env.environmentId,
    pendingSetupIds,
  );
  if (records.length === 0) return;
  const [location] = await tx
    .select({ text: projectConfigLocation.text })
    .from(projectConfigLocation)
    .where(eq(projectConfigLocation.projectId, env.projectId));
  const environmentIds = (
    await tx
      .select({ environmentId: environment.environmentId })
      .from(environment)
      .where(eq(environment.projectId, env.projectId))
  ).map((row) => row.environmentId);
  await dropUnusedSetupRecords(
    tx,
    records,
    new Set([
      ...serviceEntries(location?.text ?? '').keys(),
      ...(await configNamesIn(tx, environmentIds)),
    ]),
  );
}
