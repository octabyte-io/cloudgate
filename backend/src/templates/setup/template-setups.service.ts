import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  cloudAccount,
  environment,
  pendingSetup,
  plan,
  project,
  projectConfigLocation,
  setupRecord,
} from '../../db/schema';
import type { Environment } from '../../db/schema';
import { DomainsService } from '../../domains/domains.service';
import type { PointTarget } from '../../domains/cloud-domain';
import { configNamesIn } from '../../environments/config-name';
import { serverIdOf } from '../../environments/deploy-target';
import type { DeployTarget } from '../../environments/deploy-target';
import { EnvironmentsService } from '../../environments/environments.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import {
  ProjectConfigService,
  serviceEntries,
  withServiceEntries,
} from '../../project-config';
import type {
  ConfigKind,
  PendingSetupPart,
  PlanView,
  TemplateDomain,
} from '../../project-config';
import { takenTemplateHosts } from '../../project-config/applier/taken-template-hosts';
import { composedCreateStatements } from '../../compose/composed-create-statements';
import {
  LISTED_NAMES,
  VARIABLE_LISTS,
} from '../../project-config/planner/fields';
import { ProjectsService } from '../../projects/projects.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import type { Template } from '../check';
import type { TemplateSetupDto } from '../dto/template-setup.dto';
import { TemplatesService } from '../templates.service';
import type { PendingSetupBody } from './pending-setup.schema';
import { PendingSetupAutoApply } from './pending-setup-auto-apply.service';
import { pendingConfigNames, setupRecordsOf } from './pending-setups';
import { composeEnvInputs } from './compose-env-inputs';
import {
  deployTargetRefusals,
  environmentRefusal,
  ownWebsNamed,
} from './setup-eligibility';
import type { DeployTargetRefusals } from './setup-eligibility';
import { renamedEntries } from './setup-entries';
import { pickSetupName } from './setup-names';
import { promotedSetup } from './setup-promotion';
import {
  generatedHostName,
  pickedHosts,
  setupDomains,
  templateDomainHttps,
} from './setup-domains';
import type { SetupDomain } from './setup-domains';
import {
  fillFileText,
  isSecretInput,
  madeAs,
  makeValues,
} from './setup-values';

/** The code on a setup refused for what was asked of it. */
export const TEMPLATE_SETUP_REFUSED_CODE = 'TEMPLATE_SETUP_REFUSED';

/** The one Environment a new Project from a template starts with (spec story 34). */
export const NEW_PROJECT_ENVIRONMENT = 'production';

/** One Environment in the setup form's picker, with why it cannot be picked. */
export interface SetupEnvironment {
  readonly environmentId: string;
  readonly name: string;
  readonly canTake: boolean;
  /** Why it cannot take the template; null when it can. */
  readonly reason: string | null;
  /**
   * A generated sslip.io host for each compose Domain, by its name, which
   * the form starts from and the user may replace (#1373): on its Server,
   * or the platform host with a public address. Null where none can be
   * generated, and the user types each host.
   */
  readonly hosts: Readonly<Record<string, string>> | null;
  /**
   * In a Cloud Environment that can take the template, where its compose
   * Domains' typed hosts point (#1379, ADR-0070 "Domains"): the
   * Environment network's load balancer, for the DNS records the form
   * shows; `pointsAt` null while that network is not made, which the
   * setup's Plan makes. Null on a Server or the platform host.
   */
  readonly cloudDomains: { readonly pointsAt: PointTarget | null } | null;
}

/** One value the setup form asks for, and its one check. */
export interface AskedInput {
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly default: string | null;
  readonly required: boolean;
  readonly secret: boolean;
  readonly format: 'email' | 'url' | 'number' | null;
  readonly pattern: string | null;
}

