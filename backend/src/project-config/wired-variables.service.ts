import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { parse as parseDotenv } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

import { application } from '../applications/application.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, project, projectConfigLocation } from '../db/schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { keepKeys } from './applier/dotenv-keys';
import { ConsoleSaves, writeKept } from './console-saves';
import { parseProjectConfig } from './format/parse-config';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { isLinkingType } from './outputs';
import type { LinkingType } from './outputs';
import { canonical } from './planner/plan-environment';
import { linkableSources } from './planner/plan-links';
import type { LinkableSource } from './planner/plan-links';
import type { ConfigLinks } from './project-config.types';
import { readSavedServices } from './saved-settings';

/** One wired variable as the console shows it: never a value (ADR-0019). */
export interface WiredVariable {
  readonly name: string;
  readonly source: string;
  readonly output: string;
}

/** A Service's wired variables, and what the console may do with them. */
export interface WiredVariablesView {
  readonly serviceType: LinkingType;
  readonly serviceId: string;
  readonly configName: string;
  /**
   * Where the Project's config is kept: the console writes a link into a
   * Cloudgate-kept one, a repository-kept one's file is the only place a
   * link is set, and a Project with none has no links.
   */
  readonly keptIn: 'cloudgate' | 'repository' | null;
  /** Whether a console Save may set links: Cloudgate-kept, and the config describes it. */
  readonly editable: boolean;
  readonly links: readonly WiredVariable[];
  /**
   * When a source's Output changed outside a plan, so this Service reads
   * "deploy to pick up the new value" until it deploys; else `null`.
   */
  readonly wiredChangedAt: string | null;
  /** What the picker offers: the sources a plan would accept, and their Outputs. */
  readonly sources: readonly LinkableSource[];
}

/** The Service tables whose rows hold links, with the columns a link Save writes. */
const TABLES: Record<
  LinkingType,
  {
    readonly table: PgTable;
    readonly id: AnyPgColumn;
    readonly environmentId: AnyPgColumn;
    readonly configName: AnyPgColumn;
    readonly env: AnyPgColumn;
    readonly configLinks: AnyPgColumn;
    readonly wiredChangedAt: AnyPgColumn;
  }
> = {
  application: {
    table: application,
    id: application.applicationId,
    environmentId: application.environmentId,
    configName: application.configName,
    env: application.env,
    configLinks: application.configLinks,
    wiredChangedAt: application.wiredChangedAt,
  },
  postgres: {
    table: postgres,
    id: postgres.postgresId,
    environmentId: postgres.environmentId,
    configName: postgres.configName,
    env: postgres.env,
    configLinks: postgres.configLinks,
    wiredChangedAt: postgres.wiredChangedAt,
  },
  mysql: {
    table: mysql,
    id: mysql.mysqlId,
    environmentId: mysql.environmentId,
    configName: mysql.configName,
    env: mysql.env,
    configLinks: mysql.configLinks,
    wiredChangedAt: mysql.wiredChangedAt,
  },
  redis: {
    table: redis,
    id: redis.redisId,
    environmentId: redis.environmentId,
    configName: redis.configName,
    env: redis.env,
    configLinks: redis.configLinks,
    wiredChangedAt: redis.wiredChangedAt,
  },
};

interface Row {
  readonly environmentId: string;
  readonly projectId: string;
  readonly configName: string;
  readonly env: string | null;
  readonly configLinks: ConfigLinks;
  readonly wiredChangedAt: string | null;
}

/**
 * **Wired variables** from the console (ADR-0031): a Service's links
 * as rows the console shows without a value, the sources and Outputs its
 * picker offers, and the Save that sets them.
 *
 * A link is a line of the Project config, so its Save is a console Save
 * on a Cloudgate-kept config the row's applied links and the
 * config's `env` entry are written together, recorded as an applied `save`
 * plan, so the next plan has nothing to change. A link the plan would
 * refuse is refused with it. A repository-kept config's file is the only
 * place a link is set, and a Project with no config has no links.
 */
