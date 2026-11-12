import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';

import type { ServiceType } from '../../applications/application.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import { HELD_BUILDS } from '../../deployments/held-builds.port';
import type { HeldBuilds } from '../../deployments/held-builds.port';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  application,
  environment,
  gitProvider,
  mysql,
  plan,
  postgres,
  projectConfigLocation,
  redis,
} from '../../db/schema';
import type { DrizzleTx } from '../../environments/config-name';
import { SERVICE_SOURCES } from '../../environments/environment-services';
import type { PermissionCtx } from '../../rbac/permission.service';
import { leftoversOf } from '../applier/leftovers';
import type { PlanStepResult } from '../applier/apply.types';
import { parseProjectConfig } from '../format/parse-config';
import { isNetworkStep, movesConsoleStackVm } from '../planner/cloud-steps';
import { canonical, planEnvironment } from '../planner/plan-environment';
import type {
  DeployTarget,
  PlanStep,
  ServiceStep,
  SavedService,
} from '../planner/plan.types';
import type { ProjectConfig } from '../project-config.types';
import { CONFIG_READER } from '../reader/config-reader.port';
import type {
  ConfigReader,
  ConfigReadResult,
} from '../reader/config-reader.port';
import { readPlace } from '../reader/repository-place';
import type { RepositoryPlace } from '../reader/repository-place';
import { isExpressibleServiceType } from '../format/config-schema';
import { outlineOfText } from '../planner/config-outline';
import {
  readSavedServices,
  settingsFingerprint,
  textHash,
} from '../saved-settings';
import {
  CONFIG_UNREADABLE_CODE,
  pointedAt,
  repositoryKept,
} from './repository-kept';
import type { ConfigPointer } from './repository-kept';
import { movedFields, rewriteEntry } from './rewrite-entry';

/**
 * Set while a stored plan is being applied: the Applier writes through the
 * same per-kind create, update and Delete paths a console Save does, and
 * those writes are the plan's own, not Saves of their own.
 */
const applyingPlan = new AsyncLocalStorage<true>();

/**
 * Runs `apply` as a plan's Apply: any Service write inside it is
 * the plan's step, so it is not kept in step with the config as a console
 * Save — the Apply stores the plan's own text once its steps have run.
 */
export function whilePlanApplies<T>(apply: () => Promise<T>): Promise<T> {
  return applyingPlan.run(true, apply);
}

/** Which Service a console write is about, before it runs. */
export type ConsoleEdit =
  | {
      readonly action: 'create';
      readonly serviceType: ServiceType;
      readonly environmentId: string;
    }
  | {
      readonly action: 'update' | 'delete';
      readonly serviceType: ServiceType;
      readonly serviceId: string;
    };

/** What a console write tells the seam once its row is written. */
export interface Written {
  /** The Service written; a create's new id. */
  readonly serviceId: string;
  /** A Delete's answer, for what it left behind. */
  readonly removed?: object;
}

/**
 * Called by a console write inside the transaction that writes its row: the
 * config's rewrite and the `save` plan commit with the write or not at all.
 */
export type KeepConfig = (tx: DrizzleTx, written: Written) => Promise<void>;

/** What a write is handed when nothing is kept: no config, or a plan's step. */
export const KEEP_NOTHING: KeepConfig = () => Promise.resolve();

/** The refusal of a console write the config could not take (ADR-0005). */
export const PROJECT_CONFIG_NOT_KEPT_CODE = 'PROJECT_CONFIG_NOT_KEPT';

/**
 * The refusal of a link Save where no config is kept by Cloudgate: a
 * link is a line of the Project config (ADR-0031), so a Project without one
 * has nowhere to write it.
 */
export const LINK_NEEDS_CONFIG_CODE = 'LINK_NEEDS_PROJECT_CONFIG';

/** The refusal of a link Save its plan would refuse (`plan-links.ts`). */
export const LINK_REFUSED_CODE = 'LINK_REFUSED';

