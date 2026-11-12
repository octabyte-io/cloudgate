import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { aiModelFacet } from '../ai-models/ai-model.schema';
import { application } from '../applications/application.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import type {
  EnvironmentTokenSpend,
  ProjectTokenSpend,
  TokenSpend,
  TokenSpendQueryDto,
} from './dto/token-spend.dto';
import {
  addDays,
  MAX_SPEND_DAYS,
  readSpendRows,
  TOKEN_SPEND_CLOCK,
  totalOf,
  toTokenSpend,
  utcDay,
} from './token-spend';
import type { SpendRow, TokenSpendClock } from './token-spend';

/** The days an Environment's or a Project's fact covers, today included. */
export const SPEND_TOTALS_DEFAULT_DAYS = 30;

/** An AI model a total may sum, with where it lives. */
interface AiModelRef {
  applicationId: string;
  name: string;
  environmentId: string;
}

/**
 * Reading **Token spend**: day grain only, from the
 * rollups plus the raw rows the nightly job has not rolled yet, today's
 * always among them.
 */
@Injectable()
export class TokenSpendService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    @Inject(TOKEN_SPEND_CLOCK) private readonly clock: TokenSpendClock,
  ) {}

  /**
   * One AI model's spend over `from`..`to`, by day and by Agent × model
   * served.
   *
   * Read access to the AI model is the whole gate, with no statement of its
   * own (story 79): whoever can read the Application can read what was
   * spent on it. A plain Application is 404, as a missing one is: it has no
   * spend to read.
   */
  async forAiModel(
    ctx: PermissionCtx,
    applicationId: string,
    query: TokenSpendQueryDto,
  ): Promise<TokenSpend> {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const [found] = await this.db
      .select({ createdAt: aiModelFacet.createdAt })
      .from(aiModelFacet)
      .innerJoin(
        application,
        eq(application.applicationId, aiModelFacet.applicationId),
      )
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(aiModelFacet.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('AI model not found');

    const created = found.createdAt.slice(0, 10);
    const { from, to, today } = this.window(query, (to) =>
      created < to ? created : to,
    );
    const rows = await readSpendRows(this.db, [applicationId], from, to, today);
    return toTokenSpend(rows, from, to);
  }

  /**
   * An Environment's spend over `from`..`to` (default: the 30 days ending
   * today), by day, and each AI model's total — summing only the AI models
   * in it the reader can read (story 77).
   *
   * Spend is the AI model's, wherever the calling Agent lives (story
   * 68): the rows are keyed by the AI model, so an Agent of another Project
   * calling a model here counts here, and only here.
   */
  async forEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
    query: TokenSpendQueryDto,
  ): Promise<EnvironmentTokenSpend> {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'read');
    const [found] = await this.db
      .select({ environmentId: environment.environmentId })
      .from(environment)
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Environment not found');

    const { from, to, today } = this.window(query, defaultTotalsFrom);
    const models = await this.readableAiModels(ctx, [environmentId]);
    const rows = await readSpendRows(
      this.db,
      models.map((model) => model.applicationId),
      from,
      to,
      today,
    );
    const { total, days } = toTokenSpend(rows, from, to);
    const byModel = groupBy(rows, (row) => row.applicationId);
    return {
      from,
      to,
      total,
      days,
      aiModels: models.map(({ applicationId, name }) => ({
        applicationId,
        name,
        total: totalOf(byModel.get(applicationId) ?? []),
      })),
    };
  }

  /**
   * A Project's spend over `from`..`to` (default: the 30 days ending today),
   * by day, and each Environment's total (story 76).
   *
   * Sums the AI models the reader can read, in the Environments the reader
   * can see — a restricted member's `accessedEnvironments`, as the Project's
   * Environment list scopes them — so the total is the sum of the breakdown
   * and neither names an Environment the Project page would not.
   */
  async forProject(
    ctx: PermissionCtx,
    projectId: string,
    query: TokenSpendQueryDto,
  ): Promise<ProjectTokenSpend> {
    await this.permissions.checkProjectAccess(ctx, 'read', projectId);
    const [found] = await this.db
      .select({ projectId: project.projectId })
      .from(project)
      .where(
        and(
          eq(project.projectId, projectId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Project not found');

    const { from, to, today } = this.window(query, defaultTotalsFrom);
    const memberRecord = await this.permissions.findMember(ctx);
    const privileged =
      memberRecord.role === 'owner' || memberRecord.role === 'admin';
    const environments = (
      await this.db
        .select({
          environmentId: environment.environmentId,
          name: environment.name,
        })
        .from(environment)
        .where(eq(environment.projectId, projectId))
        .orderBy(asc(environment.createdAt))
    ).filter(
      ({ environmentId }) =>
        privileged || memberRecord.accessedEnvironments.includes(environmentId),
    );
    const models = await this.readableAiModels(
      ctx,
      environments.map((env) => env.environmentId),
    );
    const rows = await readSpendRows(
      this.db,
      models.map((model) => model.applicationId),
      from,
      to,
      today,
    );
    const { total, days } = toTokenSpend(rows, from, to);
    const environmentOf = new Map(
      models.map((model) => [model.applicationId, model.environmentId]),
    );
    const byEnvironment = groupBy(
      rows,
      (row) => environmentOf.get(row.applicationId) ?? '',
    );
    return {
      from,
      to,
      total,
      days,
      environments: environments.map(({ environmentId, name }) => ({
        environmentId,
        name,
        aiModelCount: models.filter(
          (model) => model.environmentId === environmentId,
        ).length,
        total: totalOf(byEnvironment.get(environmentId) ?? []),
      })),
    };
  }

  /**
   * The AI models in `environmentIds` the reader can read: each one passes
   * `checkServiceAccess(…, 'read')`, the gate of its own spend read, so a
   * total never sums a model whose own figure the reader would be refused.
   */
  private async readableAiModels(
    ctx: PermissionCtx,
    environmentIds: string[],
  ): Promise<AiModelRef[]> {
    if (environmentIds.length === 0) return [];
    const models = await this.db
      .select({
        applicationId: application.applicationId,
        name: application.name,
        environmentId: application.environmentId,
      })
      .from(aiModelFacet)
      .innerJoin(
        application,
        eq(application.applicationId, aiModelFacet.applicationId),
      )
      .where(inArray(application.environmentId, environmentIds))
      .orderBy(asc(application.name));
    const readable: AiModelRef[] = [];
    for (const model of models) {
      try {
        await this.permissions.checkServiceAccess(
          ctx,
          model.applicationId,
          'read',
        );
        readable.push(model);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    return readable;
  }

  /**
   * The read's days: `to` defaults to today, `from` to `defaultFrom(to)`;
   * refused when backwards or longer than {@link MAX_SPEND_DAYS}.
   */
  private window(
    query: TokenSpendQueryDto,
    defaultFrom: (to: string) => string,
  ): { from: string; to: string; today: string } {
    const today = utcDay(this.clock());
    const to = query.to ?? today;
    const from = query.from ?? defaultFrom(to);
    if (from > to) {
      throw new BadRequestException('From must not be after to');
    }
    if (addDays(from, MAX_SPEND_DAYS) <= to) {
      throw new BadRequestException(
        `A Token spend read covers at most ${MAX_SPEND_DAYS} days`,
      );
    }
    return { from, to, today };
  }
}

/** The first day of the {@link SPEND_TOTALS_DEFAULT_DAYS} ending `to`. */
function defaultTotalsFrom(to: string): string {
  return addDays(to, 1 - SPEND_TOTALS_DEFAULT_DAYS);
}

function groupBy(
  rows: SpendRow[],
  keyOf: (row: SpendRow) => string,
): Map<string, SpendRow[]> {
  const groups = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}
