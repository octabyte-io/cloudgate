import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import type { ServiceType } from '../../applications/application.schema';
import { ApplicationsService } from '../../applications/applications.service';
import { BucketDeletes } from '../../buckets/bucket-deletes.service';
import { BucketsService } from '../../buckets/buckets.service';
import { ComposeService } from '../../compose/compose.service';
import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { laidAwsBlock, laysNativeAwsOn } from '../planner/native-aws-lines';
import { laidGcpBlock, laysNativeGcpOn } from '../planner/native-gcp-lines';
import {
  elastiCacheNativeColumns,
  rdsNativeColumns,
} from '../../native/aws-console-owned';
import {
  cloudSqlNativeColumns,
  memorystoreNativeColumns,
} from '../../native/gcp-console-owned';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { stateProviderOf } from '../../cloud-accounts/infrastructure-state/state-versions';
import {
  CLOUD_RUN_COPIES,
  cloudRunSize,
} from '../../cloud-accounts/gcp/definitions/cloud-run-size';
import { cloudRunResourceOf } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import type { CloudSqlEngineName } from '../../cloud-accounts/gcp/definitions/cloud-sql-engines';
import type { UpdateApplicationDto } from '../../applications/dto/application.dto';
import { MysqlService } from '../../databases/mysql/mysql.service';
import {
  dropSwitch,
  existingCacheChoiceOf,
  existingChoiceOf,
  switchOf,
} from '../../databases/postgres/database-switches';
import { PostgresService } from '../../databases/postgres/postgres.service';
import { RedisService } from '../../databases/redis/redis.service';
import { generateAppName } from '../../db/columns';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  application,
  bucket,
  cloudAccount,
  compose,
  environmentNetwork,
  existingDatabase,
  mysql,
  postgres,
  redis,
} from '../../db/schema';
import { DeploymentsService } from '../../deployments/deployments.service';
import { stackVmSettingsAfter } from '../../cloud-accounts/definitions/stack-vm-written';
import { environmentNetworkName } from '../../deployments/service-scope';
import { serverIdOf } from '../../environments/deploy-target';
import { DomainsService } from '../../domains/domains.service';
import { MountsService } from '../../mounts/mounts.service';
import type { GitProviderType } from '../../git-providers/git-provider.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { PermissionService } from '../../rbac/permission.service';
import { GitConnectionResolver } from '../git-connections';
import { describeError } from '../../common/describe-error';
import { article } from '../messages.utils';
import {
  isDriftRead,
  isNetworkStep,
  isQuietRead,
} from '../planner/cloud-steps';
import { isApplicationEntry, isVariableList } from '../planner/fields';
import type { ApplicationEntry } from '../planner/fields';
import type { HostedProvider, ResolvedConnection } from '../git-connections';
import type {
  DeployTarget,
  PlanRefusal,
  PlanStep,
  SavedService,
  TemplateCreate,
  TemplateDomain,
} from '../planner/plan.types';
import type {
  ConfigLinks,
  ProjectConfig,
  ServiceEntry,
  Source,
} from '../project-config.types';
import type { DomainPortMove } from '../../applications/domain-port-move';
import type {
  PlanStepDeploy,
  PlanStepLeftovers,
  PlanStepResult,
} from './apply.types';
import { CloudBucketRuns } from './cloud-bucket-runs.service';
import { CloudStackVmRuns } from './cloud-stack-vm-runs.service';
import { composeSettings } from './compose-settings';
import { CloudPostgresRuns } from './cloud-postgres-runs.service';
import { CloudRedisRuns } from './cloud-redis-runs.service';
import { CloudStaticRuns } from './cloud-static-runs.service';
import { CloudServiceDeploys } from './cloud-service-deploys.service';
import { EnvironmentNetworkRemovals } from './environment-network-removals.service';
import { GoogleDomainRuns } from './google-domain-runs.service';
import { keepKeys } from './dotenv-keys';
import { takePart, takeStackPart } from '../../templates/setup/pending-setups';
import { appliedDomainHttps } from '../../templates/setup/setup-domains';
import type { PendingWrites } from '../../templates/setup/pending-setups';
import { composedCreateStatements } from '../../compose/composed-create-statements';
import { templateHostTaken } from '../planner/template-host-taken';
import { takenTemplateHosts } from './taken-template-hosts';
import { templateVariables } from './template-variables';
import { leftoversOf } from './leftovers';
import {
  defaultDatabaseIdentifier,
  defaultPostgresUser,
} from '../format/config-wire';
import { rdsClassOf, savedSize } from '../planner/cloud-postgres';
import { fargateSize } from '../../cloud-accounts/aws/definitions/fargate-size';
import { capsWithNativeCloudRun } from '../../native/gcp-size';
import {
  capsWithNativeFargate,
  nativeInstanceClassOf,
  nativeNodeTypeOf,
} from '../../native/aws-size';
import {
  elastiCacheConsoleSettings,
  generateAuthToken,
} from '../elasticache-redis-places';
import { elastiCacheNodeTypeOf } from '../planner/cloud-redis';
import { cloudSqlAppliedAfter } from '../cloud-sql-places';
import { rdsConsoleSettings } from '../rds-postgres-places';
import {
  findRdsRow,
  findRdsState,
  rdsIdOf,
  rdsKindOf,
  rdsOwnerOf,
  updateRdsRow,
} from '../../databases/common/rds-rows';
import {
  applicationSettings,
  cronTimetable,
  isNewRepository,
  mysqlSettings,
  postgresSettings,
  redisSettings,
  swarmSettings,
  sourceSettings,
} from './service-settings';
import { blockedReason, stoppedInCloud } from '../stopped-databases';

type Described = Exclude<ServiceEntry, { managed: 'console' }>;

/**
 * What a create or change of one Service did: the Domain it made, the
 * Deployment it queued, and, for an Application's port change, the Domains
 * it moved and left (ADR-0068).
 */
interface StepOutcome {
  domain: string | null;
  deploy: PlanStepDeploy | null;
  domainPortMove?: DomainPortMove;
}

/** The database kinds a plan creates, changes and destroys. */
type DatabaseKind = 'postgres' | 'mysql' | 'redis';

const isDatabase = (
  serviceType: ServiceType | null,
): serviceType is DatabaseKind =>
  serviceType === 'postgres' ||
  serviceType === 'mysql' ||
  serviceType === 'redis';

/** Where each database kind keeps its variables, for a removed key. */
const DATABASE_ROWS = {
  postgres: { table: postgres, idColumn: postgres.postgresId },
  mysql: { table: mysql, idColumn: mysql.mysqlId },
  redis: { table: redis, idColumn: redis.redisId },
} as const;

/** The refusal code for a plan whose Application no connection reaches. */
export const PLAN_REFUSED_CODE = 'PLAN_REFUSED';

/** What one Apply runs against. */
export interface ApplyInput {
  readonly projectId: string;
  readonly environmentId: string;
  readonly deployTarget: DeployTarget;
  readonly planId: string;
  readonly steps: readonly PlanStep[];
  readonly config: ProjectConfig;
  readonly saved: readonly SavedService[];
  /**
   * A repository-kept config's repository and the branch this Environment
   * read it from (its Config branch, or the default branch), so a
   * plan-created Application building from that same repository gets that
   * branch. `null` for a Cloudgate-kept config. Its connection
   * (`gitProviderId`) is the one asked first for a hosted source.
   */
  readonly configRepository: {
    readonly gitProviderId: string;
    readonly providerType: GitProviderType;
    readonly repository: string;
    readonly branch: string;
  } | null;
  /**
   * The builds this plan holds, by Application. A changed
   * Application's deploy releases its held build instead of queuing a second
   * one, so the build a push held is the one that gets the new settings.
   */
  readonly heldBuilds: ReadonlyMap<string, string>;
  /**
   * The Config names of the bucket destroys the Apply ticked "also delete
   * its files" on; every other bucket keeps its files.
   */
  readonly deleteFilesOf: ReadonlySet<string>;
  /**
   * The Config names of the cloud database destroys the Apply ticked "also
   * delete its data (no final snapshot)" on; every other keeps one.
   */
  readonly deleteDataOf: ReadonlySet<string>;
  /**
   * The values each Template part this plan creates takes from its Pending
   * setup, by Config name and then variable (ADR-0064). Read as the Apply
   * starts, so a setup cancelled since the plan refuses it up front.
   * Absent, the plan creates no Template part.
   */
  readonly templateValues?: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;
  /**
   * What each Template part this plan creates writes beside its values,
   * by Config name: a compose part's compose file, and each part's config
   * files, their text filled in at setup (#1373). Read with the values.
   */
  readonly templateWrites?: ReadonlyMap<string, PendingWrites>;
}

/** The up-front pass's answer: the connection each hosted source resolved to. */
export type Connections = ReadonlyMap<string, ResolvedConnection>;

const HOSTED: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
]);

const isHosted = (
  source: Source | undefined,
): source is Extract<Source, { sourceType: HostedProvider }> =>
  source !== undefined && HOSTED.has(source.sourceType);

/**
 * The **Applier**: runs a stored plan's steps in its
 * order: creates and changes, each through the existing per-kind
 * Service create and update paths, queuing an ordinary Deployment for every
 * Service it wrote; redeploys, queuing one for a Service a changed Output
 * reaches; and destroys, each the existing Delete (ADR-0018) as the
 * console's Delete runs it, never forced. A destroy is only ever of a kind the config
 * describes: a console-managed Service is never one (US34).
 *
 * Two passes. {@link check} asks every step's statement and resolves every
 * git provider connection before anything is written, so one refusal refuses
 * the whole Apply with nothing written. {@link run} then runs each step on
 * its own: a step that fails is recorded failed and the next one runs.
 */
@Injectable()
export class PlanApplier {
  private readonly logger = new Logger(PlanApplier.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly applications: ApplicationsService,
    private readonly postgres: PostgresService,
    private readonly mysql: MysqlService,
    private readonly redis: RedisService,
    private readonly buckets: BucketsService,
    private readonly bucketDeletes: BucketDeletes,
    private readonly domains: DomainsService,
    private readonly deployments: DeploymentsService,
    private readonly connections: GitConnectionResolver,
    private readonly states: InfrastructureStatesService,
    private readonly cloudDeploys: CloudServiceDeploys,
    private readonly cloudPostgres: CloudPostgresRuns,
    private readonly cloudBuckets: CloudBucketRuns,
    private readonly cloudStackVms: CloudStackVmRuns,
    private readonly cloudRedis: CloudRedisRuns,
    private readonly cloudStatic: CloudStaticRuns,
    private readonly networkRemovals: EnvironmentNetworkRemovals,
    private readonly googleDomains: GoogleDomainRuns,
    // A `compose` entry's create, change and Delete go through the
    // stack's own paths (ADR-0069).
    private readonly compose: ComposeService,
    // A Template part's config files, each a file mount (#1373).
    private readonly mounts: MountsService,
  ) {}

  /**
   * Every statement the steps use, asked before any step runs (US67): a
   * create's `service: create` on the Project (a `web`'s generated Domain is
   * part of its create, so no `domain: create`), a change's `service: update`
   * on its Service, a destroy's `service: delete` on its Service, and
   * `deployment: create` for the Deployments the creates and changes queue.
   * A refusal is the permission service's own 403, passed through.
   */
  async check(ctx: PermissionCtx, input: ApplyInput): Promise<Connections> {
    const creates = input.steps.filter((step) => step.action === 'create');
    if (creates.length > 0) {
      await this.permissions.checkServiceAccess(ctx, input.projectId, 'create');
    }
    for (const step of input.steps) {
      if (step.action === 'change') {
        await this.permissions.checkServiceAccess(
          ctx,
          step.serviceId,
          'update',
        );
      }
    }
    for (const step of input.steps) {
      if (step.action === 'destroy') {
        await this.permissions.checkServiceAccess(
          ctx,
          step.serviceId,
          'delete',
        );
      }
    }
    if (input.steps.some((step) => step.action !== 'destroy')) {
      await this.permissions.checkPermission(ctx, {
        deployment: ['create'],
      });
    }
    // A Template's parts: their Domains and files ask `domain: create`
    // and `volume: create`, each alone, as their setup did (ADR-0065), and
    // every picked host is checked again, since one can be taken between
    // the plan and now. Before any step writes, so nothing is left behind.
    const templates = input.steps.flatMap((step) =>
      step.action === 'create' && step.template
        ? [{ configName: step.configName, template: step.template }]
        : [],
    );
    for (const statement of composedCreateStatements({
      domains: templates.reduce(
        (count, { template }) => count + (template.domains?.length ?? 0),
        0,
      ),
      mounts: templates.reduce(
        (count, { template }) => count + (template.files?.length ?? 0),
        0,
      ),
    })) {
      await this.permissions.checkPermission(ctx, statement);
    }
    const taken = await this.takenTemplateHosts(
      ctx,
      input.deployTarget,
      templates.flatMap(({ template }) => template.domains ?? []),
    );
    if (taken.size > 0) {
      throw refusedPlan(
        templates.flatMap(({ configName, template }) =>
          (template.domains ?? []).flatMap(({ host }) => {
            const why = taken.get(host);
            return why === undefined
              ? []
              : [templateHostTaken(configName, host, why)];
          }),
        ),
      );
    }

    const { connections, refusals } = await this.resolveConnections(
      ctx,
      input.steps,
      input.config,
      input.saved,
      input.configRepository?.gitProviderId ?? null,
    );
    if (refusals.length > 0) throw refusedPlan(refusals);
    return connections;
  }