/** What kind of console write a Save is, past which Service it touches. */
export interface SaveOptions {
  /**
   * The write sets the Service's wired variables: it is written into
   * the config or refused, never made on the row alone.
   */
  readonly links?: boolean;
}

/**
 * Runs the config's side of a Save, turning an unexpected failure into a
 * refusal of the whole write: the console and the config never disagree, so
 * a write the config cannot take is not made.
 */
async function notKept<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ConflictException(
      {
        message:
          "This change could not be written into the Project's config, so nothing was saved",
        code: PROJECT_CONFIG_NOT_KEPT_CODE,
      },
      { cause: error },
    );
  }
}

/**
 * What happens to a console write, by where the Project's config is kept:
 * written as it is, kept in step with a Cloudgate-kept text, or checked
 * against a repository-kept file it may not get ahead of.
 */
type Route =
  | { readonly kind: 'direct' }
  | { readonly kind: 'keep' }
  | { readonly kind: 'repository'; readonly place: EnvironmentPlace };

/** Where a repository-kept config is read for one Environment. */
interface EnvironmentPlace extends RepositoryPlace {
  /** The Environment's Config branch; `null` is the default branch. */
  readonly configBranch: string | null;
  readonly deployTarget: DeployTarget;
}

/** How a refusal names a kind the config describes. */
const KIND_WORDS: Partial<Record<ServiceType, string>> = {
  application: 'web or static Service',
  postgres: 'postgres',
  mysql: 'mysql',
  redis: 'redis',
  bucket: 'bucket',
  compose: 'Compose stack',
};

interface Target {
  readonly projectId: string;
  readonly environmentId: string;
  /** `null` for a create, whose Service does not exist yet. */
  readonly configName: string | null;
}

/**
 * Console Saves on a Cloudgate-kept config (ADR-0029): the console's
 * own Service create, update and Delete paths call this around their write,
 * so the console and the config never disagree.
 *
 * The write itself runs as it always has — same request, same statements,
 * same answer, no Deployment queued — and, inside the transaction that
 * writes its row, calls back ({@link KeepConfig}) so that, holding the
 * config's row, the stored text has the touched Service's one entry
 * rewritten from the saved settings ({@link rewriteEntry}). The two commit
 * together or not at all: a rewrite that fails refuses the write
 * (`PROJECT_CONFIG_NOT_KEPT`). When
 * the Environment's plan of that text against its settings before the write
 * has a step, it is recorded as a `save` plan, applied, whose step is the
 * write: a create, a change, or a Delete's destroy with its leftovers. A
 * write that leaves the text agreeing (a Cloudgate-owned field, a
 * console-managed Service) rewrites nothing and records no plan.
 *
 * **Why the Applier does not run the Save.** It would queue a Deployment, ask
 * `deployment: create`, resolve the git connection and branch itself, and
 * create a `web` with a generated Domain — none of which a console Save has
 * ever done. A Save's write is the very per-kind path an Apply's step goes
 * through, so the plan records it rather than re-running it.
 *
 * A Project with no config row writes directly, and a repository-kept
 * config refuses what only its file can say (`lockedSave`);
 * {@link route} is the one place that decides it.
 */