/** What the setup form is drawn from, for an existing Project or a new one. */
export interface SetupForm {
  readonly templateId: string;
  readonly templateName: string;
  readonly revision: string;
  /** The setup name the form starts from: the template's id. */
  readonly setupName: string;
  readonly asked: readonly AskedInput[];
  /** The compose Domains the form asks a host for, each by its name. */
  readonly domains: readonly SetupDomain[];
  /** The Project's Environments; none for a new Project. */
  readonly environments: readonly SetupEnvironment[];
  /**
   * For a new Project (#1376): whether its `production` Environment can
   * take the template on each kind of Deploy target, and if not, why.
   */
  readonly deployTargets: DeployTargetRefusals;
}

/** A Pending setup as a response carries it: each value only as present. */
export interface PendingSetupView {
  readonly pendingSetupId: string;
  readonly environmentId: string;
  readonly templateId: string;
  readonly revision: string;
  readonly setupName: string;
  readonly createdAt: string;
  readonly values: readonly {
    readonly configName: string;
    readonly variable: string;
    readonly made: string;
    readonly hasValue: boolean;
  }[];
}

export interface SetupRecordView {
  readonly setupRecordId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly revision: string;
  readonly setupName: string;
  readonly configNames: readonly string[];
}

/**
 * A repository-kept config's setup (#1378): the renamed entries to paste
 * into the file, and where the file is. Cloudgate never writes it.
 */
export interface SetupPaste {
  /** The entries under `services:`, renamed as the Pending setup holds them. */
  readonly yaml: string;
  /** `owner/repo` as the provider names it. */
  readonly repository: string;
  /** The file inside the repository. */
  readonly path: string;
  /** The Environment's Config branch; null for the default branch. */
  readonly branch: string | null;
}

/** What a setup answers: what it wrote, and the Plan it opened. */
export interface TemplateSetupResult {
  readonly setupName: string;
  readonly configNames: readonly string[];
  readonly pendingSetup: PendingSetupView;
  readonly setupRecord: SetupRecordView;
  /**
   * The Environment's Plan, which Submit goes to. Null on a
   * repository-kept config, whose next push makes the Plan.
   */
  readonly plan: PlanView | null;
  /** On a repository-kept config, the entries to paste; null otherwise. */
  readonly paste: SetupPaste | null;
}

/**
 * **Template setup** (spec #1356, ADR-0064, ADR-0065): a Template into an
 * existing Project whose config Cloudgate keeps. In order, before anything
 * is written: the saved catalogue copy through the Template check, the
 * Environment's eligibility from the plan's kind table, every statement its
 * Apply will ask, the Config names (the setup name renamed as a whole on a
 * clash), then every value. Then the Pending setup and the Setup record, and
 * the renamed entries added to the config through the console's whole-YAML
 * save, which opens a Plan in every Environment.
 *
 * Extension points, each the ticket that builds it:
 * - a compose part in a cloud (#1379) runs on its own Stack VM: its hosts
 *   are typed, the form shows the records to make (`cloudDomainsOf`), and
 *   its part carries the template's minimum size for the plan;
 * - a new Project (#1376) makes the Project and its `production`
 *   Environment, then calls {@link setUpIn} as an existing one
 *   ({@link setUpInNewProject});
 * - a repository-kept config (#1378) writes the same Pending setup and
 *   returns the renamed YAML to paste instead of saving it, touching
 *   nothing in the repository: the next push's Plan picks the setup up by
 *   Config name and kind, and notes the values a renamed part leaves unused
 *   (`setup-values-unused`);
 * - setting a template up in one more Environment reuses its Setup
 *   record's names instead of {@link pickSetupName} and plans only that
 *   Environment (#1377, `promotedSetup`); every other Environment holds
 *   the parts back until set up there (`holdBackSetups`).
 *
 * No Agent reaches it: an Agent's key is refused on every REST route
 * (ADR-0023), and no MCP tool calls it, since a Pending setup holds secrets
 * and an Agent never applies.
 */