  /**
   * Which of a Template's picked Domain hosts are taken, with why, for a
   * plan to refuse before it is stored ({@link takenTemplateHosts}).
   */
  async takenTemplateHosts(
    ctx: PermissionCtx,
    deployTarget: DeployTarget,
    wanted: readonly TemplateDomain[],
  ): Promise<Map<string, string>> {
    if (wanted.length === 0) return new Map();
    return takenTemplateHosts(this.domains, ctx, deployTarget, wanted);
  }

  /**
   * The git provider connection each step's hosted source needs: a
   * plan-created Application's, and a changed one's whose repository is new
   * to it. No connection of the named type reaching the repository is a
   * refusal naming `<service>.source`. A plan uses this to refuse before it
   * is stored; an Apply, to refuse before anything is written.
   * `preferred` is the config location's connection, asked first.
   */
  async resolveConnections(
    ctx: PermissionCtx,
    steps: readonly PlanStep[],
    config: ProjectConfig,
    saved: readonly SavedService[],
    preferred: string | null = null,
  ): Promise<{ connections: Connections; refusals: PlanRefusal[] }> {
    const connections = new Map<string, ResolvedConnection>();
    const refusals: PlanRefusal[] = [];
    for (const step of steps) {
      if (
        step.action === 'destroy' ||
        step.action === 'redeploy' ||
        isNetworkStep(step)
      ) {
        continue;
      }
      const entry = config.services[step.configName] as Described | undefined;
      if (!entry) continue;
      // An Application's source, or the repository a stack's compose
      // file is in (ADR-0069).
      const source =
        entry.kind === 'compose'
          ? entry.source
          : isApplicationEntry(entry)
            ? entry.source
            : undefined;
      if (!isHosted(source)) continue;
      if (step.action === 'change') {
        if (!step.fields.some((field) => field.field === 'source')) continue;
        const found = savedOf(saved, step.serviceId);
        if (!isNewRepository(found, source)) continue;
      }
      const found = await this.connections.resolve(
        ctx,
        source.sourceType,
        source.repository,
        preferred,
      );
      if (found) {
        connections.set(step.configName, found);
      } else {
        refusals.push({
          at: `${step.configName}.source`,
          message: `${step.configName}.source: no ${source.sourceType} connection in this organization reaches ${source.repository}; connect one that does, then plan again`,
        });
      }
    }
    return { connections, refusals };
  }

  /**
   * Each step on its own (US27), in the plan's order: creates, then
   * changes and redeploys, then destroys, so an early failure leaves an
   * extra Service rather than a missing one — except where a link orders
   * them, which the planner has already done: a source runs before what
   * links to it, and a destroyed source after whatever stops linking to it.
   *
   * **A kind change's create waits for its destroy**. The two share
   * one Config name, which is unique in the Environment, so the create
   * cannot run while the Service it replaces is there: it runs right after
   * that destroy, and only when the destroy removed it. A refused Delete
   * leaves the old kind standing and fails the create with it, never a
   * second Service under the name. A plan stored before links ordered the Apply lists that
   * create among the creates; it is still run after its destroy.
   */
  async run(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
  ): Promise<PlanStepResult[]> {
    const destroyed = new Map<string, PlanStepResult>();
    const results: PlanStepResult[] = [];
    // A plan never starts a database: read once, as the Apply starts.
    const stopped = await stoppedInCloud(
      this.db,
      input.environmentId,
      new Date(),
    );
    for (const step of replacementsAfterDestroys(input.steps)) {
      switch (step.action) {
        case 'network-create':
          // Made by its own run before the rest is applied.
          continue;
        case 'destroy': {
          const result = await this.destroy(ctx, input, step, {
            replaced: input.steps.some(
              (one) =>
                one.action === 'create' && one.configName === step.configName,
            ),
          });
          destroyed.set(step.configName, result);
          results.push(result);
          continue;
        }
        case 'redeploy':
          results.push(await this.redeploy(ctx, input, step));
          continue;
        case 'network-change':
          // A network's read for Drift has nothing of its own to apply.
          continue;
        case 'network-remove':
          results.push(await this.removeNetwork(input.planId, step));
          continue;
        case 'change': {
          // A read that found AWS as Cloudgate made it has nothing to apply.
          if (isQuietRead(step)) continue;
          const blocked = blockedReason(step, stopped);
          if (blocked) {
            results.push({
              ...emptyResult(step.configName, 'change'),
              status: 'blocked',
              message: blocked,
              serviceType: step.serviceType,
              serviceId: step.serviceId,
            });
            continue;
          }
          results.push(
            isDriftRead(step)
              ? await this.putBack(input.planId, step)
              : await this.runStep(ctx, input, connections, step),
          );
          continue;
        }
        case 'create': {
          const replaced = destroyed.get(step.configName);
          const destroy = input.steps.find(
            (one): one is Extract<PlanStep, { action: 'destroy' }> =>
              one.action === 'destroy' && one.configName === step.configName,
          );
          if (!destroy || !replaced) {
            results.push(await this.runStep(ctx, input, connections, step));
            continue;
          }
          results.push(
            replaced.status === 'applied' && replaced.deploy === null
              ? await this.runStep(ctx, input, connections, step)
              : {
                  ...emptyResult(step.configName, 'create'),
                  status: 'failed',
                  message:
                    replaced.status === 'applied' && step.existing
                      ? // A switch: the choice stays, for the plan after.
                        `${step.configName} does not use the existing database ${step.existing.identifier} yet: the database Cloudgate made is being deleted in its Cloud account, so it is still there. Once its Delete is done, Check for changes and Apply to switch`
                      : replaced.status === 'applied'
                        ? `${step.configName} was not created as ${article(step.kind)}: the ${destroy.kind} it replaces is being deleted in its Cloud account, so it is still there`
                        : `${step.configName} was not created as ${article(step.kind)}: the ${destroy.kind} it replaces could not be deleted, so it is still there`,
                },
          );
          continue;
        }
      }
    }

    return results;
  }