@Injectable()
export class ConsoleSaves {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * A console create. `write` calls `keep` inside the transaction that
   * inserts the Service, naming it. `ctx` is `null` only for a caller with
   * no request context (a template deploy's insert), which can only create a
   * console-managed kind.
   */
  async create<T>(
    ctx: PermissionCtx | null,
    edit: { serviceType: ServiceType; environmentId: string },
    write: (keep: KeepConfig) => Promise<T>,
  ): Promise<T> {
    return this.save(ctx, { action: 'create', ...edit }, write);
  }

  /**
   * A console write to an existing Service's settings. `write` calls `keep`
   * inside the transaction that writes them.
   */
  async update<T>(
    ctx: PermissionCtx,
    edit: { serviceType: ServiceType; serviceId: string },
    write: (keep: KeepConfig) => Promise<T>,
    options: SaveOptions = {},
  ): Promise<T> {
    return this.save(ctx, { action: 'update', ...edit }, write, options);
  }

  /**
   * A console Delete. `write` calls `keep` inside the transaction that
   * deletes the row, with what the Delete left behind; its answer is the
   * Delete's own. The rewrite is worked out once before the Delete starts,
   * so a config that cannot take it refuses the Delete before anything on a
   * machine is torn down.
   */
  async remove<T>(
    ctx: PermissionCtx,
    edit: { serviceType: ServiceType; serviceId: string },
    write: (keep: KeepConfig) => Promise<T>,
  ): Promise<T> {
    return this.save(ctx, { action: 'delete', ...edit }, write);
  }

  private async save<T>(
    ctx: PermissionCtx | null,
    edit: ConsoleEdit,
    write: (keep: KeepConfig) => Promise<T>,
    options: SaveOptions = {},
  ): Promise<T> {
    if (applyingPlan.getStore()) return write(KEEP_NOTHING);
    // An update to a kind the config cannot describe owns no config field.
    if (
      edit.action === 'update' &&
      !isExpressibleServiceType(edit.serviceType)
    ) {
      return write(KEEP_NOTHING);
    }
    const target = await this.findTarget(edit);
    const route = target === null ? null : await this.route(target);
    if (target === null || route === null || route.kind === 'direct') {
      if (options.links) {
        throw new ConflictException({
          message:
            'A wired variable is a line of the Project config, and this Project has no config kept by Cloudgate to write it in',
          code: LINK_NEEDS_CONFIG_CODE,
        });
      }
      return write(KEEP_NOTHING);
    }
    if (route.kind === 'repository') {
      return this.lockedSave(edit, target, route.place, write);
    }

    const before = await readSavedServices(this.db, target.environmentId);
    if (edit.action === 'delete') {
      await notKept(() =>
        this.rewrite(this.db, edit, target, edit.serviceId, edit.serviceId),
      );
    }
    let recorded = false;
    const result = await write(async (tx, written) => {
      recorded = await notKept(() =>
        this.keepInStep(tx, ctx, edit, target, before, written, options),
      );
    });
    // A recorded Save replaced the Environment's open plan; the builds that
    // plan held are released once the write has committed.
    if (recorded) await this.releaseHeld(target.environmentId);
    return result;
  }

  /**
   * `DeploymentsService.releaseHeldOutsideOpenPlans`, resolved at call time
   * through its port: `DeploymentsModule` reaches the Service modules that
   * import this one, so it cannot be imported here.
   */
  private async releaseHeld(environmentId: string) {
    await this.moduleRef
      .get<HeldBuilds>(HELD_BUILDS, { strict: false })
      .releaseHeldOutsideOpenPlans(environmentId);
  }

  /**
   * Where the Project's config is kept decides the write. A Cloudgate-kept
   * config is rewritten; a repository-kept one is never written by the
   * console, so a write it would have to take is refused; a Project
   * with none writes directly, as before configs existed.
   */
  private async route(target: Target): Promise<Route> {
    const [location] = await this.db
      .select({
        kind: projectConfigLocation.kind,
        gitProviderId: projectConfigLocation.gitProviderId,
        providerType: gitProvider.providerType,
        repository: projectConfigLocation.repository,
        path: projectConfigLocation.path,
      })
      .from(projectConfigLocation)
      .leftJoin(
        gitProvider,
        eq(projectConfigLocation.gitProviderId, gitProvider.gitProviderId),
      )
      .where(eq(projectConfigLocation.projectId, target.projectId))
      .limit(1);
    if (location?.kind === 'cloudgate') return { kind: 'keep' };
    if (location?.kind !== 'repository') return { kind: 'direct' };
    const [env] = await this.db
      .select({
        configBranch: environment.configBranch,
        deployTarget: environment.deployTarget,
      })
      .from(environment)
      .where(eq(environment.environmentId, target.environmentId))
      .limit(1);
    return {
      kind: 'repository',
      place: {
        gitProviderId: location.gitProviderId,
        providerType: location.providerType,
        repository: location.repository ?? '',
        path: location.path ?? '',
        configBranch: env?.configBranch ?? null,
        deployTarget: env?.deployTarget ?? { kind: 'platform-host' },
      },
    };
  }

  /**
   * A console write on a repository-kept config (US56–US59): the file
   * is the one record of what it describes, so the console never writes
   * what only the file can say. Refused, with a pointer to the file and the
   * Environment's branch, are a new Service of a kind the config describes,
   * the Delete of a Service the file describes, and a settings write that
   * would change what a plan of the file finds for its Service — a
   * config-owned field, one of the seven Swarm settings `native.docker`
   * owns on a Service Swarm runs, or a variable name the file does
   * not list. Placement, networks, published ports, the mode and the replica
   * count are Cloudgate's, so they, Cloudgate's other own settings, variable
   * values and console-managed kinds write as before;
   * so does any write to a Service the file lists as `managed: console` or
   * does not list (its next plan destroys or notes it, as it would anyway).
   *
   * The file is read only when the answer depends on it: a settings write
   * whose config-owned view did not move never reads it, so an unreachable
   * repository blocks nothing Cloudgate owns. One that cannot be read when
   * it does matter is refused (`CONFIG_UNREADABLE`): there is no fallback
   * copy to decide by (ADR-0029).
   */
  private async lockedSave<T>(
    edit: ConsoleEdit,
    target: Target,
    place: EnvironmentPlace,
    write: (keep: KeepConfig) => Promise<T>,
  ): Promise<T> {
    if (!isExpressibleServiceType(edit.serviceType)) return write(KEEP_NOTHING);

    // A new Compose stack is console-managed until its operator hands
    // it over (ADR-0069), and a template's never can be: its compose file
    // is kept in Cloudgate. So its create is the console's, as before.
    if (edit.action === 'create' && edit.serviceType === 'compose') {
      return write(KEEP_NOTHING);
    }

    if (edit.action === 'create') {
      const pointer = pointerOf(place, await this.read(place));
      throw repositoryKept(
        `A new ${KIND_WORDS[edit.serviceType]} is added to the Project config, which is kept in ${pointedAt(pointer)}; add it to the file there, then check for changes`,
        pointer,
      );
    }

    const configName = target.configName ?? '';
    if (edit.action === 'delete') {
      const { config, pointer } = await this.copy(place);
      if (described(config, configName)) {
        throw repositoryKept(
          `${configName} is described by the Project config, which is kept in ${pointedAt(pointer)}; remove it from the file there, then check for changes`,
          pointer,
        );
      }
      return write(KEEP_NOTHING);
    }

    // A link is the file's to set, as a config-owned setting is, and
    // so are the seven Swarm settings `native.docker` owns.
    const owned = (found: SavedService | undefined) =>
      found && 'settings' in found
        ? canonical({
            settings: found.settings,
            variables: found.variables,
            links: found.links ?? {},
            docker: found.docker ?? null,
          })
        : null;
    const before = (
      await readSavedServices(this.db, target.environmentId)
    ).find((found) => found.serviceId === edit.serviceId);
    return write(async (tx, written) => {
      const after = (await readSavedServices(tx, target.environmentId)).find(
        (found) => found.serviceId === written.serviceId,
      );
      if (!before || !after || owned(before) === owned(after)) return;
      // Read inside the write's transaction, so the row stays as it was
      // until the file has said whether it may change.
      const { config, pointer } = await this.copy(place);
      if (!described(config, configName)) return;
      const fields = movedFields(
        config,
        configName,
        place.deployTarget,
        before,
        after,
      );
      if (fields.length === 0) return;
      throw repositoryKept(
        `${configName}'s ${fields.join(', ')} ${fields.length === 1 ? 'is' : 'are'} set by the Project config, which is kept in ${pointedAt(pointer)}; change ${fields.length === 1 ? 'it' : 'them'} in the file there, then check for changes`,
        pointer,
      );
    });
  }

  /** The Environment's copy, parsed, or the refusal of a write it decides. */
  private async copy(
    place: EnvironmentPlace,
  ): Promise<{ config: ProjectConfig; pointer: ConfigPointer }> {
    const read = await this.read(place);
    const pointer = pointerOf(place, read);
    if (!read.ok) {
      throw new ConflictException({
        message: `The Project config cannot be read from ${pointedAt(pointer)}, so this change cannot be checked against it and nothing was saved: ${read.message}`,
        code: CONFIG_UNREADABLE_CODE,
        pointer,
      });
    }
    const parsed = parseProjectConfig(read.text);
    if (!parsed.ok) {
      throw repositoryKept(
        `The Project config in ${pointedAt(pointer)} cannot be parsed, so this change cannot be checked against it and nothing was saved; fix the file there first`,
        pointer,
      );
    }
    return { config: parsed.config, pointer };
  }

  /**
   * The Environment's copy through the config reader port, resolved when
   * asked: `ProjectConfigModule` provides it, and that module imports the
   * Service modules that import this one.
   */
  private read(place: EnvironmentPlace): Promise<ConfigReadResult> {
    return readPlace(
      this.moduleRef.get<ConfigReader>(CONFIG_READER, { strict: false }),
      place,
      place.configBranch,
    );
  }

  /** The Environment and Project a write lands in, or `null` if unknown. */
  private async findTarget(edit: ConsoleEdit): Promise<Target | null> {
    let environmentId: string;
    let configName: string | null = null;
    if (edit.action === 'create') {
      environmentId = edit.environmentId;
    } else {
      const source = SERVICE_SOURCES[edit.serviceType];
      const [found] = (await this.db
        .select({
          environmentId: source.environmentId,
          configName: source.configName,
        })
        .from(source.table)
        .where(eq(source.id, edit.serviceId))
        .limit(1)) as { environmentId: string; configName: string }[];
      if (!found) return null;
      ({ environmentId, configName } = found);
    }
    const [env] = await this.db
      .select({ projectId: environment.projectId })
      .from(environment)
      .where(eq(environment.environmentId, environmentId))
      .limit(1);
    return env ? { projectId: env.projectId, environmentId, configName } : null;
  }

  /**
   * The stored text with the touched entry rewritten from what `reader`
   * sees, or `null` when it needs no rewrite. `without` leaves one Service
   * out of the read: a Delete's, worked out before its row is gone.
   * `before` is an update's Service as it was, so only what the update
   * changed is rewritten.
   */
  private async rewrite(
    reader: DrizzleDB | DrizzleTx,
    edit: ConsoleEdit,
    target: Target,
    serviceId: string,
    without: string | null = null,
    lock = false,
    before: SavedService | null = null,
  ) {
    const query = reader
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(
        and(
          eq(projectConfigLocation.projectId, target.projectId),
          eq(projectConfigLocation.kind, 'cloudgate'),
        ),
      );
    // One Save at a time per Project: each rewrites the text it reads. The
    // config row is the only lock taken here, and always after the Service
    // write's own, so two Saves cannot wait on each other.
    const [location] = lock ? await query.for('update') : await query;
    if (!location?.text) return null;
    const stored = location.text;

    const environments = await reader
      .select()
      .from(environment)
      .where(eq(environment.projectId, target.projectId))
      .orderBy(environment.createdAt, environment.environmentId);
    const read = await Promise.all(
      environments.map(async (env) => ({
        environmentId: env.environmentId,
        name: env.name,
        deployTarget: env.deployTarget,
        saved: (await readSavedServices(reader, env.environmentId)).filter(
          (found) => found.serviceId !== without,
        ),
      })),
    );
    const edited = read.find(
      (env) => env.environmentId === target.environmentId,
    );
    if (!edited) return null;
    const configName =
      target.configName ??
      edited.saved.find((found) => found.serviceId === serviceId)?.configName;
    if (!configName) return null;

    const text = rewriteEntry({
      stored,
      configName,
      environments: read,
      creating: edit.action === 'create',
      edited:
        edit.action === 'update' && before !== null
          ? { environment: edited, before }
          : undefined,
    });
    return text === null ? null : { stored, text, configName, edited };
  }

  private async keepInStep(
    tx: DrizzleTx,
    ctx: PermissionCtx | null,
    edit: ConsoleEdit,
    target: Target,
    before: readonly SavedService[],
    written: Written,
    options: SaveOptions = {},
  ): Promise<boolean> {
    if (options.links) {
      await this.refusePlannedLinks(tx, target, written.serviceId);
    }
    const rewritten = await this.rewrite(
      tx,
      edit,
      target,
      written.serviceId,
      null,
      true,
      before.find((found) => found.serviceId === written.serviceId) ?? null,
    );
    if (options.links) {
      refuseUnkeptLinks(rewritten, target.configName, written.serviceId);
    }
    if (rewritten === null) return false;
    const { stored, text, configName, edited } = rewritten;
    await tx
      .update(projectConfigLocation)
      .set({ text, updatedAt: new Date().toISOString() })
      .where(eq(projectConfigLocation.projectId, target.projectId));

    const steps = savedSteps(
      stored,
      text,
      configName,
      before,
      edited,
      edit.action,
    );
    if (steps.length === 0) return false;
    const leftovers =
      written.removed === undefined ? null : leftoversOf(written.removed);
    await this.recordPlan(tx, ctx, {
      environmentId: target.environmentId,
      stored,
      text,
      steps,
      fingerprint: settingsFingerprint(edited.saved, edited.deployTarget),
      results: steps.map((step) => ({
        configName: step.configName,
        action: step.action,
        status: 'applied',
        message: null,
        serviceType: edit.serviceType,
        serviceId: written.serviceId,
        domain: null,
        deploy: null,
        leftovers: step.action === 'destroy' ? leftovers : null,
      })),
    });
    return true;
  }

  /**
   * Refuses a link Save a plan would refuse: the stored config with
   * the Service's entry linking what its row now links, planned against
   * the Environment as the write left it. A link to another Server, to an
   * Output its source does not hand out, to a console-managed Service, or
   * one closing a loop is refused with the plan's own sentence, and the
   * write rolls back.
   */
  private async refusePlannedLinks(
    tx: DrizzleTx,
    target: Target,
    serviceId: string,
  ): Promise<void> {
    const [location] = await tx
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, target.projectId));
    const parsed = location?.text ? parseProjectConfig(location.text) : null;
    // A config that cannot be read is the rewrite's to refuse.
    if (!parsed?.ok || target.configName === null) return;
    const name = target.configName;
    const entry = parsed.config.services[name];
    if (!entry || entry.managed === 'console') {
      throw linkNotKept(
        `the config ${entry ? `lists ${name} as managed: console` : `does not describe ${name}`}, and only a Service the config describes has wired variables`,
      );
    }
    const saved = await readSavedServices(tx, target.environmentId);
    const links = saved.find((found) => found.serviceId === serviceId)?.links;
    const config: ProjectConfig = {
      ...parsed.config,
      services: {
        ...parsed.config.services,
        [name]: {
          ...entry,
          env: entry.env.filter((variable) => !links?.[variable]),
          links,
        } as ProjectConfig['services'][string],
      },
    };
    const [env] = await tx
      .select({ deployTarget: environment.deployTarget })
      .from(environment)
      .where(eq(environment.environmentId, target.environmentId));
    const outcome = planEnvironment({
      config,
      saved,
      deployTarget: env?.deployTarget ?? { kind: 'platform-host' },
      context: { previous: parsed.config },
    });
    const refused = outcome.ok
      ? []
      : outcome.refusals.filter((refusal) =>
          refusal.at?.startsWith(`${name}.env.`),
        );
    if (refused.length === 0) return;
    throw new ConflictException({
      message: refused.map((refusal) => refusal.message).join('; '),
      code: LINK_REFUSED_CODE,
    });
  }

  /**
   * The Save as an applied `save` plan, replacing the Environment's open
   * plan, which no longer describes the stored text. Each Service it wrote
   * names it as the plan its config-owned fields were last applied from.
   */
  private async recordPlan(
    tx: DrizzleTx,
    ctx: PermissionCtx | null,
    made: {
      environmentId: string;
      stored: string;
      text: string;
      steps: PlanStep[];
      fingerprint: string;
      results: PlanStepResult[];
    },
  ) {
    const { environmentId } = made;
    // No Environment row lock, unlike a requested plan: this one is never
    // open, so the one-open-plan index cannot fire, and taking it after the
    // config row would invert the order a whole-YAML save locks them in.
    const now = new Date().toISOString();
    await tx
      .update(plan)
      .set({ status: 'superseded', dismissedAt: now })
      .where(
        and(eq(plan.environmentId, environmentId), eq(plan.status, 'open')),
      );
    const userId = ctx?.user.id ?? null;
    const [recorded] = await tx
      .insert(plan)
      .values({
        environmentId,
        source: 'save',
        text: made.text,
        textHash: textHash(made.text),
        baseTextHash: textHash(made.stored),
        settingsFingerprint: made.fingerprint,
        steps: made.steps,
        notes: [],
        outline: outlineOfText(made.text),
        status: 'applied',
        results: made.results,
        requestedBy: userId,
        appliedBy: userId,
        appliedAt: now,
        createdAt: now,
      })
      .returning({ planId: plan.planId });

    for (const result of made.results) {
      if (result.action === 'destroy' || result.serviceId === null) continue;
      const { serviceId } = result;
      const configPlanId = recorded.planId;
      switch (result.serviceType) {
        case 'application':
          await tx
            .update(application)
            .set({ configPlanId })
            .where(eq(application.applicationId, serviceId));
          break;
        case 'postgres':
          await tx
            .update(postgres)
            .set({ configPlanId })
            .where(eq(postgres.postgresId, serviceId));
          break;
        case 'mysql':
          await tx
            .update(mysql)
            .set({ configPlanId })
            .where(eq(mysql.mysqlId, serviceId));
          break;
        case 'redis':
          await tx
            .update(redis)
            .set({ configPlanId })
            .where(eq(redis.redisId, serviceId));
          break;
        default:
          break;
      }
    }
  }
}