@Injectable()
export class TemplateSetups {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly templates: TemplatesService,
    private readonly projectConfig: ProjectConfigService,
    private readonly instanceMode: InstanceMode,
    private readonly domains: DomainsService,
    private readonly projects: ProjectsService,
    private readonly environments: EnvironmentsService,
    private readonly autoApply: PendingSetupAutoApply,
  ) {}

  /**
   * The setup form: the template's asked values, and for a Project each
   * Environment the caller can read, with whether it can take the template.
   * With no Project it is the form for a new one, which answers by kind of
   * Deploy target instead.
   */
  async form(
    ctx: PermissionCtx,
    templateId: string,
    projectId: string | undefined,
  ): Promise<SetupForm> {
    if (projectId !== undefined) await this.projects.findOne(ctx, projectId);
    const template = await this.templates.savedTemplate(templateId);
    const environments =
      projectId === undefined
        ? []
        : await this.db
            .select()
            .from(environment)
            .where(eq(environment.projectId, projectId))
            .orderBy(asc(environment.createdAt));
    const domains = setupDomains(template);
    const readable: SetupEnvironment[] = [];
    for (const env of environments) {
      if (!(await this.canRead(ctx, env.environmentId))) continue;
      const reason = await this.refusalIn(template, env);
      readable.push({
        environmentId: env.environmentId,
        name: env.name,
        canTake: reason === null,
        reason,
        hosts:
          reason === null
            ? await this.generatedHosts(ctx, template, domains, env)
            : null,
        cloudDomains:
          reason === null && domains.length > 0
            ? await this.cloudDomainsOf(env)
            : null,
      });
    }
    return {
      templateId: template.id,
      templateName: template.name,
      revision: template.revision,
      setupName: template.id,
      asked: askedInputs(template),
      domains,
      environments: readable,
      deployTargets: deployTargetRefusals(template, {
        hosted: this.instanceMode.isHosted,
        platformHostGeneratesHosts:
          await this.domains.platformHostGeneratesHosts(),
      }),
    };
  }

  /**
   * A generated sslip.io host for each compose Domain in this Environment
   * (spec #1356 story 41): the host a plan-created `web` gets, from its
   * Server's address. Null in a Cloud Environment, where a Stack VM has no
   * address a host could carry (#1379), and on a platform host whose public
   * address is not set, where no host would resolve: the user types each.
   */
  private async generatedHosts(
    ctx: PermissionCtx,
    template: Template,
    domains: readonly SetupDomain[],
    env: Environment,
  ): Promise<Record<string, string> | null> {
    if (domains.length === 0 || env.deployTarget.kind === 'cloud') {
      return null;
    }
    const serverId = serverIdOf(env.deployTarget);
    const hosts: Record<string, string> = {};
    try {
      for (const domain of domains) {
        hosts[domain.name] = await this.domains.generateHostForNewService(
          ctx,
          generatedHostName(template, domain),
          serverId,
        );
      }
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        return null;
      }
      throw error;
    }
    return hosts;
  }

  /**
   * Where a Cloud Environment's compose Domains point, for the records the
   * form shows (#1379); null on a Server or the platform host.
   */
  private async cloudDomainsOf(
    env: Environment,
  ): Promise<SetupEnvironment['cloudDomains']> {
    if (env.deployTarget.kind !== 'cloud') return null;
    return {
      pointsAt: await this.domains.stackNetworkPointTarget({
        environmentId: env.environmentId,
        cloudAccountId: env.deployTarget.cloudAccountId,
        region: env.deployTarget.region,
      }),
    };
  }

  /**
   * Sets a Template up in an existing Project's Environment, or a new
   * Project. With `autoApply` (the get-started wizard's, ADR-0073) its plan
   * is applied at once when the Server is ready already, and the answer
   * carries the plan as that Apply left it; otherwise Cloudgate applies it
   * once the Server is ready (`PendingSetupAutoApply`).
   */
  async setUp(
    ctx: PermissionCtx,
    request: TemplateSetupDto,
  ): Promise<TemplateSetupResult> {
    const result = await this.setUpWhere(ctx, request);
    if (!request.autoApply) return result;
    const { environmentId, pendingSetupId } = result.pendingSetup;
    await this.autoApply.attempt(pendingSetupId);
    return {
      ...result,
      plan: (await this.projectConfig.findPlan(ctx, environmentId)).plan,
    };
  }

  private async setUpWhere(
    ctx: PermissionCtx,
    request: TemplateSetupDto,
  ): Promise<TemplateSetupResult> {
    if (request.newProject) {
      return this.setUpInNewProject(ctx, request, request.newProject);
    }
    // The DTO holds both ids when no new Project is named.
    const env = await this.environmentOf(
      ctx,
      request.projectId ?? '',
      request.environmentId ?? '',
    );
    return this.setUpIn(ctx, env, request);
  }

  /**
   * "New Project from a template" (#1376): a Project with a Cloudgate-kept
   * config and one `production` Environment on the Deploy target picked,
   * then {@link setUpIn} as for an existing Project.
   *
   * Before anything is saved: `project: create` and `environment: create`,
   * the Deploy target as `POST /environments` checks it, the template's
   * eligibility on that target, and every statement its Apply will ask.
   * What {@link setUpIn} refuses after the Project is made (the setup name,
   * an asked value) takes the Project back with it, so a refused setup
   * leaves nothing. Once the Plan is open the Project stays: dismissing the
   * Plan leaves it empty, which the form says.
   */
  private async setUpInNewProject(
    ctx: PermissionCtx,
    request: TemplateSetupDto,
    newProject: NonNullable<TemplateSetupDto['newProject']>,
  ): Promise<TemplateSetupResult> {
    await this.permissions.checkPermission(ctx, {
      project: ['create'],
      environment: ['create'],
    });
    const template = await this.templates.savedTemplate(request.templateId);
    const { deployTarget } = await this.environments.checkDeployTarget(
      ctx,
      newProject.deployTarget,
    );
    const refusal = await this.refusalOn(template, deployTarget);
    if (refusal) {
      throw new ConflictException({
        message: `A production Environment on that Deploy target cannot take the ${template.name} template: ${refusal}`,
        code: TEMPLATE_SETUP_REFUSED_CODE,
      });
    }
    await this.checkApplyStatements(ctx, null, template);

    const made = await this.projects.create(ctx, { name: newProject.name });
    try {
      const env = await this.environments.create(ctx, {
        projectId: made.projectId,
        name: NEW_PROJECT_ENVIRONMENT,
        deployTarget,
      });
      return await this.setUpIn(ctx, env, request);
    } catch (error) {
      // Nothing ran in it: the rows go, and with them its config and
      // Environment.
      await this.db
        .delete(project)
        .where(eq(project.projectId, made.projectId));
      throw error;
    }
  }

  private async setUpIn(
    ctx: PermissionCtx,
    env: Environment,
    request: TemplateSetupDto,
  ): Promise<TemplateSetupResult> {
    const { projectId } = env;
    // 1. The saved copy, through the Template check on the bytes held.
    const template = await this.templates.savedTemplate(request.templateId);

    // A repository-kept config gets the YAML to paste instead (#1378).
    const [location] = await this.db
      .select({
        kind: projectConfigLocation.kind,
        repository: projectConfigLocation.repository,
        path: projectConfigLocation.path,
      })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    const repository =
      location?.kind === 'repository' && location.repository && location.path
        ? { repository: location.repository, path: location.path }
        : null;
    // A repository-kept config is planned by a push, which only the
    // repository's owner makes, so there is no plan Cloudgate could apply.
    if (repository && request.autoApply) {
      throw refused(
        'autoApply needs a Project whose config Cloudgate keeps; this one is kept in a repository, so its plan comes from a push',
      );
    }

    // 2. Whether the Environment can take it, from the kind table.
    const refusal = await this.refusalIn(template, env);
    if (refusal) {
      throw new ConflictException({
        message: `${env.name} cannot take the ${template.name} template: ${refusal}`,
        code: TEMPLATE_SETUP_REFUSED_CODE,
      });
    }

    // 3. Every statement its Apply will ask, before anything is saved.
    await this.checkApplyStatements(ctx, projectId, template);

    // 4. The Config names: a Setup record's, when the template was set up
    // under this name in another Environment and none of its parts is here
    // yet (#1377); else the setup name renamed as a whole on a clash.
    const environmentIds = (
      await this.db
        .select({ environmentId: environment.environmentId })
        .from(environment)
        .where(eq(environment.projectId, projectId))
    ).map((row) => row.environmentId);
    const stored = await this.storedText(projectId);
    const taken = new Set([
      ...serviceEntries(stored).keys(),
      // A repository-kept file is never read here: what its newest plans
      // listed stands for it.
      ...(repository ? await this.plannedNames(environmentIds) : []),
      ...(await configNamesIn(this.db, environmentIds)),
      ...(await pendingConfigNames(this.db, environmentIds)),
    ]);
    const promoted = promotedSetup(
      await setupRecordsOf(this.db, projectId),
      {
        templateId: template.id,
        setupName: request.setupName,
        parts: Object.keys(template.config.services),
      },
      new Set([
        ...(await configNamesIn(this.db, [env.environmentId])),
        ...(await pendingConfigNames(this.db, [env.environmentId])),
      ]),
    );
    const picked =
      promoted ??
      pickSetupName(
        request.setupName,
        template.id,
        Object.keys(template.config.services),
        taken,
      );
    if ('ok' in picked && !picked.ok) throw refused(picked.reason);

    // 5. Every value, asked ones checked first, and the generated host of
    // each own web a value names (ADR-0064): made now, so the value and the
    // Domain its Apply makes on the same host agree.
    const ownWebs = ownWebsNamed(template);
    const given = ownWebs.find((name) => name in request.hosts);
    if (given !== undefined) {
      throw refused(
        `${given} is a web, whose generated host setup makes; a host is picked only for a compose service's Domain`,
      );
    }
    // Each compose Domain's host, given and a hostname, before any value
    // refers to it (#1373).
    const domains = setupDomains(template);
    const hosts = pickedHosts(domains, request.hosts);
    if (!hosts.ok) throw refused(hosts.reason);
    const serverId = serverIdOf(env.deployTarget);
    // Each served as its Apply will make it: plain HTTP only on the host
    // the form generated for it, never on any other sslip.io host (#1411).
    const cloud = env.deployTarget.kind === 'cloud';
    const served: TemplateDomain[] = [];
    for (const [at, domain] of domains.entries()) {
      const chosen = hosts.domains[at];
      const generated =
        !cloud &&
        (await this.domains.isHostGeneratedFor(
          ctx,
          chosen.host,
          generatedHostName(template, domain),
          serverId,
        ));
      served.push({
        ...chosen,
        https: templateDomainHttps({ cloud, generated }),
      });
    }
    const httpsOf = new Map(
      domains.map((domain, at) => [domain.name, served[at].https]),
    );
    const hostOf = new Map(
      domains.map((domain, at) => [domain.name, served[at].host]),
    );
    const ownHosts = new Map<string, string>();
    for (const name of ownWebs) {
      ownHosts.set(
        name,
        await this.domains.generateHostForNewService(
          ctx,
          picked.names.get(name) ?? name,
          serverId,
        ),
      );
    }
    const answers = {
      asked: request.values,
      domain: (name: string, part: 'url' | 'host') => {
        // A web's generated Domain is plain HTTP, as any plan-made web's.
        const own = ownHosts.get(name);
        if (own !== undefined) return part === 'host' ? own : `http://${own}`;
        // A compose Domain's, picked above (#1373), served as its Apply
        // makes it: plain HTTP on a generated host, like the web's.
        const host = hostOf.get(name);
        if (host === undefined) return null;
        if (part === 'host') return host;
        return `${httpsOf.get(name) ? 'https' : 'http'}://${host}`;
      },
    };
    const made = makeValues(template.inputs, answers);
    if (!made.ok) {
      throw refused(made.problems.map((problem) => problem.message).join('; '));
    }

    // 6. Each config file's text, its references filled in once (#1373).
    const files = template.files.map((file) => ({
      configName: partName(picked.names, file.entry ?? template.compose),
      path: file.path,
      mount: file.mount ?? null,
      content: fillFileText(
        template.configFiles[file.path],
        answers,
        made.values,
      ),
    }));

    // 7. The compose Domains' hosts, by the rules every Domain is held to:
    // none taken.
    const takenHosts = await takenTemplateHosts(
      this.domains,
      ctx,
      env.deployTarget,
      hosts.domains,
    );
    const [firstTaken] = takenHosts;
    if (firstTaken) {
      throw new ConflictException({
        message: `The host ${firstTaken[0]} is taken: ${firstTaken[1]}`,
        code: TEMPLATE_SETUP_REFUSED_CODE,
      });
    }

    const parts = partsOf(template, picked.names, ownHosts, {
      values: made.values,
      domains: served,
      files,
    });
    const body: PendingSetupBody = {
      values: Object.fromEntries(
        parts.map((part) => [
          part.configName,
          Object.fromEntries(
            Object.keys(part.made).map((variable) => [
              variable,
              made.values[variable],
            ]),
          ),
        ]),
      ),
      hosts: Object.fromEntries([...hostOf, ...ownHosts]),
      composeFile: template.composeFile,
      files,
    };
    const configNames = [...picked.names.values()];

    // 8. The records, then the entries through the whole-YAML save, which
    // plans them; a refused plan takes the records back with it. A setup in
    // one more Environment keeps its one Setup record and plans only there.
    const { record, pending } = await this.db.transaction(async (tx) => {
      const [record] = promoted
        ? await tx
            .select()
            .from(setupRecord)
            .where(eq(setupRecord.setupRecordId, promoted.setupRecordId))
        : await tx
            .insert(setupRecord)
            .values({
              projectId,
              templateId: template.id,
              revision: template.revision,
              setupName: picked.setupName,
              configNames,
            })
            .returning();
      const [pending] = await tx
        .insert(pendingSetup)
        .values({
          environmentId: env.environmentId,
          setupRecordId: record.setupRecordId,
          templateId: template.id,
          revision: template.revision,
          templateName: template.name,
          setupName: picked.setupName,
          parts,
          body,
          ...(request.autoApply
            ? { autoApplyBy: ctx.user.id, autoApplyState: 'waiting' as const }
            : {}),
        })
        .returning();
      return { record, pending };
    });
    const entries = renamedEntries(template.configText, picked.names);
    const result = {
      setupName: picked.setupName,
      configNames,
      pendingSetup: pendingSetupView(pending.pendingSetupId, {
        environmentId: env.environmentId,
        templateId: template.id,
        revision: template.revision,
        setupName: picked.setupName,
        createdAt: pending.createdAt,
        parts,
        body,
      }),
      setupRecord: {
        setupRecordId: record.setupRecordId,
        projectId,
        templateId: record.templateId,
        revision: record.revision,
        setupName: record.setupName,
        configNames: record.configNames,
      },
    };
    if (repository) {
      // Nothing is written to the repository: the user pastes the entries,
      // and the push of them plans the parts from the Pending setup.
      return {
        ...result,
        plan: null,
        paste: {
          yaml: withServiceEntries('', entries),
          ...repository,
          branch: env.configBranch,
        },
      };
    }
    let plans: readonly PlanView[];
    try {
      plans = promoted
        ? [
            await this.projectConfig.planSetupIn(
              ctx,
              env.environmentId,
              entries,
            ),
          ]
        : (
            await this.projectConfig.savePlans(
              ctx,
              projectId,
              withServiceEntries(stored, entries),
            )
          ).plans;
    } catch (error) {
      if (!promoted) {
        await this.db
          .delete(setupRecord)
          .where(eq(setupRecord.setupRecordId, record.setupRecordId));
      }
      await this.db
        .delete(pendingSetup)
        .where(eq(pendingSetup.pendingSetupId, pending.pendingSetupId));
      throw error;
    }

    return {
      ...result,
      plan:
        plans.find((one) => one.environmentId === env.environmentId) ?? null,
      paste: null,
    };
  }

  /**
   * The Config names each Environment's newest plan listed, from its
   * outline: a repository-kept config's file as Cloudgate last read it,
   * which a setup's names must not clash with.
   */
  private async plannedNames(
    environmentIds: readonly string[],
  ): Promise<string[]> {
    if (environmentIds.length === 0) return [];
    const rows = await this.db
      .select({ environmentId: plan.environmentId, outline: plan.outline })
      .from(plan)
      .where(inArray(plan.environmentId, [...environmentIds]))
      .orderBy(desc(plan.createdAt));
    const newest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!newest.has(row.environmentId)) newest.set(row.environmentId, row);
    }
    return [...newest.values()].flatMap((row) =>
      Object.keys(row.outline?.services ?? {}),
    );
  }

  /**
   * ADR-0065 "Permissions": the statements the Apply of this setup's plan
   * will ask, asked now. `domain` and `volume` go alone, since an owner's or
   * an admin's bypass holds only when every resource in one call is
   * enterprise-only (`composedCreateStatements`).
   */
  private async checkApplyStatements(
    ctx: PermissionCtx,
    projectId: string | null,
    template: Template,
  ): Promise<void> {
    if (projectId === null) {
      // A Project not made yet, whose creator is granted it when it is.
      await this.permissions.checkPermission(ctx, { service: ['create'] });
    } else {
      await this.permissions.checkServiceAccess(ctx, projectId, 'create');
    }
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    // The Apply's own list (`PlanApplier.check`), each statement alone.
    for (const statement of composedCreateStatements({
      domains: template.domains.length,
      mounts: template.files.length,
    })) {
      await this.permissions.checkPermission(ctx, statement);
    }
  }

  private async refusalIn(
    template: Template,
    env: Environment,
  ): Promise<string | null> {
    return this.refusalOn(template, env.deployTarget);
  }

  private async refusalOn(
    template: Template,
    target: DeployTarget,
  ): Promise<string | null> {
    return environmentRefusal(template, target, {
      cloud: await this.cloudOf(target),
      hosted: this.instanceMode.isHosted,
      platformHostGeneratesHosts:
        await this.domains.platformHostGeneratesHosts(),
    });
  }

  private async cloudOf(target: DeployTarget): Promise<CloudKind | null> {
    if (target.kind !== 'cloud') return null;
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, target.cloudAccountId));
    return found?.cloud ?? null;
  }

  private async canRead(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<boolean> {
    try {
      await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'read');
      return true;
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The Environment, in that Project of the caller's organization, on the
   * caller's read of it. The Project is joined rather than read through
   * `ProjectsService.findOne`, whose `accessedProjects` check a setup into
   * an Environment the caller was granted has never asked.
   */
  private async environmentOf(
    ctx: PermissionCtx,
    projectId: string,
    environmentId: string,
  ): Promise<Environment> {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'read');
    const [found] = await this.db
      .select({ environment })
      .from(environment)
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(environment.projectId, projectId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Environment not found');
    return found.environment;
  }

  private async storedText(projectId: string): Promise<string> {
    const [found] = await this.db
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    return found?.text ?? '';
  }
}

function refused(message: string): BadRequestException {
  return new BadRequestException({
    message,
    code: TEMPLATE_SETUP_REFUSED_CODE,
  });
}

/** A part's Config name, by the template's own name for it. */
function partName(
  names: ReadonlyMap<string, string>,
  part: string | undefined,
): string {
  // The Template check holds every file to an entry it lists.
  return names.get(part ?? '') ?? part ?? '';
}

/**
 * Each part under its Config name, with how each of its values is made and
 * what it writes beside them. An own part's values are every name its entry
 * lists, in any list, once; the compose part's are every input its compose
 * file uses, its own `.env` (ADR-0064), and it carries its Domains on their
 * picked hosts (#1373). A web whose URL a value names carries the generated
 * host setup made for it, for its Apply's Domain. Each part names its
 * config files by path.
 */
function partsOf(
  template: Template,
  names: ReadonlyMap<string, string>,
  ownHosts: ReadonlyMap<string, string>,
  writes: {
    /** The values setup made, by input name. */
    readonly values: Readonly<Record<string, string>>;
    readonly domains: readonly TemplateDomain[];
    readonly files: readonly {
      readonly configName: string;
      readonly path: string;
      readonly mount: string | null;
    }[];
  },
): PendingSetupPart[] {
  const composeInputs = composeEnvInputs(
    template.composeFile,
    template.inputs,
    writes.values,
  );
  return Object.entries(template.config.services).map(([part, entry]) => {
    const configName = names.get(part) ?? part;
    const made: Record<string, string> = {};
    if (entry.managed !== 'console') {
      for (const list of VARIABLE_LISTS) {
        for (const variable of LISTED_NAMES[list](entry)) {
          const rule = template.inputs[variable];
          if (rule) made[variable] = madeAs(rule);
        }
      }
    } else if (part === template.compose) {
      for (const variable of composeInputs) {
        made[variable] = madeAs(template.inputs[variable]);
      }
    }
    const host = ownHosts.get(part);
    const files = writes.files
      .filter((file) => file.configName === configName)
      .map(({ path, mount }) => ({ path, mount }));
    return {
      configName,
      kind: entry.kind as ConfigKind,
      made,
      ...(host === undefined ? {} : { host }),
      ...(part === template.compose ? { domains: writes.domains } : {}),
      // Where its Stack VM starts in a Cloud Environment (#1379).
      ...(part === template.compose && template.size !== undefined
        ? { size: template.size }
        : {}),
      ...(files.length > 0 ? { files } : {}),
    };
  });
}

function askedInputs(template: Template): AskedInput[] {
  return Object.entries(template.inputs).flatMap(([name, rule]) =>
    'ask' in rule
      ? [
          {
            name,
            label: rule.ask.label,
            description: rule.ask.description ?? null,
            default: rule.ask.default ?? null,
            required: rule.ask.required !== false,
            secret: isSecretInput(rule),
            format: rule.ask.format ?? null,
            pattern: rule.ask.pattern ?? null,
          },
        ]
      : [],
  );
}

/** ADR-0019: each value as present, never as itself. */
export function pendingSetupView(
  pendingSetupId: string,
  row: {
    readonly environmentId: string;
    readonly templateId: string;
    readonly revision: string;
    readonly setupName: string;
    readonly createdAt: string;
    readonly parts: readonly PendingSetupPart[];
    readonly body: PendingSetupBody;
  },
): PendingSetupView {
  return {
    pendingSetupId,
    environmentId: row.environmentId,
    templateId: row.templateId,
    revision: row.revision,
    setupName: row.setupName,
    createdAt: row.createdAt,
    values: row.parts.flatMap((part) =>
      Object.entries(part.made).map(([variable, made]) => ({
        configName: part.configName,
        variable,
        made,
        hasValue: row.body.values[part.configName]?.[variable] !== undefined,
      })),
    ),
  };
}