  /**
   * A redeploy: a Service the config leaves as it is, deployed again
   * so its wired variables are built from the source this Apply changed.
   * Nothing is written; an Application's Deployment is queued (or the
   * build the plan holds released), a database's deploy started with the
   * others after the Apply.
   */
  private async redeploy(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'redeploy' }>,
  ): Promise<PlanStepResult> {
    const base = {
      ...emptyResult(step.configName, 'redeploy'),
      serviceType: step.serviceType,
      serviceId: step.serviceId,
    };
    if (isDatabase(step.serviceType)) {
      return { ...base, status: 'applied', deploy: { status: 'started' } };
    }
    return {
      ...base,
      status: 'applied',
      deploy: await this.deployApplication(
        ctx,
        step.serviceId,
        input.heldBuilds,
      ),
    };
  }

  /**
   * An Environment network nothing uses any more: its destroy-only
   * Cloud run queued, named by `deploy` as a cloud Service's Delete is, and
   * the DNS records its Domains left named on the result. Its run refuses
   * if a Service has come to run in it since the plan.
   */
  private async removeNetwork(
    planId: string,
    step: Extract<PlanStep, { action: 'network-remove' }>,
  ): Promise<PlanStepResult> {
    const base = {
      ...emptyResult(environmentNetworkName(step.region), 'network-remove'),
      dnsRecordsLeft: step.dnsRecordsLeft,
    };
    try {
      const [network] = await this.db
        .select()
        .from(environmentNetwork)
        .where(
          eq(
            environmentNetwork.environmentNetworkId,
            step.environmentNetworkId,
          ),
        );
      if (!network) {
        throw new Error(`The ${environmentNetworkName(step.region)} is gone`);
      }
      const started = await this.networkRemovals.start(network);
      return {
        ...base,
        status: 'applied',
        deploy: { status: 'queued', deploymentId: started.deploymentId },
        network: {
          environmentNetworkId: step.environmentNetworkId,
          deploymentId: started.deploymentId,
        },
      };
    } catch (error) {
      this.logger.warn(
        `Plan ${planId}: removing the ${environmentNetworkName(step.region)} failed: ${describeError(error)}`,
      );
      return { ...base, status: 'failed', message: describeError(error) };
    }
  }

  /**
   * A destroy: the Service's own Delete (ADR-0018), as the console runs it
   * and never forced, so a teardown it cannot confirm refuses it and fails
   * this step alone. What the Delete says it left behind is the
   * step's, since its answer is the last place that exists.
   */
  private async destroy(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'destroy' }>,
    options: { readonly replaced: boolean },
  ): Promise<PlanStepResult> {
    const { planId } = input;
    const base = {
      ...emptyResult(step.configName, 'destroy'),
      serviceType: step.serviceType,
      serviceId: step.serviceId,
    };
    try {
      return {
        ...base,
        status: 'applied',
        ...(await this.delete(ctx, step, options, input)),
      };
    } catch (error) {
      this.logger.warn(
        `Plan ${planId}: destroy ${step.configName} failed: ${describeError(error)}`,
      );
      return { ...base, status: 'failed', message: describeError(error) };
    }
  }

  private async delete(
    ctx: PermissionCtx,
    step: Extract<PlanStep, { action: 'destroy' }>,
    options: { readonly replaced: boolean },
    input: Pick<ApplyInput, 'deleteFilesOf' | 'deleteDataOf'>,
  ): Promise<{
    leftovers: PlanStepLeftovers | null;
    deploy: PlanStepResult['deploy'];
  }> {
    switch (step.serviceType) {
      case 'application': {
        const removed = await this.applications.remove(ctx, step.serviceId);
        // In a Cloud account the Delete is a destroy-only Cloud run:
        // the step names its Deployment, which reads "Deleting" until it ends.
        if ('cloudDelete' in removed && removed.cloudDelete) {
          return {
            leftovers: null,
            deploy: {
              status: 'queued',
              deploymentId: removed.cloudDelete.deploymentId,
            },
          };
        }
        return { leftovers: leftoversOf(removed), deploy: null };
      }
      case 'postgres':
      case 'mysql':
      case 'redis': {
        // A database the same plan creates again under its Config name
        // (a kind change) keeps the links to it, which name that new one.
        const service = this.databaseService(step.serviceType);
        const removed = await service.remove(ctx, step.serviceId, false, {
          linksMoveToReplacement: options.replaced,
          deleteData: input.deleteDataOf.has(step.configName),
        });
        // In a Cloud account the Delete is a destroy-only Cloud run:
        // the step names its Deployment, which keeps the final snapshot.
        if ('cloudDelete' in removed && removed.cloudDelete) {
          return {
            leftovers: null,
            deploy: {
              status: 'queued',
              deploymentId: removed.cloudDelete.deploymentId,
            },
          };
        }
        return { leftovers: leftoversOf(removed), deploy: null };
      }
      case 'bucket': {
        // Its files read again here, as the step runs: kept
        // unless this one bucket was ticked.
        const removed = await this.bucketDeletes.remove(ctx, step.serviceId, {
          deleteFiles: input.deleteFilesOf.has(step.configName),
        });
        // On AWS an empty or emptied bucket goes by a destroy-only Cloud run
        // the step names its Deployment, as a cloud Service's does.
        // On Google Cloud a kept one's run destroys its key, and the
        // step names the bucket kept too; an existing one's, the
        // bucket left as it was and the grant left on it.
        if (removed.cloudDelete) {
          return {
            leftovers: leftoversOf(removed),
            deploy: {
              status: 'queued',
              deploymentId: removed.cloudDelete.deploymentId,
            },
          };
        }
        return { leftovers: leftoversOf(removed), deploy: null };
      }
      case 'compose': {
        // The stack's Delete with its volumes, which the plan line named
        // (ADR-0069): a destroy is a Delete confirmed by name.
        const deleteVolumes = true;
        const removed = await this.compose.remove(
          ctx,
          step.serviceId,
          deleteVolumes,
          false,
          // On a Stack VM its data disk is kept as a final snapshot unless
          // the Apply ticked "also delete its data" for it (#1367).
          { deleteData: input.deleteDataOf.has(step.configName) },
        );
        // On a Stack VM the Delete is a destroy-only Cloud run: the step
        // names its Deployment, which keeps the final snapshot.
        if (removed.stackVmDelete) {
          return {
            leftovers: null,
            deploy: {
              status: 'queued',
              deploymentId: removed.stackVmDelete.deploymentId,
            },
          };
        }
        return { leftovers: leftoversOf(removed), deploy: null };
      }
      default:
        // The planner destroys only kinds the config describes (US34).
        throw new Error(
          `${step.configName} is ${article(step.serviceType)} Service, which a plan never deletes`,
        );
    }
  }

  /**
   * A database's deploy, started once the plan is written: it writes no
   * Deployment row and converges in the background of its own status
   * (`BaseDatabaseService.deployInternal`), so the Apply does not wait on
   * one, and a failed deploy is the database's, not the plan's. A bucket's
   * is the same: its Garage, then the bucket and its key.
   */
  startDatabaseDeploys(ctx: PermissionCtx, results: readonly PlanStepResult[]) {
    for (const result of results) {
      if (result.deploy?.status !== 'started' || !result.serviceId) continue;
      if (result.serviceType === 'bucket') {
        this.buckets.deploy(result.serviceId).catch((error: unknown) => {
          this.logger.warn(
            `Deploying ${result.configName} after its plan was applied failed: ${describeError(error)}`,
          );
        });
        continue;
      }
      if (!isDatabase(result.serviceType)) continue;
      const service = this.databaseService(result.serviceType);
      service.deploy(ctx, result.serviceId).catch((error: unknown) => {
        this.logger.warn(
          `Deploying ${result.configName} after its plan was applied failed: ${describeError(error)}`,
        );
      });
    }
  }

  /** The per-kind database service a step's create, change or Delete goes through. */
  private databaseService(serviceType: DatabaseKind) {
    switch (serviceType) {
      case 'postgres':
        return this.postgres;
      case 'mysql':
        return this.mysql;
      case 'redis':
        return this.redis;
    }
  }

  /**
   * A cloud Service whose config is unchanged and whose AWS is not (the AWS
   * spec "Drift"): "Apply: put AWS back" queues a Deployment on its
   * live image, whose Cloud run applies the read this plan approved. Its
   * settings are not written, so it is not recorded as this plan's.
   */
  private async putBack(
    planId: string,
    step: Extract<PlanStep, { action: 'change' }>,
  ): Promise<PlanStepResult> {
    const base = {
      ...emptyResult(step.configName, 'change'),
      serviceType: step.serviceType,
      serviceId: step.serviceId,
    };
    if (step.cloudRead?.status !== 'read') {
      return {
        ...base,
        message: `${step.configName} was not read from its Cloud account`,
      };
    }
    try {
      return {
        ...base,
        status: 'applied',
        deploy: await this.cloudDeploys.putBack(step.serviceId, step.cloudRead),
      };
    } catch (error) {
      this.logger.warn(
        `Plan ${planId}: putting its cloud back for ${step.configName} failed: ${describeError(error)}`,
      );
      return { ...base, message: describeError(error) };
    }
  }

  private async runStep(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'create' | 'change' }>,
  ): Promise<PlanStepResult> {
    const entry = input.config.services[step.configName] as Described;
    const written: {
      serviceType: ServiceType | null;
      serviceId: string | null;
    } = {
      serviceType: step.action === 'change' ? step.serviceType : null,
      serviceId: step.action === 'change' ? step.serviceId : null,
    };
    try {
      const outcome: StepOutcome =
        step.action === 'create' && step.stackVm?.consoleStackId
          ? await this.makeConsoleStackVm(
              input,
              { ...step, stackVm: step.stackVm },
              step.stackVm.consoleStackId,
              written,
            )
          : step.action === 'create' && step.existing
            ? await this.createSwitchedExisting(
                ctx,
                input,
                { ...step, existing: step.existing },
                entry,
                written,
              )
            : step.action === 'create'
              ? input.deployTarget.kind === 'cloud'
                ? await this.createInCloud(
                    ctx,
                    input,
                    connections,
                    step,
                    entry,
                    written,
                  )
                : await this.create(
                    ctx,
                    input,
                    connections,
                    step,
                    entry,
                    written,
                  )
              : await this.change(
                  ctx,
                  input,
                  connections,
                  entry,
                  step,
                  written,
                );
      await this.recordPlan(written, input.planId, entry.links ?? {});
      // A Template part's values are its Service's now: a database's
      // written here, before its deploy starts after the Apply (an
      // Application's went in with its create, before its Deployment
      // was queued), and taken out of the Pending setup either way.
      if (step.action === 'create' && step.template) {
        await this.writeDatabaseVariables(input, step, written);
        // A database's config files, before its deploy starts likewise.
        if (isDatabase(written.serviceType) && written.serviceId !== null) {
          await this.writeTemplateFiles(
            ctx,
            input,
            step,
            written.serviceType,
            written.serviceId,
          );
        }
        // A stack on its Stack VM keeps its Domains pending until the
        // Cloud run has made the VM (#1379).
        if (step.stackVm && written.serviceId !== null) {
          await takeStackPart(
            this.db,
            step.template.pendingSetupId,
            step.configName,
            written.serviceId,
          );
        } else {
          await takePart(
            this.db,
            step.template.pendingSetupId,
            step.configName,
          );
        }
      }
      // A switch is made once the Service it adds is.
      if (
        step.action === 'create' &&
        (step.kind === 'postgres' ||
          step.kind === 'mysql' ||
          step.kind === 'redis')
      ) {
        await dropSwitch(this.db, {
          environmentId: input.environmentId,
          configName: step.configName,
        });
      }
      return {
        configName: step.configName,
        action: step.action,
        status: 'applied',
        message: null,
        serviceType: written.serviceType,
        serviceId: written.serviceId,
        domain: outcome.domain,
        deploy: outcome.deploy,
        leftovers: null,
        ...(outcome.domainPortMove
          ? { domainPortMove: outcome.domainPortMove }
          : {}),
      };
    } catch (error) {
      this.logger.warn(
        `Plan ${input.planId}: ${step.action} ${step.configName} failed: ${describeError(error)}`,
      );
      if (written.serviceId) await this.recordPlan(written, input.planId);
      return {
        configName: step.configName,
        action: step.action,
        status: 'failed',
        message: describeError(error),
        serviceType: written.serviceType,
        serviceId: written.serviceId,
        domain: null,
        deploy: null,
        leftovers: null,
      };
    }
  }

  /**
   * The existing database a switch goes to (ADR-0033), created as
   * "Use an existing database" creates one, from the login the switch
   * holds — on a redis, its replication group, AUTH token and TLS
   * flag — with the entry's description. Nothing reaches AWS: the next plan
   * looks it up, and its Outputs have no address until then.
   */
  private async createSwitchedExisting(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }> & {
      readonly existing: { readonly identifier: string };
    },
    entry: Described,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: null }> {
    const place = {
      environmentId: input.environmentId,
      configName: step.configName,
    };
    const changed = new Error(
      `${step.configName}'s switch to the existing database ${step.existing.identifier} was cancelled or changed since the plan, so nothing was created; Check for changes`,
    );
    if (step.kind === 'redis') {
      const found = await switchOf(this.db, place, 'redis');
      const choice = found ? existingCacheChoiceOf(found) : null;
      if (choice?.identifier !== step.existing.identifier) throw changed;
      const created = await this.redis.createExisting(ctx, {
        ...place,
        ...choice,
      });
      written.serviceType = 'redis';
      written.serviceId = created.redisId;
      if (entry.description) {
        await this.redis.update(ctx, created.redisId, {
          description: entry.description,
        });
      }
      return { domain: null, deploy: null };
    }
    // A postgres's, or a mysql's: the same create from the login.
    const kind = step.kind === 'mysql' ? 'mysql' : 'postgres';
    const found = await switchOf(this.db, place, kind);
    const login = found ? existingChoiceOf(found) : null;
    if (login?.identifier !== step.existing.identifier) throw changed;
    const service = kind === 'mysql' ? this.mysql : this.postgres;
    const created = await service.createExisting(ctx, { ...place, ...login });
    const id = rdsIdOf(created);
    written.serviceType = kind;
    written.serviceId = id;
    if (entry.description) {
      await service.update(ctx, id, { description: entry.description });
    }
    return { domain: null, deploy: null };
  }

  /**
   * A plan-created Service: on the Environment's Deploy target, named
   * by its Config name, every Cloudgate setting starting empty as a console
   * create leaves it. A `web` gets a generated sslip.io Domain on its
   * `port`, whose host is generated before the Service is written, so a
   * platform host with no public address fails the step with nothing
   * written. A `web-private` gets none: it is reached only at its internal
   * address. A database's password is generated by its create path.
   * A bucket gets a generated Domain the same way, over HTTPS with a
   * Let's Encrypt certificate, routed to its Garage's S3 API: its
   * `endpoint` Output is that Domain, so presigned URLs and browser
   * uploads work as they do on S3.
   */
  private async create(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Described,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    const { configName } = step;
    const serverId = serverIdOf(input.deployTarget);
    const base = {
      name: configName,
      environmentId: input.environmentId,
      serverId,
    };

    switch (entry.kind) {
      case 'web':
      case 'web-private':
      case 'worker':
      case 'static':
      case 'cron': {
        // Only a `web` is given a Domain: a `worker` serves nothing. A
        // Template `web` whose values name its URL takes the host its setup
        // made, so the value and the Domain agree (ADR-0064).
        const appName = generateAppName('app');
        const host =
          entry.kind === 'web'
            ? (step.template?.host ??
              (await this.domains.generateHostForNewService(
                ctx,
                appName,
                serverId,
              )))
            : null;
        const settings: UpdateApplicationDto = {
          ...applicationSettings(entry),
          // A Template part's values, before its first Deployment.
          ...templateVariables(input.templateValues, step),
          // Its Swarm settings: on a Server, `native.docker`'s.
          ...swarmSettings(entry),
          ...sourceSettings(
            entry.source,
            onConfigBranch(
              connections.get(configName) ?? null,
              entry.source,
              input.configRepository,
            ),
            true,
          ),
        };
        const created = await this.applications.create(
          ctx,
          { ...base, appName },
          {
            configName,
            configKind: entry.kind,
            settings,
            ...(entry.kind === 'cron' ? { cron: cronTimetable(entry) } : {}),
          },
        );
        written.serviceType = 'application';
        written.serviceId = created.applicationId;
        if (host !== null && entry.kind === 'web') {
          await this.domains.createForNewService(ctx, {
            host,
            port: entry.port,
            https: false,
            applicationId: created.applicationId,
            domainType: 'application',
          });
        }
        // A Template part's config files, before its first Deployment.
        await this.writeTemplateFiles(
          ctx,
          input,
          step,
          'application',
          created.applicationId,
        );
        return {
          domain: host,
          // A folder source (ADR-0080) has nothing on its build host until
          // `cloudgate deploy` in the Project folder uploads it, and that
          // deploy starts its first build.
          deploy:
            entry.source?.sourceType === 'drop'
              ? null
              : await this.deployApplication(ctx, created.applicationId),
        };
      }
      case 'postgres': {
        const settings = postgresSettings(entry);
        const created = await this.postgres.create(
          ctx,
          {
            ...base,
            ...settings,
            ...swarmSettings(entry),
            description: settings.description ?? undefined,
            databaseName:
              settings.databaseName ?? defaultDatabaseIdentifier(configName),
            databaseUser:
              settings.databaseUser ?? defaultPostgresUser(configName),
          },
          { configName },
        );
        written.serviceType = 'postgres';
        written.serviceId = created.postgresId;
        return { domain: null, deploy: { status: 'started' } };
      }
      case 'mysql': {
        // Both passwords are generated by the create path, as a console
        // create's are; the config never holds one.
        const settings = mysqlSettings(entry);
        const created = await this.mysql.create(
          ctx,
          {
            ...base,
            ...settings,
            ...swarmSettings(entry),
            description: settings.description ?? undefined,
            databaseName:
              settings.databaseName ?? defaultDatabaseIdentifier(configName),
            databaseUser:
              settings.databaseUser ?? defaultDatabaseIdentifier(configName),
          },
          { configName },
        );
        written.serviceType = 'mysql';
        written.serviceId = created.mysqlId;
        return { domain: null, deploy: { status: 'started' } };
      }
      case 'redis': {
        const settings = redisSettings(entry);
        const created = await this.redis.create(
          ctx,
          {
            ...base,
            ...settings,
            ...swarmSettings(entry),
            description: settings.description ?? undefined,
          },
          { configName },
        );
        written.serviceType = 'redis';
        written.serviceId = created.redisId;
        return { domain: null, deploy: { status: 'started' } };
      }
      case 'bucket': {
        // The real name the plan showed, minted when it was stored.
        if (!step.bucket) {
          throw new Error(
            `${configName} was planned without its bucket's real name; plan again`,
          );
        }
        const appName = generateAppName('bucket');
        const host = await this.domains.generateHostForNewService(
          ctx,
          appName,
          serverId,
        );
        const created = await this.buckets.create(
          ctx,
          {
            ...base,
            description: entry.description,
            appName,
            // Its Garage's labels, its `native.docker`'s one key.
            labelsSwarm: swarmSettings(entry).labelsSwarm ?? null,
          },
          { configName, bucketName: step.bucket.name },
        );
        written.serviceType = 'bucket';
        written.serviceId = created.bucketId;
        await this.domains.createForNewService(ctx, {
          host,
          https: true,
          certificateType: 'letsencrypt',
          bucketId: created.bucketId,
        });
        return { domain: host, deploy: { status: 'started' } };
      }
      case 'compose':
        // A Template's compose part: its line is console-managed, and its
        // stack is made from the Pending setup (#1373).
        if (step.template) {
          return this.createTemplateStack(
            ctx,
            input,
            { ...step, template: step.template },
            written,
          );
        }
        return this.createCompose(ctx, input, connections, step, entry, {
          base,
          written,
        });
    }
  }

  /**
   * A Template's compose part (#1373, ADR-0065), on a Server or the
   * platform host: one all-or-nothing step. The stack's row with its raw
   * compose file, then its `.env` (every value its file uses, from the
   * Pending setup), its config files as encrypted file mounts its file binds
   * at `../files/<path>`, and its Domains on the hosts the setup picked,
   * which `check` has just found free. If anything after the row fails, the
   * row is deleted again, its mounts and Domains with it: it was never
   * deployed and holds no data, so nothing is lost, and the part stays in
   * the Pending setup for the next plan. Then an ordinary Deployment.
   *
   * The stack is console-managed from here on: its line says
   * `managed: console`, so no later plan changes or destroys it.
   *
   * A file a mount wrote to the stack's files directory before a later
   * write failed stays there, inert, as `MountsService.insertMount` says of
   * its own residue: no row points at it, and the next setup overwrites it.
   */
  private async createTemplateStack(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }> & {
      readonly template: TemplateCreate;
    },
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy }> {
    const writes = input.templateWrites?.get(step.configName);
    const values = input.templateValues?.get(step.configName);
    if (!writes?.composeFile || !values) {
      throw new Error(
        `${step.configName}'s Pending setup no longer holds its compose file; Check for changes`,
      );
    }
    const created = await this.compose.create(
      ctx,
      {
        name: step.configName,
        environmentId: input.environmentId,
        serverId: serverIdOf(input.deployTarget),
        composeType: 'docker-compose',
        sourceType: 'raw',
        composeFile: writes.composeFile,
      },
      { configName: step.configName },
    );
    try {
      const { env } = templateVariables(input.templateValues, step);
      if (env !== undefined) {
        await this.db
          .update(compose)
          .set({ env })
          .where(eq(compose.composeId, created.composeId));
      }
      await this.writeTemplateFiles(
        ctx,
        input,
        step,
        'compose',
        created.composeId,
      );
      for (const domain of step.template.domains ?? []) {
        // As the URL a value or file was filled with at setup.
        const https = appliedDomainHttps(domain);
        await this.domains.create(ctx, {
          host: domain.host,
          path: domain.path,
          port: domain.port,
          serviceName: domain.service,
          composeId: created.composeId,
          domainType: 'compose',
          https,
          certificateType: https ? 'letsencrypt' : 'none',
        });
      }
    } catch (error) {
      await this.db
        .delete(compose)
        .where(eq(compose.composeId, created.composeId));
      throw error;
    }
    written.serviceType = 'compose';
    written.serviceId = created.composeId;
    return {
      domain: step.template.domains?.[0]?.host ?? null,
      deploy: await this.deployCompose(ctx, created.composeId),
    };
  }

  /**
   * A Template's compose part in a Cloud Environment (#1379, ADR-0070,
   * ADR-0065 as amended): its stack on its own Stack VM, which a Cloud run
   * makes after this Apply. All or nothing, as on a Server, for what the
   * Apply writes: the stack's row in the Cloud account and region under
   * the id its plan was read with, with its raw compose file, its `.env`,
   * its config files as encrypted file mounts (rows only; the Cloud run
   * writes them onto the Stack VM once it answers) and its Infrastructure
   * state. If anything after the row fails, the row is deleted again.
   *
   * The Stack VM's console size is the template's minimum, when it named
   * one, so a later plan never resizes the stack back down to `medium`.
   *
   * Its Domains are not made here: a Domain's load balancer rule reaches a
   * Stack VM, which does not exist until the Cloud run has made it
   * (`StackVmDomainRuns.refusal`). They stay in the Pending setup, and the
   * Cloud run adds them through the cloud Domain path once the Stack VM is
   * made, before the stack's first Deployment publishes their ports.
   */
  private async createTemplateStackOnStackVm(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }> & {
      readonly template: TemplateCreate;
    },
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: PlanStepDeploy }> {
    const read = step.cloudRead;
    const { stackVm } = step;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !stackVm ||
      read?.status !== 'read' ||
      !read.serviceId
    ) {
      throw new Error(`${step.configName} was not read from its cloud`);
    }
    const writes = input.templateWrites?.get(step.configName);
    const values = input.templateValues?.get(step.configName);
    if (!writes?.composeFile || !values) {
      throw new Error(
        `${step.configName}'s Pending setup no longer holds its compose file; Check for changes`,
      );
    }
    const created = await this.compose.create(
      ctx,
      {
        name: step.configName,
        environmentId: input.environmentId,
        composeType: 'docker-compose',
        sourceType: 'raw',
        composeFile: writes.composeFile,
      },
      {
        configName: step.configName,
        cloud: {
          composeId: read.serviceId,
          cloudAccountId: input.deployTarget.cloudAccountId,
          region: input.deployTarget.region,
          stackVm: {
            machineType: stackVm.size.machineType,
            sizeName: stackVm.size.name,
            dataDiskGb: stackVm.dataDiskGb,
            snapshotDays: stackVm.snapshotDays,
            ...(stackVm.size.from === 'template' && stackVm.size.name
              ? { console: { sizeName: stackVm.size.name } }
              : {}),
            made: null,
          },
        },
      },
    );
    try {
      const { env } = templateVariables(input.templateValues, step);
      if (env !== undefined) {
        await this.db
          .update(compose)
          .set({ env })
          .where(eq(compose.composeId, created.composeId));
      }
      await this.writeTemplateFiles(
        ctx,
        input,
        step,
        'compose',
        created.composeId,
      );
      const [{ cloud }] = await this.db
        .select({ cloud: cloudAccount.cloud })
        .from(cloudAccount)
        .where(
          eq(cloudAccount.cloudAccountId, input.deployTarget.cloudAccountId),
        );
      await this.states.create(
        { composeId: created.composeId },
        read.stateId,
        stateProviderOf(cloud),
      );
    } catch (error) {
      await this.db
        .delete(compose)
        .where(eq(compose.composeId, created.composeId));
      throw error;
    }
    written.serviceType = 'compose';
    written.serviceId = created.composeId;
    return {
      domain: null,
      deploy: await this.cloudStackVms.start(
        created,
        input.environmentId,
        read,
      ),
    };
  }

  /**
   * A Template part's config files, each a file mount on its Service
   * (#1373): a compose part's at `../files/<path>`, which its compose file
   * binds, so with no container target; an own part's mounted where the
   * template says. The text was filled in at setup, and its column is
   * encrypted (ADR-0015). `volume: create` was asked by `check`.
   */
  private async writeTemplateFiles(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    serviceType: 'application' | 'compose' | 'postgres' | 'mysql' | 'redis',
    serviceId: string,
  ): Promise<void> {
    if (!step.template?.files?.length) return;
    const files = input.templateWrites?.get(step.configName)?.files;
    if (!files) {
      throw new Error(
        `${step.configName}'s Pending setup no longer holds its config files; Check for changes`,
      );
    }
    for (const file of files) {
      await this.mounts.createForNewService(ctx, {
        type: 'file',
        filePath: file.path,
        content: file.content,
        serviceId,
        serviceType,
        ...(file.mount === null ? {} : { mountPath: file.mount }),
      });
    }
  }

  /**
   * A plan-created Compose stack (ADR-0069): the stack's own create,
   * named by its Config name, then its own update with where its compose
   * file is — the repository through the connection resolved for it, on
   * the Environment's Config branch when it is the config's own repository
   * — and an ordinary Deployment. No Domain: a stack's Domains are
   * Cloudgate's, added per service in the console.
   */
  private async createCompose(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'compose' }>,
    {
      base,
      written,
    }: {
      base: { name: string; environmentId: string; serverId: string | null };
      written: { serviceType: ServiceType | null; serviceId: string | null };
    },
  ): Promise<{ domain: null; deploy: PlanStepDeploy }> {
    const settings = composeSettings(entry, {
      connection: onConfigBranch(
        connections.get(step.configName) ?? null,
        entry.source,
        input.configRepository,
      ),
      isNewRepository: true,
    });
    const created = await this.compose.create(
      ctx,
      {
        ...base,
        composeType: settings.composeType,
        sourceType: settings.sourceType,
      },
      { configName: step.configName },
    );
    written.serviceType = 'compose';
    written.serviceId = created.composeId;
    await this.compose.update(ctx, created.composeId, settings);
    return {
      domain: null,
      deploy: await this.deployCompose(ctx, created.composeId),
    };
  }

  /**
   * A `compose` entry created in a Cloud Environment, AWS (#1359) or
   * Google Cloud (#1362) (ADR-0070):
   * the stack's row with its cloud place and Stack VM settings, never a
   * Server, under the id its plan was read with; then its own update with
   * where its compose file is, as on a Server; its Infrastructure state the
   * one that plan read; and the Cloud run that makes its Stack VM queued
   * (`CloudStackVmRuns`). The Environment network is made first by the same
   * Apply. Nothing is deployed onto the Stack VM yet: that is the next
   * ticket's.
   */
  private async createComposeOnStackVm(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'compose' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: PlanStepDeploy }> {
    const read = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.stackVm ||
      read?.status !== 'read' ||
      !read.serviceId
    ) {
      throw new Error(`${step.configName} was not read from its cloud`);
    }
    const { stackVm } = step;
    const settings = composeSettings(entry, {
      connection: onConfigBranch(
        connections.get(step.configName) ?? null,
        entry.source,
        input.configRepository,
      ),
      isNewRepository: true,
    });
    const created = await this.compose.create(
      ctx,
      {
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        composeType: settings.composeType,
        sourceType: settings.sourceType,
      },
      {
        configName: step.configName,
        cloud: {
          composeId: read.serviceId,
          cloudAccountId: input.deployTarget.cloudAccountId,
          region: input.deployTarget.region,
          stackVm: {
            machineType: stackVm.size.machineType,
            sizeName: stackVm.size.name,
            dataDiskGb: stackVm.dataDiskGb,
            snapshotDays: stackVm.snapshotDays,
            ...(stackVm.native ? { native: stackVm.native } : {}),
            ...(stackVm.nativeGcp ? { nativeGcp: stackVm.nativeGcp } : {}),
            made: null,
          },
        },
      },
    );
    written.serviceType = 'compose';
    written.serviceId = created.composeId;
    await this.compose.update(ctx, created.composeId, settings);
    // Its state is written with its Cloud account's cloud's provider: an
    // AWS or a Google Stack VM's.
    const [{ cloud }] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(
        eq(cloudAccount.cloudAccountId, input.deployTarget.cloudAccountId),
      );
    await this.states.create(
      { composeId: created.composeId },
      read.stateId,
      stateProviderOf(cloud),
    );
    return {
      domain: null,
      deploy: await this.cloudStackVms.start(
        created,
        input.environmentId,
        read,
      ),
    };
  }

  /**
   * A console-made stack's Stack VM (#1372): the stack's row is the
   * console's, so no Service is created. Its Stack VM settings take the
   * size the plan showed, its Infrastructure state is made under the id
   * the plan was read with, and its Cloud run starts, as a described
   * stack's create does.
   */
  private async makeConsoleStackVm(
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }> & {
      readonly stackVm: NonNullable<
        Extract<PlanStep, { action: 'create' }>['stackVm']
      >;
    },
    composeId: string,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: PlanStepDeploy }> {
    const read = step.cloudRead;
    if (read?.status !== 'read' || read.serviceId !== composeId) {
      throw new Error(`${step.configName} was not read from its cloud`);
    }
    const [found] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    if (!found?.stackVm || !found.cloudAccountId) {
      throw new Error(`${step.configName} has no Stack VM to make`);
    }
    if (found.stackVm.made) {
      throw new Error(`${step.configName}'s Stack VM is already made`);
    }
    if (await this.states.findForCompose(composeId)) {
      throw new Error(
        `${step.configName} still has the Infrastructure state an earlier Apply left; check for changes, then apply the new plan`,
      );
    }
    written.serviceType = 'compose';
    written.serviceId = composeId;
    const { stackVm } = step;
    await this.db
      .update(compose)
      .set({
        stackVm: {
          ...found.stackVm,
          machineType: stackVm.size.machineType,
          sizeName: stackVm.size.name,
          dataDiskGb: stackVm.dataDiskGb,
          snapshotDays: stackVm.snapshotDays,
        },
      })
      .where(eq(compose.composeId, composeId));
    const [{ cloud }] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, found.cloudAccountId));
    await this.states.create(
      { composeId },
      read.stateId,
      stateProviderOf(cloud),
    );
    return {
      domain: null,
      deploy: await this.cloudStackVms.start(found, input.environmentId, read),
    };
  }

  /**
   * A changed Compose stack (ADR-0069): its file's path, and its
   * repository when the plan changes it, written through the stack's own
   * update, then an ordinary Deployment. A `type` change never reaches
   * here: it is a destroy plus a create.
   */
  private async changeCompose(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'change' }>,
    entry: Extract<Described, { kind: 'compose' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: PlanStepDeploy }> {
    const id = step.serviceId;
    const settings = composeSettings(
      entry,
      step.fields.some((field) => field.field === 'source')
        ? {
            connection: connections.get(step.configName) ?? null,
            isNewRepository: isNewRepository(
              savedOf(input.saved, id),
              entry.source,
            ),
          }
        : null,
    );
    await this.compose.update(ctx, id, settings);
    written.serviceType = 'compose';
    return { domain: null, deploy: await this.deployCompose(ctx, id) };
  }

  /**
   * A change to a stack's Stack VM (ADR-0070, #1368): a resize, which
   * restarts it, a larger data disk, or an approved "replace VM", which
   * makes it again at Cloudgate's new pins beside the same data disk, or
   * its cloud put back as its read for Drift found it. The fields its
   * entry changes are written as on a Server; then the Stack VM settings
   * the change moves to (`stackVmSettingsAfter`), what its console asked
   * dropped once taken; and the Cloud run that applies what the plan's
   * read approved is queued (`CloudStackVmRuns`). A console-managed stack
   * has no entry fields to write. Nothing is deployed onto the Stack VM.
   */
  private async changeStackVm(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'change' }>,
    entry: Described,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: PlanStepDeploy }> {
    const id = step.serviceId;
    const read = step.cloudRead;
    if (!step.stackVm || read?.status !== 'read') {
      throw new Error(`${step.configName} was not read from its cloud`);
    }
    written.serviceType = 'compose';
    if (
      entry.kind === 'compose' &&
      step.fields.some((field) => field.field !== 'size')
    ) {
      await this.compose.update(
        ctx,
        id,
        composeSettings(
          entry,
          step.fields.some((field) => field.field === 'source')
            ? {
                connection: connections.get(step.configName) ?? null,
                isNewRepository: isNewRepository(
                  savedOf(input.saved, id),
                  entry.source,
                ),
              }
            : null,
        ),
      );
    }
    const [row] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, id));
    if (!row?.stackVm) throw new Error(`${step.configName} has no Stack VM`);
    await this.db
      .update(compose)
      .set({ stackVm: stackVmSettingsAfter(row.stackVm, step.stackVm) })
      .where(eq(compose.composeId, id));
    const { stackVm } = step;
    const title = stackVm.replace
      ? `Replace ${step.configName}'s Stack VM`
      : stackVm.resize
        ? `Resize ${step.configName}'s Stack VM`
        : stackVm.grow
          ? `Grow ${step.configName}'s Stack VM data disk`
          : `Put ${step.configName}'s Stack VM back`;
    return {
      domain: null,
      deploy: await this.cloudStackVms.start(row, input.environmentId, read, {
        title,
      }),
    };
  }

  /**
   * A stack's ordinary Deployment, recorded pending and queued; a
   * refusal to queue one leaves the step applied and says why, as an
   * Application's does.
   */
  private async deployCompose(
    ctx: PermissionCtx,
    composeId: string,
  ): Promise<PlanStepDeploy> {
    try {
      const queued = await this.deployments.deployCompose(ctx, composeId, {
        title: 'Plan applied',
        description: 'Queued by applying the Project config',
      });
      return { status: 'queued', deploymentId: queued.deploymentId };
    } catch (error) {
      return { status: 'not-deployed', message: describeError(error) };
    }
  }

  /**
   * A `web` created in a Cloud account, or a `worker` or a
   * `web-private` on ECS, which differ only in their recorded kind:
   * the Application with its
   * cloud place, under the Service id its plan was read with, its
   * Infrastructure state the one that plan read, and its Deployment queued.
   * That Deployment builds on the platform host and then runs the Cloud run
   * that applies what this step approved (`CloudServiceDeploys`). No
   * generated Domain: there is no sslip.io name on AWS, and the plan says
   * so. Its Environment network is made first by the same Apply.
   */
  private async createInCloud(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Described,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    // A Template's compose part: console-managed, made from its Pending
    // setup on its own Stack VM (#1379).
    if (step.kind === 'compose' && step.template) {
      return this.createTemplateStackOnStackVm(
        ctx,
        input,
        { ...step, template: step.template },
        written,
      );
    }
    if (input.deployTarget.kind === 'cloud' && entry.kind === 'postgres') {
      return this.createPostgresInCloud(ctx, input, step, entry, written);
    }
    if (input.deployTarget.kind === 'cloud' && entry.kind === 'mysql') {
      // On Cloud SQL as a postgres there, else on RDS.
      return step.cloudSql
        ? this.createOnCloudSql(ctx, input, step, entry, written)
        : this.createMysqlOnRds(ctx, input, step, entry, written);
    }
    if (input.deployTarget.kind === 'cloud' && entry.kind === 'redis') {
      return this.createRedisInCloud(ctx, input, step, entry, written);
    }
    if (input.deployTarget.kind === 'cloud' && entry.kind === 'bucket') {
      return this.createBucketInCloud(ctx, input, step, entry, written);
    }
    if (input.deployTarget.kind === 'cloud' && entry.kind === 'compose') {
      return this.createComposeOnStackVm(
        ctx,
        input,
        connections,
        step,
        entry,
        written,
      );
    }
    if (input.deployTarget.kind === 'cloud' && entry.kind === 'static') {
      return this.createStaticInCloud(
        ctx,
        input,
        connections,
        step,
        entry,
        written,
      );
    }
    if (
      input.deployTarget.kind !== 'cloud' ||
      (entry.kind !== 'web' &&
        entry.kind !== 'worker' &&
        entry.kind !== 'web-private' &&
        entry.kind !== 'cron')
    ) {
      throw new Error(
        `${step.configName} is ${article(entry.kind)}, and only a web, a worker, a web-private, a cron, a postgres, a mysql, a redis, a bucket or a static site can be created in a Cloud account`,
      );
    }
    const aws = step.cloudRead;
    if (aws?.status !== 'read' || !aws.serviceId) {
      throw new Error(`${step.configName} was not read from AWS`);
    }
    const settings: UpdateApplicationDto = {
      ...applicationSettings(entry),
      // A Template part's values, before its first deploy.
      ...templateVariables(input.templateValues, step),
      ...sourceSettings(
        entry.source,
        onConfigBranch(
          connections.get(step.configName) ?? null,
          entry.source,
          input.configRepository,
        ),
        true,
      ),
    };
    // Written with its Cloud account's cloud's provider (the Google Cloud spec).
    const [{ cloud }] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(
        eq(cloudAccount.cloudAccountId, input.deployTarget.cloudAccountId),
      );
    const created = await this.applications.create(
      ctx,
      {
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        appName: generateAppName('app'),
      },
      {
        configName: step.configName,
        // A Worker on ECS is recorded as one, so its deploys route
        // it by nothing and it takes no Domain; a Private web service
        // too, routed by private DNS, with no Domain, published
        // port or preview. A Cron service keeps its timetable on
        // its row, as on a Server: Cloudgate's timetable fires its runs.
        configKind: entry.kind,
        settings,
        ...(entry.kind === 'cron' ? { cron: cronTimetable(entry) } : {}),
        cloud: {
          applicationId: aws.serviceId,
          cloudAccountId: input.deployTarget.cloudAccountId,
          region: input.deployTarget.region,
          // A Cloud Run service's copy range, Cloudgate's own from here
          // (S10). A Worker's worker pool has none: its `replicas` are its
          // instance count.
          ...byCloud(cloud, {
            aws: {},
            gcp:
              cloudRunResourceOf(entry.kind) === 'service'
                ? {
                    minCopies: CLOUD_RUN_COPIES.min,
                    maxCopies: CLOUD_RUN_COPIES.max,
                  }
                : {},
          }),
        },
      },
    );
    written.serviceType = 'application';
    written.serviceId = created.applicationId;
    await this.states.create(
      { applicationId: created.applicationId },
      aws.stateId,
      stateProviderOf(cloud),
    );
    await this.saveNativeAws(created.applicationId, cloud, entry);
    await this.saveNativeGcp(created.applicationId, cloud, entry);
    // A folder source (ADR-0080): nothing to build until `cloudgate deploy`
    // in the Project folder uploads it, as on a Server.
    if (entry.source?.sourceType === 'drop') {
      return { domain: null, deploy: null };
    }
    const deploy = await this.deployApplication(ctx, created.applicationId);
    if (deploy.status === 'queued') {
      this.cloudDeploys.approve(deploy.deploymentId, aws);
    }
    return { domain: null, deploy };
  }

  /**
   * A `postgres` created in a Cloud account: its row with its cloud
   * place and Cloudgate's settings, under the id its plan was read with, its
   * Infrastructure state the one that plan read, and the Cloud run that
   * makes the RDS instance queued (`CloudPostgresRuns`). Its password is
   * generated by the create path, as on a Server; the config never holds
   * one. The Environment network is made first by the same Apply.
   */
  private async createPostgresInCloud(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'postgres' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    if (step.cloudSql) {
      return this.createOnCloudSql(ctx, input, step, entry, written);
    }
    const aws = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.database ||
      aws?.status !== 'read' ||
      !aws.serviceId
    ) {
      throw new Error(`${step.configName} was not read from AWS`);
    }
    const settings = postgresSettings(entry);
    const created = await this.postgres.create(
      ctx,
      {
        ...settings,
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        description: settings.description ?? undefined,
        databaseName: step.database.login.database,
        databaseUser: step.database.login.user,
        postgresId: aws.serviceId,
        cloudAccountId: input.deployTarget.cloudAccountId,
        region: input.deployTarget.region,
        instanceClass: step.database.size.smallest
          ? step.database.size.instanceClass
          : null,
      },
      { configName: step.configName },
    );
    written.serviceType = 'postgres';
    written.serviceId = created.postgresId;
    // Its `native.aws`, its console-owned values on the console's
    // columns too, saved before its Cloud run, which lays it.
    await this.db
      .update(postgres)
      .set(rdsNativeColumns(laidAwsBlock(entry)))
      .where(eq(postgres.postgresId, created.postgresId));
    // What the instance is made with, which the next plan diffs the
    // console's settings against.
    const [made] = await this.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, created.postgresId));
    if (made) {
      await this.db
        .update(postgres)
        .set({ rdsApplied: rdsConsoleSettings(made) })
        .where(eq(postgres.postgresId, created.postgresId));
    }
    await this.states.create({ postgresId: created.postgresId }, aws.stateId);
    return {
      domain: null,
      deploy: await this.cloudPostgres.start(created, input.environmentId, aws),
    };
  }

  /**
   * A `mysql` created in an AWS Cloud account, as a postgres on RDS
   * is (`createPostgresInCloud`): its row with its cloud place and
   * Cloudgate's settings under the id its plan was read with, its
   * Infrastructure state the one that plan read, and the RDS Cloud run that
   * makes the RDS for MySQL instance queued. Its passwords are generated by
   * the create path; the master user's is the one RDS is made with.
   */
  private async createMysqlOnRds(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'mysql' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    const aws = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.database ||
      aws?.status !== 'read' ||
      !aws.serviceId
    ) {
      throw new Error(`${step.configName} was not read from AWS`);
    }
    const settings = mysqlSettings(entry);
    const created = await this.mysql.create(
      ctx,
      {
        ...settings,
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        description: settings.description ?? undefined,
        databaseName: step.database.login.database,
        databaseUser: step.database.login.user,
        mysqlId: aws.serviceId,
        cloudAccountId: input.deployTarget.cloudAccountId,
        region: input.deployTarget.region,
        instanceClass: step.database.size.smallest
          ? step.database.size.instanceClass
          : null,
      },
      { configName: step.configName },
    );
    written.serviceType = 'mysql';
    written.serviceId = created.mysqlId;
    // Its `native.aws`, as a postgres's; then what the instance is
    // made with, which the next plan diffs the console's settings against.
    const native = rdsNativeColumns(laidAwsBlock(entry));
    await updateRdsRow(this.db, 'mysql', created.mysqlId, {
      ...native,
      rdsApplied: rdsConsoleSettings({ ...created, ...native }),
    });
    await this.states.create({ mysqlId: created.mysqlId }, aws.stateId);
    return {
      domain: null,
      deploy: await this.cloudPostgres.start(created, input.environmentId, aws),
    };
  }

  /**
   * A `postgres` created on Google Cloud: its row with its cloud
   * place under the id its plan was read with, the machine the plan named
   * saved as the one it runs on, its Infrastructure state the one that plan
   * read (written with the Google provider), and the Cloud run that makes
   * the Cloud SQL instance queued (`CloudPostgresRuns`). Its password is
   * generated by the create path, as on a Server. The Environment network
   * and its private link are made first by the same Apply.
   * A `mysql` is the same create, its row a mysql's, whose create
   * path generates its `root` password too.
   */
  private async createOnCloudSql(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: CloudSqlEngineName }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    const read = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.cloudSql ||
      read?.status !== 'read' ||
      !read.serviceId
    ) {
      throw new Error(`${step.configName} was not read from Google Cloud`);
    }
    const place = {
      name: step.configName,
      environmentId: input.environmentId,
      serverId: null,
      databaseName: step.cloudSql.login.database,
      databaseUser: step.cloudSql.login.user,
      cloudAccountId: input.deployTarget.cloudAccountId,
      region: input.deployTarget.region,
      instanceClass: step.cloudSql.size.tier,
    };
    const created =
      entry.kind === 'mysql'
        ? await this.mysql.create(
            ctx,
            {
              ...mysqlSettings(entry),
              ...place,
              description: entry.description ?? undefined,
              mysqlId: read.serviceId,
            },
            { configName: step.configName },
          )
        : await this.postgres.create(
            ctx,
            {
              ...postgresSettings(entry),
              ...place,
              description: entry.description ?? undefined,
              postgresId: read.serviceId,
            },
            { configName: step.configName },
          );
    const kind = rdsKindOf(created);
    const id = rdsIdOf(created);
    written.serviceType = kind;
    written.serviceId = id;
    // The backups it is made with, which its Backups tab edits and
    // the next plan diffs against, and its `native.gcp`, saved
    // before its Cloud run, which lays it: a backup count it sets is
    // already the step's.
    await updateRdsRow(this.db, kind, id, {
      nativeGcp: step.cloudSql.native ?? null,
      backupRetentionDays: step.cloudSql.backupRetentionDays,
      cloudSqlApplied: {
        backupRetentionDays: step.cloudSql.backupRetentionDays,
        pointInTimeRecovery: step.cloudSql.pointInTimeRecovery,
      },
    });
    await this.states.create(
      rdsOwnerOf(kind, id),
      read.stateId,
      stateProviderOf('gcp'),
    );
    return {
      domain: null,
      deploy: await this.cloudPostgres.start(
        created,
        input.environmentId,
        read,
        { change: false, allowMajorUpgrade: false, product: 'Cloud SQL' },
      ),
    };
  }

  /**
   * A `bucket` created in a Cloud account: its row with its cloud
   * place under the id its plan was read with and the real name the plan
   * minted — in the account regional namespace on AWS, by that id's key on
   * Google Cloud — its Infrastructure state the one that plan read,
   * and the Cloud run that makes the bucket queued (`CloudBucketRuns`). It
   * sits in no Environment network.
   */
  private async createBucketInCloud(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'bucket' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    const aws = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.bucket ||
      aws?.status !== 'read' ||
      !aws.serviceId
    ) {
      throw new Error(`${step.configName} was not read from its Cloud account`);
    }
    const created = await this.buckets.create(
      ctx,
      {
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        description: entry.description,
        cloud: {
          bucketId: aws.serviceId,
          cloudAccountId: input.deployTarget.cloudAccountId,
          region: input.deployTarget.region,
        },
      },
      { configName: step.configName, bucketName: step.bucket.name },
    );
    written.serviceType = 'bucket';
    written.serviceId = created.bucketId;
    // Its state is its cloud's provider's (the Google Cloud spec): AWS's, or Google's
    // for a bucket on Cloud Storage.
    const [{ cloud }] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(
        eq(cloudAccount.cloudAccountId, input.deployTarget.cloudAccountId),
      );
    await this.states.create(
      { bucketId: created.bucketId },
      aws.stateId,
      stateProviderOf(cloud),
    );
    // Its `native.aws`, saved before its Cloud run, which lays it.
    await this.saveBucketNativeAws(created.bucketId, cloud, entry);
    return {
      domain: null,
      deploy: await this.cloudBuckets.start(
        { ...created, configName: step.configName },
        input.environmentId,
        aws,
        false,
      ),
    };
  }

  /**
   * A `redis` created in a Cloud account: its row with its cloud
   * place, Cloudgate's settings and a generated AUTH token, under the id
   * its plan was read with, its Infrastructure state the one that plan read,
   * and the Cloud run that makes the ElastiCache replication group queued
   * (`CloudRedisRuns`). The Environment network is made first by the same
   * Apply.
   */
  private async createRedisInCloud(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'redis' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    if (step.memorystore) {
      return this.createRedisOnMemorystore(ctx, input, step, entry, written);
    }
    const aws = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.cache ||
      aws?.status !== 'read' ||
      !aws.serviceId
    ) {
      throw new Error(`${step.configName} was not read from AWS`);
    }
    const settings = redisSettings(entry);
    const created = await this.redis.create(
      ctx,
      {
        ...settings,
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        description: settings.description ?? undefined,
        redisId: aws.serviceId,
        cloudAccountId: input.deployTarget.cloudAccountId,
        region: input.deployTarget.region,
        nodeType: step.cache.size.smallest ? step.cache.size.nodeType : null,
        authToken: generateAuthToken(),
      },
      { configName: step.configName },
    );
    written.serviceType = 'redis';
    written.serviceId = created.redisId;
    // Its `native.aws`, its console-owned values on the console's
    // columns too, saved before its Cloud run, which lays it.
    await this.db
      .update(redis)
      .set(elastiCacheNativeColumns(laidAwsBlock(entry)))
      .where(eq(redis.redisId, created.redisId));
    // What the replication group is made with, which the next plan diffs
    // the console's settings against.
    const [made] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, created.redisId));
    if (made) {
      await this.db
        .update(redis)
        .set({ elasticacheApplied: elastiCacheConsoleSettings(made) })
        .where(eq(redis.redisId, created.redisId));
    }
    await this.states.create({ redisId: created.redisId }, aws.stateId);
    return {
      domain: null,
      deploy: await this.cloudRedis.start(created, input.environmentId, aws),
    };
  }

  /**
   * A `redis` created on Google Cloud: its row with its cloud place
   * under the id its plan was read with, the node type the plan named saved
   * as the one it runs on, its Infrastructure state the one that plan read
   * (written with the Google provider), and the Cloud run that makes the
   * Memorystore instance and reads its token queued (`CloudRedisRuns`). No
   * token is generated: Google makes it. The Environment network and its
   * private link are made first by the same Apply.
   */
  private async createRedisOnMemorystore(
    ctx: PermissionCtx,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'redis' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    const read = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.memorystore ||
      read?.status !== 'read' ||
      !read.serviceId
    ) {
      throw new Error(`${step.configName} was not read from Google Cloud`);
    }
    const settings = redisSettings(entry);
    const created = await this.redis.create(
      ctx,
      {
        ...settings,
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        description: settings.description ?? undefined,
        redisId: read.serviceId,
        cloudAccountId: input.deployTarget.cloudAccountId,
        region: input.deployTarget.region,
        nodeType: step.memorystore.size.nodeType,
      },
      { configName: step.configName },
    );
    written.serviceType = 'redis';
    written.serviceId = created.redisId;
    // What the instance is made with, one node and its backups, which the
    // next plan diffs the console's high availability and its
    // Backups tab's retention against, and the engine version the
    // plan read, which it keeps until a planned change.
    // Its `native.gcp` is saved beside them, before its Cloud run,
    // which lays it; a replica or backup count it sets is the step's.
    const highAvailability = step.memorystore.nodes > 1;
    await this.db
      .update(redis)
      .set({
        nativeGcp: step.memorystore.native ?? null,
        memorystoreHighAvailability: highAvailability,
        memorystoreBackupRetentionDays: step.memorystore.backupRetentionDays,
        memorystoreApplied: {
          highAvailability,
          backupRetentionDays: step.memorystore.backupRetentionDays,
        },
        memorystoreEngineVersion: step.memorystore.version.engineVersion,
      })
      .where(eq(redis.redisId, created.redisId));
    await this.states.create(
      { redisId: created.redisId },
      read.stateId,
      stateProviderOf('gcp'),
    );
    return {
      domain: null,
      deploy: await this.cloudRedis.start(
        created,
        input.environmentId,
        read,
        false,
        'Memorystore',
      ),
    };
  }

  /**
   * A `static` site created in a Cloud account: the Application with
   * its cloud place and its own bucket's real name as the plan minted it,
   * under the Service id its plan was read with, its Infrastructure state
   * the one that plan read (written with its cloud's provider), and the
   * Cloud run that makes the bucket and what serves it queued
   * (`CloudStaticRuns`): the CloudFront distribution on AWS, the Cloud CDN
   * backend bucket on Google Cloud. Nothing is built: its files
   * reach the bucket with its deploys. No Environment network.
   */
  private async createStaticInCloud(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    step: Extract<PlanStep, { action: 'create' }>,
    entry: Extract<Described, { kind: 'static' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: string | null; deploy: PlanStepDeploy | null }> {
    const aws = step.cloudRead;
    if (
      input.deployTarget.kind !== 'cloud' ||
      !step.bucket ||
      aws?.status !== 'read' ||
      !aws.serviceId
    ) {
      throw new Error(`${step.configName} was not read from its cloud`);
    }
    const settings: UpdateApplicationDto = {
      ...applicationSettings(entry),
      // A Template part's values, before its first deploy.
      ...templateVariables(input.templateValues, step),
      ...sourceSettings(
        entry.source,
        onConfigBranch(
          connections.get(step.configName) ?? null,
          entry.source,
          input.configRepository,
        ),
        true,
      ),
    };
    const [{ cloud }] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(
        eq(cloudAccount.cloudAccountId, input.deployTarget.cloudAccountId),
      );
    const created = await this.applications.create(
      ctx,
      {
        name: step.configName,
        environmentId: input.environmentId,
        serverId: null,
        appName: generateAppName('app'),
      },
      {
        configName: step.configName,
        configKind: 'static',
        settings,
        cloud: {
          applicationId: aws.serviceId,
          cloudAccountId: input.deployTarget.cloudAccountId,
          region: input.deployTarget.region,
          cloudBucketName: step.bucket.name,
        },
      },
    );
    written.serviceType = 'application';
    written.serviceId = created.applicationId;
    await this.states.create(
      { applicationId: created.applicationId },
      aws.stateId,
      stateProviderOf(cloud),
    );
    // Its `native.aws`, saved before its Cloud run, which lays it.
    await this.saveNativeAws(created.applicationId, cloud, entry);
    return {
      domain: null,
      deploy: await this.cloudStatic.start(
        { ...created, configName: step.configName },
        input.environmentId,
        aws,
        false,
      ),
    };
  }

  /**
   * A changed Service: its config-owned fields through its update path, the
   * variable keys the config no longer lists removed through its variables
   * path, then a Deployment.
   */
  private async change(
    ctx: PermissionCtx,
    input: ApplyInput,
    connections: Connections,
    entry: Described,
    step: Extract<PlanStep, { action: 'change' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<StepOutcome> {
    const id = step.serviceId;
    const lists = new Set(
      step.fields.map((field) => field.field).filter(isVariableList),
    );

    switch (entry.kind) {
      case 'web':
      case 'web-private':
      case 'worker':
      case 'static':
      case 'cron': {
        const settings: UpdateApplicationDto = applicationSettings(entry);
        // A Service Swarm runs takes its config's Swarm settings;
        // one in a Cloud account has none to take.
        if (!savedOf(input.saved, id)?.cloud) {
          Object.assign(settings, swarmSettings(entry));
        }
        if (step.fields.some((field) => field.field === 'source')) {
          Object.assign(
            settings,
            sourceSettings(
              entry.source,
              connections.get(step.configName) ?? null,
              isNewRepository(savedOf(input.saved, id), entry.source),
            ),
          );
        }
        const updated = await this.applications.update(
          ctx,
          id,
          settings,
          entry.kind === 'cron' ? cronTimetable(entry) : undefined,
        );
        // A `web.port` change moved the Domains on the old port (ADR-0068);
        // the change line names them, and the ones it left.
        const { domainPortMove } = updated;
        const savedSite = savedOf(input.saved, id);
        // On Google Cloud a static site's change reads nothing of it,
        // and its `spa`, saved above, is the error policy on its host rules:
        // a run of the Environment network, which clears the cache of its
        // Domains at its end. A site with no Domain has nothing there. On
        // AWS its `spa` is its own Cloud run's, below.
        if (
          entry.kind === 'static' &&
          savedSite?.cloud &&
          step.fields.some((field) => field.field === 'build.spa')
        ) {
          const byNetworkRun = await byCloud<
            () => Promise<{
              domain: null;
              deploy: PlanStepDeploy | null;
            } | null>
          >(cloudOrLegacy(savedSite.cloud.cloud), {
            aws: () => Promise.resolve(null),
            gcp: async () => {
              const [app] = await this.db
                .select()
                .from(application)
                .where(eq(application.applicationId, id));
              if (!app) throw new Error(`${step.configName} is gone`);
              const deploymentId = await this.googleDomains.queueSpaChange(app);
              return {
                domain: null,
                deploy: deploymentId
                  ? { status: 'queued', deploymentId }
                  : null,
              };
            },
          })();
          if (byNetworkRun) return byNetworkRun;
        }
        // A static site on S3 + CloudFront: its `spa`, or Drift its
        // read found, is put back by a Cloud run writing what was read. It
        // holds no variables, and nothing is built here: its files reach
        // its bucket with its deploys.
        if (entry.kind === 'static' && savedSite?.cloud) {
          if (step.cloudRead === undefined)
            return { domain: null, deploy: null };
          if (step.cloudRead.status !== 'read') {
            throw new Error(`${step.configName} was not read from its cloud`);
          }
          const [row] = await this.db
            .select({ appName: application.appName })
            .from(application)
            .where(eq(application.applicationId, id));
          if (!row) throw new Error(`${step.configName} is gone`);
          // Its `native.aws`, saved before its Cloud run lays it.
          await this.saveNativeAws(
            id,
            cloudOrLegacy(savedSite.cloud.cloud),
            entry,
          );
          return {
            domain: null,
            deploy: await this.cloudStatic.start(
              {
                applicationId: id,
                appName: row.appName,
                configName: step.configName,
              },
              input.environmentId,
              step.cloudRead,
              true,
            ),
          };
        }
        if (lists.size > 0) {
          await this.applications.saveEnvironment(
            ctx,
            id,
            await this.keptApplicationVariables(id, entry, lists),
          );
        }
        // A Cron service in a Cloud account whose plan read nothing there
        // changed only its timetable: Cloudgate's settings, saved
        // above, with no AWS call and no deploy.
        if (
          entry.kind === 'cron' &&
          savedOf(input.saved, id)?.cloud &&
          step.cloudRead === undefined
        ) {
          return { domain: null, deploy: null };
        }
        // Its `native.aws` or `native.gcp`, saved before
        // its deploy, which lays it.
        const savedCloud = savedOf(input.saved, id)?.cloud;
        if (savedCloud) {
          await this.saveNativeAws(id, cloudOrLegacy(savedCloud.cloud), entry);
          await this.saveNativeGcp(id, cloudOrLegacy(savedCloud.cloud), entry);
        }
        const deploy = await this.deployApplication(ctx, id, input.heldBuilds);
        // A cloud Service's deploy runs under what this Apply approved, as a
        // create's does: its results are written only after every
        // step, so the run must not wait on them to find its approval.
        if (
          deploy.status === 'queued' &&
          savedOf(input.saved, id)?.cloud &&
          step.cloudRead?.status === 'read'
        ) {
          this.cloudDeploys.approve(deploy.deploymentId, step.cloudRead);
        }
        return { domain: null, deploy, domainPortMove };
      }
      case 'postgres':
      case 'mysql':
      case 'redis': {
        const service = this.databaseService(entry.kind);
        const before = savedOf(input.saved, id);
        if (
          (before?.serviceType === 'postgres' ||
            before?.serviceType === 'mysql' ||
            before?.serviceType === 'redis') &&
          before.existing
        ) {
          await this.saveMovedAddress(id, step);
          await this.changeExisting(ctx, id, entry, lists, written);
          return {
            domain: null,
            deploy: await this.applyExistingEndpoint(input, step, id),
          };
        }
        await service.update(ctx, id, {
          ...(entry.kind === 'postgres'
            ? postgresSettings(entry)
            : entry.kind === 'mysql'
              ? mysqlSettings(entry)
              : redisSettings(entry)),
          // On a Server, its Swarm settings too; a managed one in a
          // Cloud account has none.
          ...(before?.cloud ? {} : swarmSettings(entry)),
        });
        if (lists.size > 0) {
          const { table, idColumn } = DATABASE_ROWS[entry.kind];
          const [row] = await this.db
            .select({ env: table.env })
            .from(table)
            .where(eq(idColumn, id));
          await service.saveEnvironment(ctx, id, {
            env: keepKeys(row?.env ?? '', new Set(entry.env)),
          });
        }
        written.serviceType = entry.kind;
        // A postgres on RDS or a redis on ElastiCache is never
        // deployed as a container: a change that moves its instance or
        // replication group is a Cloud run.
        const saved = savedOf(input.saved, id);
        if (saved?.cloud) {
          return {
            domain: null,
            // Each cloud's managed database (ADR-0043): RDS or ElastiCache
            // on AWS, Cloud SQL or Memorystore on Google Cloud.
            deploy:
              saved.serviceType === 'postgres' && entry.kind === 'postgres'
                ? await byCloud(cloudOrLegacy(saved.cloud.cloud), {
                    aws: () =>
                      this.changeOnRds('postgres', input, step, entry, saved),
                    gcp: () => this.changeOnCloudSql('postgres', input, step),
                  })()
                : saved.serviceType === 'mysql' && entry.kind === 'mysql'
                  ? // A mysql on RDS or Cloud SQL, as a
                    // postgres there.
                    await byCloud(cloudOrLegacy(saved.cloud.cloud), {
                      aws: () =>
                        this.changeOnRds('mysql', input, step, entry, saved),
                      gcp: () => this.changeOnCloudSql('mysql', input, step),
                    })()
                  : saved.serviceType === 'redis' && entry.kind === 'redis'
                    ? await byCloud(cloudOrLegacy(saved.cloud.cloud), {
                        aws: () =>
                          this.changeRedisOnElastiCache(
                            input,
                            step,
                            entry,
                            saved,
                          ),
                        gcp: () => this.changeRedisOnMemorystore(input, step),
                      })()
                    : null,
          };
        }
        return { domain: null, deploy: { status: 'started' } };
      }
      case 'bucket': {
        // Its description, which nothing running reads, and on a Server its
        // Garage's labels, which only a deploy lays on: planned as
        // native lines only on a Server, so only there is one started.
        const relabelled = step.fields.some(
          (field) => field.native && field.field.startsWith('native.docker.'),
        );
        if (step.fields.length > 0) {
          await this.buckets.update(ctx, id, {
            description: entry.description ?? null,
            ...(relabelled && {
              labelsSwarm: swarmSettings(entry).labelsSwarm ?? null,
            }),
          });
        }
        written.serviceType = 'bucket';
        // An existing bucket: Cloudgate never changes it. On AWS its
        // read was only the lookup; on Google Cloud it may have
        // planned the key account and key Cloudgate makes for it.
        if (step.existing) {
          return {
            domain: null,
            deploy: await this.applyExistingBucketKey(input, step, id),
          };
        }
        // A bucket on S3 read from AWS — its CORS change, or Drift
        // its read found — is put back by a Cloud run writing what was read.
        if (step.cloudRead === undefined) {
          return {
            domain: null,
            deploy: relabelled ? { status: 'started' } : null,
          };
        }
        if (step.cloudRead.status !== 'read') {
          throw new Error(`${step.configName} was not read from AWS`);
        }
        const [row] = await this.db
          .select({ appName: bucket.appName })
          .from(bucket)
          .where(eq(bucket.bucketId, id));
        if (!row) throw new Error(`${step.configName} is gone`);
        // Its `native.aws`, saved before its Cloud run lays it.
        const savedBucket = savedOf(input.saved, id)?.cloud;
        if (savedBucket) {
          await this.saveBucketNativeAws(
            id,
            cloudOrLegacy(savedBucket.cloud),
            entry,
          );
        }
        return {
          domain: null,
          deploy: await this.cloudBuckets.start(
            { bucketId: id, appName: row.appName, configName: step.configName },
            input.environmentId,
            step.cloudRead,
            true,
          ),
        };
      }
      case 'compose':
        // A stack on its own Stack VM, whose Stack VM this change moves
        // (#1368); else its ordinary change.
        return step.stackVm
          ? this.changeStackVm(ctx, input, connections, step, entry, written)
          : this.changeCompose(ctx, input, connections, step, entry, written);
    }
  }

  /**
   * An Existing database its plan's lookup found at a new address:
   * the address is saved here, as its step runs, so the redeploys after it
   * — every one runs after the source's step — build the new Outputs.
   */
  private async saveMovedAddress(
    id: string,
    step: Extract<PlanStep, { action: 'change' }>,
  ): Promise<void> {
    const moved =
      step.cloudRead?.status === 'read'
        ? step.cloudRead.addressMoved
        : undefined;
    if (!moved) return;
    // With the CA its lookup found in place of the saved one, where the
    // cloud reports the instance's own (a Cloud SQL instance).
    await this.db
      .update(existingDatabase)
      .set({
        address: moved.to,
        notFoundAt: null,
        ca: sql`coalesce(${existingDatabase.foundCa}, ${existingDatabase.ca})`,
        foundCa: null,
      })
      .where(
        step.serviceType === 'redis'
          ? eq(existingDatabase.redisId, id)
          : step.serviceType === 'mysql'
            ? eq(existingDatabase.mysqlId, id)
            : eq(existingDatabase.postgresId, id),
      );
  }

  /**
   * A change to an Existing database's entry (ADR-0033): only what
   * Cloudgate keeps of it — its description and its variables — is written.
   * The config's `database`, `user`, `size` and `version` are never applied,
   * and nothing is deployed: Cloudgate never changes the database itself.
   */
  private async changeExisting(
    ctx: PermissionCtx,
    id: string,
    entry: Extract<Described, { kind: 'postgres' | 'mysql' | 'redis' }>,
    lists: ReadonlySet<string>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<{ domain: null; deploy: null }> {
    // A postgres's, a mysql's or a redis's: the same
    // two writes.
    const kind = entry.kind;
    const service = this.databaseService(kind);
    await service.update(ctx, id, {
      description: entry.description ?? null,
    });
    if (lists.size > 0) {
      const { table, idColumn } = DATABASE_ROWS[kind];
      const [row] = await this.db
        .select({ env: table.env })
        .from(table)
        .where(eq(idColumn, id));
      await service.saveEnvironment(ctx, id, {
        env: keepKeys(row?.env ?? '', new Set(entry.env)),
      });
    }
    written.serviceType = kind;
    return { domain: null, deploy: null };
  }

  /**
   * What Cloudgate makes for an Existing database whose lookup planned
   * something: on Google Cloud, a Cloud SQL `postgres`'s or
   * `mysql`'s manual endpoint and private zone, made, or made again
   * for a new address, by a Cloud run into the postgres's own
   * Infrastructure state — a new one, the id its plan read with, on the
   * first Apply. A lookup that planned nothing (every AWS one, which is
   * `data` sources only, and a Google one whose endpoint and zone are as
   * written) runs nothing. Linked Services never wait on it.
   *
   * A Memorystore for Valkey `redis`'s two manual endpoints alike,
   * into the redis's own state. A Service linking it waits for that run
   * (its address is the primary endpoint's), but never for the operator to
   * register the endpoints on the instance.
   */
  private async applyExistingEndpoint(
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'change' }>,
    id: string,
  ): Promise<PlanStepDeploy | null> {
    const read = step.cloudRead;
    if (read?.status !== 'read' || read.raw.length === 0) return null;
    if (step.serviceType === 'redis') {
      const [cache] = await this.db
        .select({ appName: redis.appName })
        .from(redis)
        .where(eq(redis.redisId, id));
      if (!cache) throw new Error(`${step.configName} is gone`);
      const made = await this.states.findForRedis(id);
      if (!made) {
        await this.states.create(
          { redisId: id },
          read.stateId,
          stateProviderOf('gcp'),
        );
      }
      return this.cloudRedis.start(
        { redisId: id, appName: cache.appName, name: step.configName },
        input.environmentId,
        read,
        made !== null,
        'Memorystore',
        `${made ? 'Change' : 'Make'} ${step.configName}'s endpoints to ${step.existing?.identifier ?? 'its existing cache'}`,
      );
    }
    // A postgres's, or a mysql's, on Cloud SQL.
    if (step.serviceType !== 'postgres' && step.serviceType !== 'mysql') {
      return null;
    }
    const kind = step.serviceType;
    const row = await findRdsRow(this.db, kind, id);
    if (!row) throw new Error(`${step.configName} is gone`);
    const state = await findRdsState(this.states, kind, id);
    if (!state) {
      await this.states.create(
        rdsOwnerOf(kind, id),
        read.stateId,
        stateProviderOf('gcp'),
      );
    }
    return this.cloudPostgres.start(
      {
        ...rdsOwnerOf(kind, id),
        appName: row.appName,
        name: step.configName,
      },
      input.environmentId,
      read,
      {
        change: state !== null,
        allowMajorUpgrade: false,
        title: `${state ? 'Change' : 'Make'} ${step.configName}'s endpoint to ${step.existing?.identifier ?? 'its existing database'}`,
      },
    );
  }

  /**
   * What Cloudgate makes for an existing bucket whose lookup planned
   * something: on Google Cloud, the bucket Service's own service
   * account and HMAC key, made — or put back — by a Cloud run into its own
   * Infrastructure state, a new one, the id its plan read with, on the
   * first Apply. A lookup that planned nothing (every AWS one, which is
   * `data` sources only, and a Google one whose key is as written) runs
   * nothing. Linked Services never wait on the operator's grant.
   */
  private async applyExistingBucketKey(
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'change' }>,
    id: string,
  ): Promise<PlanStepDeploy | null> {
    const read = step.cloudRead;
    if (read?.status !== 'read' || read.raw.length === 0) return null;
    const [row] = await this.db
      .select({ appName: bucket.appName })
      .from(bucket)
      .where(eq(bucket.bucketId, id));
    if (!row) throw new Error(`${step.configName} is gone`);
    const state = await this.states.findForBucket(id);
    if (!state) {
      await this.states.create(
        { bucketId: id },
        read.stateId,
        stateProviderOf('gcp'),
      );
    }
    return this.cloudBuckets.start(
      { bucketId: id, appName: row.appName, configName: step.configName },
      input.environmentId,
      read,
      state !== null,
    );
  }

  /**
   * A postgres on RDS after its config fields are saved: its class
   * becomes the size's when the entry has one, or stays Cloudgate's (the
   * one it runs on) when it has none, and the console's settings are
   * recorded as written, so the next plan diffs against them. A step that
   * moves the instance then queues the Cloud run that moves it, with the
   * major upgrade allowed for that run when the plan has one, which Apply
   * confirmed by name before anything ran.
   */
  private async changeOnRds(
    kind: 'postgres' | 'mysql',
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'change' }>,
    entry: Extract<Described, { kind: 'postgres' | 'mysql' }>,
    saved: Extract<SavedService, { serviceType: 'postgres' | 'mysql' }>,
  ): Promise<PlanStepDeploy | null> {
    const row = await findRdsRow(this.db, kind, saved.serviceId);
    if (!row) throw new Error(`${step.configName} is gone`);
    // A class its `native.aws` sets is the one it runs on, saved as
    // the console's, so taken out with no size it stays where it is; with a
    // size, the size decides it again.
    const instanceClass =
      nativeInstanceClassOf(laidAwsBlock(entry)) ??
      (entry.size !== undefined
        ? null
        : (row.instanceClass ??
          rdsClassOf(step.configName, {
            instanceClass: saved.rds?.applied?.instanceClass ?? null,
            cpuLimit: saved.settings.cpuLimit,
            memoryLimit: saved.settings.memoryLimit,
          })));
    // Its `native.aws`: the block, and each console-owned value on
    // the console's column, so one taken out later stays where it is.
    const native = rdsNativeColumns(laidAwsBlock(entry));
    await updateRdsRow(this.db, kind, saved.serviceId, {
      ...native,
      instanceClass,
      rdsApplied: rdsConsoleSettings({ ...row, ...native, instanceClass }),
    });

    const aws = step.cloudRead;
    if (!step.database) return null;
    if (aws?.status !== 'read') {
      throw new Error(`${step.configName} was not read from AWS`);
    }
    return this.cloudPostgres.start(
      {
        ...rdsOwnerOf(kind, saved.serviceId),
        appName: row.appName,
        name: step.configName,
      },
      input.environmentId,
      aws,
      { change: true, allowMajorUpgrade: step.majorUpgrade !== undefined },
    );
  }

  /**
   * A postgres on Cloud SQL after its config fields are saved: the
   * machine the change moves it to is saved as the one it runs on, its
   * backups as the run writes them (and a catch-up's or a point-in-time
   * recovery flip's), and a
   * step that moves the instance queues the Cloud run that moves it, which
   * writes its definition from the row. A mysql's is the same.
   */
  private async changeOnCloudSql(
    kind: CloudSqlEngineName,
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'change' }>,
  ): Promise<PlanStepDeploy | null> {
    const row = await findRdsRow(this.db, kind, step.serviceId);
    if (!row) throw new Error(`${step.configName} is gone`);
    if (!step.cloudSql) return null;
    const read = step.cloudRead;
    if (read?.status !== 'read') {
      throw new Error(`${step.configName} was not read from Google Cloud`);
    }
    // Its `native.gcp`: the block, and a backup count it sets on
    // the Backups tab's column, so one taken out later stays where it is.
    const native =
      step.cloudSql.native !== undefined
        ? cloudSqlNativeColumns(step.cloudSql.native)
        : null;
    // Its backups as this run writes them: a catch-up's, or a
    // point-in-time recovery flip's; one made before backups that
    // this change does not catch up has none written yet.
    const applied = cloudSqlAppliedAfter({ ...row, ...native }, step.cloudSql);
    if (step.cloudSql.tier || applied || native) {
      await updateRdsRow(this.db, kind, step.serviceId, {
        ...native,
        ...(step.cloudSql.tier ? { instanceClass: step.cloudSql.tier.to } : {}),
        ...(applied ? { cloudSqlApplied: applied } : {}),
      });
    }
    return this.cloudPostgres.start(
      {
        ...rdsOwnerOf(kind, rdsIdOf(row)),
        appName: row.appName,
        name: step.configName,
      },
      input.environmentId,
      read,
      {
        change: true,
        allowMajorUpgrade: step.majorUpgrade !== undefined,
        product: 'Cloud SQL',
      },
    );
  }

  /**
   * A redis on Memorystore after its config fields are saved, as a
   * postgres on Cloud SQL's: the node type and engine version the change
   * moves it to are saved as the ones it runs on, and a step that
   * moves the instance queues the
   * Cloud run that moves it in place, which writes its definition from the
   * row. Its high availability and backup retention are
   * recorded as that run writes them, so the next plan diffs the console
   * against them. A major upgrade among them
   * was confirmed by name before anything ran; a downgrade never reaches
   * here (the plan refuses it).
   */
  private async changeRedisOnMemorystore(
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'change' }>,
  ): Promise<PlanStepDeploy | null> {
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, step.serviceId));
    if (!row) throw new Error(`${step.configName} is gone`);
    if (!step.memorystore) return null;
    const read = step.cloudRead;
    if (read?.status !== 'read') {
      throw new Error(`${step.configName} was not read from Google Cloud`);
    }
    // Its `native.gcp`: the block, and a replica or backup count
    // it sets on the console's columns, so one taken out later stays where
    // it is.
    const native =
      step.memorystore.native !== undefined
        ? memorystoreNativeColumns(step.memorystore.native)
        : null;
    const now = { ...row, ...native };
    await this.db
      .update(redis)
      .set({
        ...native,
        ...(step.memorystore.nodeType
          ? { nodeType: step.memorystore.nodeType.to }
          : {}),
        ...(step.memorystore.version
          ? { memorystoreEngineVersion: step.memorystore.version.engineVersion }
          : {}),
        memorystoreApplied: {
          highAvailability: now.memorystoreHighAvailability,
          // Its backup retention as this run writes it, for one
          // made with backups, or one this step catches up; one made before
          // with nothing to catch up has none written yet.
          ...(row.memorystoreApplied?.backupRetentionDays === undefined &&
          !step.memorystore.backupRetentionDays &&
          native?.memorystoreBackupRetentionDays === undefined
            ? {}
            : { backupRetentionDays: now.memorystoreBackupRetentionDays }),
        },
      })
      .where(eq(redis.redisId, row.redisId));
    return this.cloudRedis.start(
      { redisId: row.redisId, appName: row.appName, name: step.configName },
      input.environmentId,
      read,
      true,
      'Memorystore',
    );
  }

  /**
   * A redis on ElastiCache after its config fields are saved, as a
   * postgres on RDS's: its node type becomes the size's when the entry has
   * one, or stays Cloudgate's (the one it runs on) when it has none, and the
   * console's settings are recorded as written, so the next plan diffs
   * against them. A step that moves the replication group then queues the
   * Cloud run that moves it; a major upgrade among them was confirmed by
   * name before anything ran.
   */
  private async changeRedisOnElastiCache(
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'change' }>,
    entry: Extract<Described, { kind: 'redis' }>,
    saved: Extract<SavedService, { serviceType: 'redis' }>,
  ): Promise<PlanStepDeploy | null> {
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, saved.serviceId));
    if (!row) throw new Error(`${step.configName} is gone`);
    // A node type its `native.aws` sets, as a class on RDS.
    const nodeType =
      nativeNodeTypeOf(laidAwsBlock(entry)) ??
      (entry.size !== undefined
        ? null
        : (row.nodeType ??
          elastiCacheNodeTypeOf(step.configName, {
            nodeType: saved.elasticache?.applied?.nodeType ?? null,
            cpuLimit: saved.settings.cpuLimit,
            memoryLimit: saved.settings.memoryLimit,
          })));
    // Its `native.aws`, as a postgres's on RDS.
    const native = elastiCacheNativeColumns(laidAwsBlock(entry));
    await this.db
      .update(redis)
      .set({
        ...native,
        nodeType,
        elasticacheApplied: elastiCacheConsoleSettings({
          ...row,
          ...native,
          nodeType,
        }),
      })
      .where(eq(redis.redisId, row.redisId));

    const aws = step.cloudRead;
    if (!step.cache) return null;
    if (aws?.status !== 'read') {
      throw new Error(`${step.configName} was not read from AWS`);
    }
    return this.cloudRedis.start(
      { redisId: row.redisId, appName: row.appName, name: step.configName },
      input.environmentId,
      aws,
      true,
    );
  }

  /** The Application's variable blobs with only the listed keys left. */
  /**
   * A Template database's values, in its own `env` (ADR-0064): the only
   * list a database entry has. Written over the empty blob its create left.
   */
  private async writeDatabaseVariables(
    input: ApplyInput,
    step: Extract<PlanStep, { action: 'create' }>,
    written: { serviceType: ServiceType | null; serviceId: string | null },
  ): Promise<void> {
    if (!isDatabase(written.serviceType) || written.serviceId === null) return;
    const { env } = templateVariables(input.templateValues, step);
    if (env === undefined) return;
    const { table, idColumn } = DATABASE_ROWS[written.serviceType];
    await this.db
      .update(table)
      .set({ env })
      .where(eq(idColumn, written.serviceId));
  }

  private async keptApplicationVariables(
    applicationId: string,
    entry: ApplicationEntry,
    lists: ReadonlySet<string>,
  ) {
    const [row] = await this.db
      .select({
        env: application.env,
        buildArgs: application.buildArgs,
        buildSecrets: application.buildSecrets,
      })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    const kept: { env?: string; buildArgs?: string; buildSecrets?: string } =
      {};
    if (lists.has('env')) {
      kept.env = keepKeys(row?.env ?? '', new Set(entry.env));
    }
    if (lists.has('build_args')) {
      kept.buildArgs = keepKeys(row?.buildArgs ?? '', new Set(entry.buildArgs));
    }
    if (lists.has('build_secrets')) {
      kept.buildSecrets = keepKeys(
        row?.buildSecrets ?? '',
        new Set(entry.buildSecrets),
      );
    }
    return kept;
  }

  /**
   * An ordinary Deployment, recorded pending and queued. A refusal to queue
   * one (an Application with no source yet) leaves the step applied, since
   * its settings were written, and says why it was not deployed. A build
   * the plan holds for this Application is released instead, and is
   * the step's Deployment.
   */
  private async deployApplication(
    ctx: PermissionCtx,
    applicationId: string,
    heldBuilds: ReadonlyMap<string, string> = new Map(),
  ): Promise<PlanStepDeploy> {
    try {
      const held = heldBuilds.get(applicationId);
      const released = held ? await this.deployments.releaseHeld(held) : null;
      if (released) {
        return { status: 'queued', deploymentId: released.deploymentId };
      }
      const queued = await this.deployments.deploy(ctx, applicationId, {
        title: 'Plan applied',
        description: 'Queued by applying the Project config',
      });
      return { status: 'queued', deploymentId: queued.deploymentId };
    } catch (error) {
      return { status: 'not-deployed', message: describeError(error) };
    }
  }

  /**
   * The `native.aws` an Application's entry applies on ECS, or on
   * S3 and CloudFront for a static site, as written, `null` when it
   * has none: what its deploys, Cloud runs and reads for Drift lay, and
   * what the next plan compares the entry's against. Off AWS, or on a kind
   * that lays none, it is not the Environment's block, so nothing is saved.
   *
   * A task `cpu` or `memory` it sets on an entry with no `size` is
   * written to the Service's caps too, which are then Cloudgate's and the
   * console's: taken out later, the task stays at the pair it runs at.
   */
  private async saveNativeAws(
    applicationId: string,
    cloud: CloudKind,
    entry: Described,
  ): Promise<void> {
    if (!laysNativeAwsOn(cloud, entry.kind)) return;
    const block = laidAwsBlock(entry) ?? null;
    let caps: ReturnType<typeof capsWithNativeFargate> = null;
    if (entry.size === undefined && block) {
      const [row] = await this.db
        .select({
          cpuLimit: application.cpuLimit,
          memoryLimit: application.memoryLimit,
        })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      const sizing = fargateSize(
        applicationId,
        row ? savedSize(row.cpuLimit, row.memoryLimit) : undefined,
      );
      if (sizing.ok) caps = capsWithNativeFargate(sizing.pair, block);
    }
    await this.db
      .update(application)
      .set({ nativeAws: block, ...(caps ?? {}) })
      .where(eq(application.applicationId, applicationId));
  }

  /**
   * The `native.aws` a bucket's entry applies on S3, as written,
   * `null` when it has none: what its Cloud runs and reads for Drift lay,
   * and what the next plan compares the entry's against. Off AWS nothing
   * is saved.
   */
  private async saveBucketNativeAws(
    bucketId: string,
    cloud: CloudKind,
    entry: Described,
  ): Promise<void> {
    if (!laysNativeAwsOn(cloud, entry.kind)) return;
    await this.db
      .update(bucket)
      .set({ nativeAws: laidAwsBlock(entry) ?? null })
      .where(eq(bucket.bucketId, bucketId));
  }

  /**
   * The `native.gcp` an Application's entry applies on Cloud Run,
   * as {@link saveNativeAws} saves `native.aws` on ECS.
   *
   * A container `cpu` or `memory` limit it sets on an entry with no `size`
   * is written to the Service's caps too, as on Fargate:
   * taken out later, it stays at the pair it runs at.
   */
  private async saveNativeGcp(
    applicationId: string,
    cloud: CloudKind,
    entry: Described,
  ): Promise<void> {
    if (!laysNativeGcpOn(cloud, entry.kind)) return;
    const block = laidGcpBlock(entry) ?? null;
    let caps: ReturnType<typeof capsWithNativeCloudRun> = null;
    if (entry.size === undefined && block) {
      const [row] = await this.db
        .select({
          cpuLimit: application.cpuLimit,
          memoryLimit: application.memoryLimit,
        })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      const sizing = cloudRunSize(
        applicationId,
        row ? savedSize(row.cpuLimit, row.memoryLimit) : undefined,
      );
      if (sizing.ok) caps = capsWithNativeCloudRun(sizing.pair, block);
    }
    await this.db
      .update(application)
      .set({ nativeGcp: block, ...(caps ?? {}) })
      .where(eq(application.applicationId, applicationId));
  }

  /**
   * The plan that last wrote this Service's config-owned fields, and,
   * once its step applied, the links its entry applied: the next
   * plan diffs against them, and each deploy fills them in. A step that
   * failed keeps the links it had.
   */
  private async recordPlan(
    written: { serviceType: ServiceType | null; serviceId: string | null },
    planId: string,
    links?: ConfigLinks,
  ) {
    const { serviceType, serviceId } = written;
    if (!serviceId) return;
    const set = {
      configPlanId: planId,
      ...(links === undefined ? {} : { configLinks: links }),
    };
    switch (serviceType) {
      case 'application':
        await this.db
          .update(application)
          .set(set)
          .where(eq(application.applicationId, serviceId));
        return;
      case 'postgres':
      case 'mysql':
      case 'redis': {
        const { table, idColumn } = DATABASE_ROWS[serviceType];
        await this.db.update(table).set(set).where(eq(idColumn, serviceId));
        return;
      }
      // A bucket links nothing: it reads no variables.
      case 'bucket':
        await this.db
          .update(bucket)
          .set({ configPlanId: planId })
          .where(eq(bucket.bucketId, serviceId));
        return;
      default:
        return;
    }
  }
}

