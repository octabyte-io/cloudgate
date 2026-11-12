import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, isNull } from 'drizzle-orm';

import type { Env } from '../../common/config/env.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  environment,
  plan,
  project,
  projectConfigLocation,
} from '../../db/schema';
import { CONSOLE_BACKEND_PREFIX } from '../../git-providers/oauth-callback.util';
import { InstanceUrlService } from '../../settings/instance-url.service';
import { parseProjectConfig } from '../format/parse-config';
import { isNetworkStep, movesConsoleStackVm } from '../planner/cloud-steps';
import { outlineOf } from '../planner/config-outline';
import { planEnvironment } from '../planner/plan-environment';
import {
  readSavedServices,
  settingsFingerprint,
  textHash,
} from '../saved-settings';
import { generateProjectConfig } from './generate-config';

/** Where the backend serves the JSON Schema (`ProjectConfigSchemaController`). */
const SCHEMA_PATH = '/schema/project-config/v1.json';

/**
 * Generation at upgrade: every Project with no config gets a
 * generated, Cloudgate-kept one, so "every Project has one" has no exception.
 *
 * It runs at boot, after the migrations — the Config-name backfill (0095)
 * among them — which `db:migrate` applies before the app starts. It is
 * idempotent: it touches only Projects with no config location row, and the
 * insert yields to one written meanwhile (a Project created now starts with
 * its empty config in its own transaction). **It writes nothing but that
 * row and each Environment's first plan** — source `generate`, `unchanged`,
 * so the plan record says where the config came from (US36) — and no
 * Service setting and no Deployment: the generator proves, by demotion, that
 * the config's first plan in every Environment is empty, so there is
 * nothing to apply.
 *
 * Tolerant, like every boot step: a Project that cannot be generated is
 * logged and left for the next start, and it never fails boot.
 */
@Injectable()
export class ConfigGenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConfigGenerationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceUrl: InstanceUrlService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const generated = await this.generateMissing();
      if (generated > 0) {
        this.logger.log(
          `Generated a Project config for ${generated} Project${generated === 1 ? '' : 's'} that had none`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Generating missing Project configs at boot failed',
        error,
      );
    }
  }

  /** Generates a config for each Project that has none; answers how many. */
  async generateMissing(): Promise<number> {
    const missing = await this.db
      .select({ projectId: project.projectId })
      .from(project)
      .leftJoin(
        projectConfigLocation,
        eq(projectConfigLocation.projectId, project.projectId),
      )
      .where(isNull(projectConfigLocation.projectId))
      .orderBy(project.createdAt, project.projectId);
    if (missing.length === 0) return 0;

    const schemaUrl = await this.schemaUrl();
    let generated = 0;
    for (const { projectId } of missing) {
      try {
        if (await this.generateFor(projectId, schemaUrl)) generated++;
      } catch (error) {
        this.logger.error(
          `Could not generate a Project config for ${projectId}; it is retried at the next start`,
          error,
        );
      }
    }
    return generated;
  }

  private async generateFor(
    projectId: string,
    schemaUrl: string | null,
  ): Promise<boolean> {
    const environments = await this.db
      .select({
        environmentId: environment.environmentId,
        name: environment.name,
        deployTarget: environment.deployTarget,
      })
      .from(environment)
      .where(eq(environment.projectId, projectId))
      .orderBy(environment.createdAt, environment.environmentId);
    const read = await Promise.all(
      environments.map(async (env) => ({
        environmentId: env.environmentId,
        name: env.name,
        deployTarget: env.deployTarget,
        saved: await readSavedServices(this.db, env.environmentId),
      })),
    );
    const text = generateProjectConfig({ environments: read, schemaUrl });
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(projectConfigLocation)
        .values({ projectId, kind: 'cloudgate', text })
        .onConflictDoNothing({ target: projectConfigLocation.projectId })
        .returning({ projectId: projectConfigLocation.projectId });
      if (inserted.length === 0) return false;
      for (const env of read) {
        const outcome = planEnvironment({
          config: parsed.config,
          saved: env.saved,
          deployTarget: env.deployTarget,
          context: { previous: parsed.config },
        });
        // The generator demoted until this held; a plan saying otherwise
        // would be a lie, so the Project is left for the next start. A
        // console-managed stack's Stack VM, and the network it needs, are
        // the next plan's to make or move, whatever the config says.
        if (
          !outcome.ok ||
          outcome.steps.some(
            (step) =>
              !isNetworkStep(step) && !movesConsoleStackVm(step, parsed.config),
          )
        ) {
          throw new Error(
            `The generated config still plans a change in the ${env.name} Environment`,
          );
        }
        await tx.insert(plan).values({
          environmentId: env.environmentId,
          source: 'generate',
          text,
          textHash: textHash(text),
          baseTextHash: textHash(text),
          settingsFingerprint: settingsFingerprint(env.saved, env.deployTarget),
          deployTarget: env.deployTarget,
          steps: [],
          notes: [...outcome.notes],
          outline: outlineOf(parsed.config),
          status: 'unchanged',
          createdAt: now,
        });
      }
      return true;
    });
  }

  /**
   * The schema's URL as an operator's editor reaches it: through the
   * console's origin (the instance URL setting, else `BETTER_AUTH_URL`, the
   * origin the install writes) under the console's backend prefix, which is
   * the one address every install shape publishes for the backend. `null`
   * when neither is known: there is no default host.
   */
  private async schemaUrl(): Promise<string | null> {
    const origin =
      (await this.instanceUrl.getInstanceUrl()) ??
      originOf(this.config.get('BETTER_AUTH_URL', { infer: true }));
    if (!origin) return null;
    return `${origin.replace(/\/+$/, '')}${CONSOLE_BACKEND_PREFIX}${SCHEMA_PATH}`;
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