/** The refusal of a link Save the config could not take. */
function linkNotKept(because: string): ConflictException {
  return new ConflictException({
    message: `This link could not be written into the Project config, so nothing was saved: ${because}`,
    code: PROJECT_CONFIG_NOT_KEPT_CODE,
  });
}

/**
 * Refuses a link Save the rewritten config does not say exactly:
 * its entry for the Service could not hold the row's links. The write rolls
 * back with the config, so a row never holds a link its config does not.
 */
function refuseUnkeptLinks(
  rewritten: {
    readonly text: string;
    readonly configName: string;
    readonly edited: { readonly saved: readonly SavedService[] };
  } | null,
  configName: string | null,
  serviceId: string,
): void {
  if (rewritten === null) {
    throw linkNotKept(
      `the config's entry for ${configName ?? 'this Service'} already says otherwise`,
    );
  }
  const name = rewritten.configName;
  const parsed = parseProjectConfig(rewritten.text);
  const entry = parsed.ok ? parsed.config.services[name] : undefined;
  const after = rewritten.edited.saved.find(
    (found) => found.serviceId === serviceId,
  );
  if (
    !entry ||
    entry.managed === 'console' ||
    canonical(entry.links ?? {}) !== canonical(after?.links ?? {})
  ) {
    throw linkNotKept(`the config's entry for ${name} cannot hold them`);
  }
}