/**
 * The steps in the order they run: the plan's, with a kind change's create
 * moved after its destroy where a plan stored before links ordered the Apply listed it among
 * the creates.
 */
function replacementsAfterDestroys(
  steps: readonly PlanStep[],
): readonly PlanStep[] {
  const destroyAt = new Map(
    steps.flatMap((step, at) =>
      step.action === 'destroy' ? [[step.configName, at] as const] : [],
    ),
  );
  const early = (step: PlanStep, at: number) =>
    step.action === 'create' && (destroyAt.get(step.configName) ?? -1) > at;
  const ordered: PlanStep[] = [];
  steps.forEach((step, at) => {
    if (early(step, at)) return;
    ordered.push(step);
    if (step.action !== 'destroy') return;
    const moved = steps.find(
      (one, oneAt) =>
        one.action === 'create' &&
        one.configName === step.configName &&
        early(one, oneAt),
    );
    if (moved) ordered.push(moved);
  });
  return ordered;
}

/** A step's result with nothing written yet. */
export function emptyResult(
  configName: string,
  action: PlanStepResult['action'],
): PlanStepResult {
  return {
    configName,
    action,
    status: 'failed',
    message: null,
    serviceType: null,
    serviceId: null,
    domain: null,
    deploy: null,
    leftovers: null,
  };
}

function savedOf(saved: readonly SavedService[], serviceId: string) {
  return saved.find((found) => found.serviceId === serviceId);
}

/**
 * A plan-created Application's connection, its branch the Environment's
 * Config branch when it builds from the config's own repository (spec "A
 * plan-created Service"); otherwise the repository's default branch,
 * as resolved. Either way the branch is Cloudgate's afterwards.
 */
function onConfigBranch(
  connection: ResolvedConnection | null,
  source: Source | undefined,
  configRepository: ApplyInput['configRepository'],
): ResolvedConnection | null {
  if (
    !connection ||
    !configRepository ||
    !isHosted(source) ||
    source.sourceType !== configRepository.providerType ||
    source.repository.toLowerCase() !==
      configRepository.repository.toLowerCase()
  ) {
    return connection;
  }
  return { ...connection, defaultBranch: configRepository.branch };
}

/** A 409 naming every place the plan is refused. */
export function refusedPlan(
  refusals: readonly PlanRefusal[],
): ConflictException {
  return new ConflictException({
    message: `The plan is refused: ${refusals.map((refusal) => refusal.message).join('; ')}`,
    code: PLAN_REFUSED_CODE,
  });
}