@Injectable()
export class WiredVariablesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly consoleSaves: ConsoleSaves,
    private readonly auditLogs: AuditLogService,
  ) {}

  async findOne(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
  ): Promise<WiredVariablesView> {
    const type = linkingType(serviceType);
    await this.permissions.checkServiceAccess(ctx, serviceId, 'read');
    return this.view(type, serviceId, await this.row(ctx, type, serviceId));
  }

  /**
   * Sets the Service's links to `links`, the whole set. A name that held a
   * typed value loses it (a variable has one source), and the Service reads
   * "deploy to pick up the new value": nothing running changes until it
   * deploys. Setting the links it has already writes nothing.
   */
  async update(
    ctx: PermissionCtx,
    serviceType: string,
    serviceId: string,
    links: readonly WiredVariable[],
  ): Promise<WiredVariablesView> {
    const type = linkingType(serviceType);
    await this.permissions.checkServiceAccess(ctx, serviceId, 'update');
    const current = await this.row(ctx, type, serviceId);
    const next: ConfigLinks = Object.fromEntries(
      links.map(({ name, source, output }) => [name, { source, output }]),
    );
    if (canonical(next) === canonical(current.configLinks)) {
      return this.view(type, serviceId, current);
    }
    const columns = TABLES[type];
    await this.consoleSaves.update(
      ctx,
      { serviceType: type, serviceId },
      (keep) =>
        writeKept(
          this.db,
          keep,
          async (tx) => {
            const typed =
              current.env === null
                ? null
                : keepKeys(
                    current.env,
                    new Set(
                      Object.keys(parseDotenv(current.env)).filter(
                        (key) => !Object.hasOwn(next, key),
                      ),
                    ),
                  );
            await tx
              .update(columns.table)
              .set({
                env: typed,
                configLinks: next,
                wiredChangedAt: new Date().toISOString(),
              })
              .where(eq(columns.id, serviceId));
          },
          () => ({ serviceId }),
        ),
      { links: true },
    );
    // Written here rather than by the interceptor: the route's first segment
    // names no kind, and its kind is the `:serviceType` it was sent. The
    // links' names only; a link has no value to leak.
    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId: ctx.session.activeOrganizationId },
      {
        action: 'update',
        resourceType: type === 'application' ? 'application' : 'database',
        resourceId: serviceId,
        resourceName: current.configName,
        metadata: { links: Object.keys(next).sort() },
      },
    );
    return this.view(type, serviceId, await this.row(ctx, type, serviceId));
  }

  private async view(
    serviceType: LinkingType,
    serviceId: string,
    row: Row,
  ): Promise<WiredVariablesView> {
    const [location] = await this.db
      .select({
        kind: projectConfigLocation.kind,
        text: projectConfigLocation.text,
      })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, row.projectId))
      .limit(1);
    const keptIn = location?.kind ?? null;
    let sources: LinkableSource[] = [];
    let editable = false;
    const parsed =
      keptIn === 'cloudgate' && location?.text
        ? parseProjectConfig(location.text)
        : null;
    if (parsed?.ok) {
      const entry = parsed.config.services[row.configName];
      editable = entry !== undefined && entry.managed !== 'console';
      const [env] = await this.db
        .select({ deployTarget: environment.deployTarget })
        .from(environment)
        .where(eq(environment.environmentId, row.environmentId))
        .limit(1);
      sources = editable
        ? linkableSources(
            {
              config: parsed.config,
              saved: await readSavedServices(this.db, row.environmentId),
              deployTarget: env?.deployTarget ?? { kind: 'platform-host' },
              context: { previous: parsed.config },
            },
            row.configName,
          )
        : [];
    }
    return {
      serviceType,
      serviceId,
      configName: row.configName,
      keptIn,
      editable,
      links: Object.entries(row.configLinks).map(([name, link]) => ({
        name,
        source: link.source,
        output: link.output,
      })),
      wiredChangedAt: row.wiredChangedAt,
      sources,
    };
  }

  /** The Service's row, inside the caller's organization. */
  private async row(
    ctx: PermissionCtx,
    serviceType: LinkingType,
    serviceId: string,
  ): Promise<Row> {
    const columns = TABLES[serviceType];
    const [found] = (await this.db
      .select({
        environmentId: columns.environmentId,
        projectId: project.projectId,
        configName: columns.configName,
        env: columns.env,
        configLinks: columns.configLinks,
        wiredChangedAt: columns.wiredChangedAt,
      })
      .from(columns.table)
      .innerJoin(
        environment,
        eq(columns.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(columns.id, serviceId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1)) as Row[];
    if (!found) throw new NotFoundException('Service not found');
    return { ...found, configLinks: found.configLinks ?? {} };
  }
}

function linkingType(serviceType: string): LinkingType {
  if (!isLinkingType(serviceType)) {
    throw new NotFoundException(
      `A ${serviceType} has no variables to link; only an Application, a postgres, a mysql or a redis has`,
    );
  }
  return serviceType;
}