/** The file and the branch read: the one asked for, or the default one. */
function pointerOf(
  place: EnvironmentPlace,
  read: ConfigReadResult,
): ConfigPointer {
  return {
    repository: place.repository,
    path: place.path,
    branch: read.branch ?? place.configBranch,
    fileUrl: read.ok ? read.fileUrl : null,
  };
}

/**
 * Whether the file describes the Service, rather than listing it as
 * console-managed or not listing it at all.
 */
function described(config: ProjectConfig, configName: string): boolean {
  const entry = config.services[configName];
  return entry !== undefined && entry.managed !== 'console';
}

/**
 * What the Save did, as a plan: the rewritten text planned against the
 * Environment's settings *before* the write, for the touched entry only.
 * Nothing for a console-managed one, which no plan touches.
 */
function savedSteps(
  stored: string,
  text: string,
  configName: string,
  before: readonly SavedService[],
  edited: {
    deployTarget: Parameters<typeof planEnvironment>[0]['deployTarget'];
    saved: readonly SavedService[];
  },
  action: ConsoleEdit['action'],
): ServiceStep[] {
  const previous = parseProjectConfig(stored);
  const next = parseProjectConfig(text);
  if (!next.ok) return [];
  const plan = (saved: readonly SavedService[]) =>
    planEnvironment({
      config: next.config,
      saved,
      deployTarget: edited.deployTarget,
      context: { previous: previous.ok ? previous.config : null },
    });
  const outcome = plan(before);
  if (!outcome.ok) return [];
  // A field still differing after the write was not the Save's to apply: a
  // difference the config already had here stays for the next plan.
  const after = plan(edited.saved);
  const left = new Set(
    after.ok
      ? after.steps.flatMap((step) =>
          step.action === 'change' && step.configName === configName
            ? step.fields.map((diff) => canonical(diff))
            : [],
        )
      : [],
  );
  const steps = outcome.steps.flatMap((step): ServiceStep[] => {
    if (isNetworkStep(step)) return [];
    // A Save makes and moves no Stack VM: the next plan does.
    if (movesConsoleStackVm(step, next.config)) return [];
    if (step.configName !== configName) return [];
    // A Save deploys nothing: a linked Service gets the notice.
    if (step.action === 'redeploy') return [];
    if (step.action !== 'change') return [step];
    const fields = step.fields.filter((diff) => !left.has(canonical(diff)));
    return fields.length > 0 ? [{ ...step, fields }] : [];
  });
  const destroyed = steps.find((step) => step.action === 'destroy');
  const created = steps.find((step) => step.action === 'create');
  if (!destroyed || !created || action !== 'update') return steps;
  // A settings write that changes the kind (a `web` built as `static`) is
  // a destroy plus a create to a plan, but the Save kept the Service: it is
  // recorded as the one change it made.
  return [
    {
      action: 'change',
      configName,
      kind: created.kind,
      serviceType: destroyed.serviceType,
      serviceId: destroyed.serviceId,
      name: destroyed.name,
      fields: [{ field: 'kind', from: destroyed.kind, to: created.kind }],
    },
  ];
}

/**
 * Runs a console write's row statement so that its config rewrite commits
 * with it: in one transaction with `keep` when there is a config to keep, and
 * straight on `db`, exactly as before, when there is none (`KEEP_NOTHING`).
 * `written` names what the statement wrote, or `null` when it wrote nothing.
 */
export function writeKept<T>(
  db: DrizzleDB,
  keep: KeepConfig,
  write: (db: DrizzleTx) => Promise<T>,
  written: (result: T) => Written | null,
): Promise<T> {
  // The database and a transaction on it build the same statements.
  if (keep === KEEP_NOTHING) return write(db as unknown as DrizzleTx);
  return db.transaction(async (tx) => {
    const result = await write(tx);
    const what = written(result);
    if (what !== null) await keep(tx, what);
    return result;
  });
}
