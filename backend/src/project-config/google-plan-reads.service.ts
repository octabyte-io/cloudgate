import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { ApplicationsService } from '../applications/applications.service';

import { makeDefaultCertificate } from '../cloud-accounts/definitions/default-certificate';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../cloud-accounts/definitions/default-certificate';
import { STAND_IN_IMAGE_TAG } from '../cloud-accounts/aws/definitions/stand-ins';
import type { TofuShowJson } from '../cloud-accounts/aws/plan-reader/tofu-show.types';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import type { GcpCloudAccount } from '../cloud-accounts/cloud-provider';
import type { GoogleCredential, TofuShow } from '../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import { gcpBucketDefinition } from '../cloud-accounts/gcp/definitions/bucket-definition';
import type { GcpBucketKeys } from '../cloud-accounts/gcp/definitions/bucket-definition';
import { googleKeyLayout } from '../buckets/google-key-layout';
import { cloudSqlDefinition } from '../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { CLOUD_SQL_ENGINES } from '../cloud-accounts/gcp/definitions/cloud-sql-engines';
import type { CloudSqlEngineName } from '../cloud-accounts/gcp/definitions/cloud-sql-engines';
import { existingCloudSqlDefinition } from '../cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { existingValkeyDefinition } from '../cloud-accounts/gcp/definitions/existing-valkey-definition';
import { memorystoreDefinition } from '../cloud-accounts/gcp/definitions/memorystore-definition';
import {
  GOOGLE_STACK_VM_INSTANCE_ADDRESS,
  googleStackVmDefinition,
} from '../cloud-accounts/gcp/definitions/stack-vm-definition';
import { stackVmPinsOn } from '../cloud-accounts/definitions/stack-vm-pins';
import {
  dataDiskRefusal,
  stackVmSettingsAfter,
  stackVmWritten,
} from '../cloud-accounts/definitions/stack-vm-written';
import {
  CLOUD_RUN_COPIES,
  cloudRunSize,
} from '../cloud-accounts/gcp/definitions/cloud-run-size';
import {
  networkNamePrefix,
  serviceName,
} from '../cloud-accounts/gcp/definitions/names';
import { networkDefinition } from '../cloud-accounts/gcp/definitions/network-definition';
import { gcpStaticDefinition } from '../cloud-accounts/gcp/definitions/static-definition';
import type { GcpNetworkDomain } from '../cloud-accounts/gcp/definitions/network-definition';
import { linksAfter } from '../cloud-accounts/definitions/network-links';
import type { NetworkLinkKind } from '../cloud-accounts/definitions/network-links';
import {
  cloudRunRoutingOf,
  cloudRunServiceDefinition,
} from '../cloud-accounts/gcp/definitions/cloud-run-definition';
import type { CloudRunEntry } from '../cloud-accounts/gcp/definitions/cloud-run-definition';
import {
  judgeExistingCloudSql,
  parseConnectionName,
} from '../cloud-accounts/gcp/plan-reader/existing-cloud-sql';
import type { CloudSqlLookup } from '../cloud-accounts/gcp/plan-reader/existing-cloud-sql';
import {
  judgeExistingValkey,
  VALKEY_ENDPOINTS_COST,
} from '../cloud-accounts/gcp/plan-reader/existing-valkey';
import { judgeExistingGoogleBucket } from '../cloud-accounts/gcp/plan-reader/existing-bucket';
import type { GoogleBucketLookup } from '../cloud-accounts/gcp/plan-reader/existing-bucket';
import { checkGoogleBucketAccess } from '../buckets/google-bucket-access';
import type { GoogleExistingBucket } from './existing-bucket-reads';
import { readGooglePlan } from '../cloud-accounts/gcp/plan-reader/read-plan';
import type { GooglePlanReadContext } from '../cloud-accounts/gcp/plan-reader/read-plan';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
  PERMISSION_DENIED,
} from '../cloud-accounts/google-cloud.port';
import type {
  FoundByName,
  GoogleAccessToken,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../common/describe-error';
import { OBJECT_STORAGE } from '../object-storage/object-storage.port';
import type { ObjectStoragePort } from '../object-storage/object-storage.port';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  bucket,
  compose,
  environmentNetwork,
  existingDatabase,
  NEW_SERVICE_REPLICAS,
  redis,
} from '../db/schema';
import {
  findRdsRow,
  findRdsState,
  rdsIdOf,
  rdsKindOf,
} from '../databases/common/rds-rows';
import type { CloudRunControl } from '../deployment-queue/cloud-run-job.types';
import { getEnvironmentVariablesObject } from '../docker/docker.utils';
import { webEntryOf } from './applier/cloud-deploy-steps';
import { networkDomains } from './applier/google-network-domains';
import { googleStackVmPorts } from './applier/stack-vm-domain-pieces';
import { liveImageOf } from './applier/live-image';
import {
  googleNetworkNames,
  cloudSqlAppliedAfter,
  savedCloudSqlDefinition,
} from './cloud-sql-places';
import { savedMemorystoreDefinition } from './memorystore-places';
import { nativeGcpReplaceRefusals } from '../native/gcp-lay';
import type { NativeGcpBlock } from '../native/gcp-native';
import { lookedUpAddress, noteFound } from './existing-database-address';
import { readEndpointStatus } from './existing-endpoint-status';
import {
  lookUpValkey,
  saveRegistration,
  WAITING_FOR_REGISTRATION,
} from './existing-valkey-status';
import type { CloudStepReader, StackVmCreate } from './cloud-step-reader';
import { wiredEnv } from './outputs';
import { cloudStepName } from './planner/cloud-steps';
import type { CloudRead, PlanStep } from './planner/plan.types';
import type { WebEntry } from './project-config.types';
import { InstanceMode } from '../instance-mode/instance-mode.service';

type Create = Extract<PlanStep, { action: 'create' }>;
type Change = Extract<PlanStep, { action: 'change' }>;
type NetworkStep = Extract<
  PlanStep,
  { action: 'network-create' | 'network-change' }
>;
type CloudRunCreate = Create & { readonly cloud: NonNullable<Create['cloud']> };
/**
 * A `web`'s, a Worker's, a Private web service's or a Cron
 * service's change: one Cloud Run builder writes all four.
 */
type CloudRunChange = Change & {
  readonly kind: 'web' | 'worker' | 'web-private' | 'cron';
};

/**
 * The kinds read as a Cloud Run resource of their own, by the one builder
 * which of them is a service, which a worker pool and which a job
 * is `cloudRunResourceOf`'s.
 */
const CLOUD_RUN_BUILDER_KINDS: ReadonlySet<string> = new Set<
  CloudRunChange['kind']
>(['web', 'worker', 'web-private', 'cron']);
type CloudSqlCreate = Create & {
  readonly cloudSql: NonNullable<Create['cloudSql']>;
};
type CloudSqlChange = Change & {
  readonly cloudSql: NonNullable<Change['cloudSql']>;
};
type MemorystoreCreate = Create & {
  readonly memorystore: NonNullable<Create['memorystore']>;
};
type MemorystoreChange = Change & {
  readonly memorystore: NonNullable<Change['memorystore']>;
};
type StaticCreate = Create & { readonly kind: 'static' };
type StaticChange = Change & { readonly kind: 'static' };

/** Where a Google read plans, and what it signs in with. */
interface GooglePlanning {
  readonly environmentId: string;
  readonly region: string;
  readonly account: GcpCloudAccount;
  readonly credential: GoogleCredential;
  readonly token: GoogleAccessToken;
}

/** What the caller knows of the step beyond it. */
export interface GoogleReadOptions {
  /** The ids a read made again by its Apply keeps from the plan's own. */
  readonly kept?: { readonly stateId?: string; readonly serviceId?: string };
  /** The state a network create that did not finish left, which its Apply finishes. */
  readonly unfinishedNetworkState?: string | null;
  /** The kind of each Service the same plan creates, by Config name: a wired variable's stand-in reads it. */
  readonly creates?: Readonly<Record<string, string>>;
}

/** What one step's read is, or `null` for a step Google is not read for yet. */
type Readable =
  | { readonly kind: 'network'; readonly step: NetworkStep }
  | { readonly kind: 'cloud-run'; readonly step: CloudRunCreate }
  | { readonly kind: 'cloud-run-change'; readonly step: CloudRunChange }
  | { readonly kind: 'cloud-sql'; readonly step: CloudSqlCreate }
  | { readonly kind: 'cloud-sql-change'; readonly step: CloudSqlChange }
  | { readonly kind: 'memorystore'; readonly step: MemorystoreCreate }
  | { readonly kind: 'memorystore-change'; readonly step: MemorystoreChange }
  | { readonly kind: 'bucket'; readonly step: Create | Change }
  | { readonly kind: 'static'; readonly step: StaticCreate }
  | { readonly kind: 'static-change'; readonly step: StaticChange }
  | { readonly kind: 'stack-vm'; readonly step: StackVmCreate }
  | { readonly kind: 'stack-vm-change'; readonly step: StackVmChangeStep };

/** A change to a Compose stack's Stack VM, or its read for Drift (#1368). */
type StackVmChangeStep = Change & {
  readonly stackVm: NonNullable<Change['stackVm']>;
};

function readableOf(step: PlanStep): Readable | null {
  if (step.action === 'network-create' || step.action === 'network-change') {
    return { kind: 'network', step };
  }
  // A `web` on Cloud Run, a Worker's worker pool, a Private web
  // service's internal-only service, or a Cron service's job.
  if (
    step.action === 'create' &&
    CLOUD_RUN_BUILDER_KINDS.has(step.kind) &&
    step.cloud
  ) {
    return { kind: 'cloud-run', step: step as CloudRunCreate };
  }
  // A bucket on Cloud Storage: its create, or its CORS change or
  // Drift read.
  if (
    (step.action === 'create' && step.kind === 'bucket') ||
    (step.action === 'change' && step.serviceType === 'bucket')
  ) {
    return { kind: 'bucket', step };
  }
  // A Compose stack's Stack VM (ADR-0070).
  if (step.action === 'create' && step.stackVm) {
    return { kind: 'stack-vm', step: step as StackVmCreate };
  }
  if (step.action === 'change' && step.stackVm) {
    return { kind: 'stack-vm-change', step: step as StackVmChangeStep };
  }
  if (step.action === 'create' && step.cloudSql) {
    return { kind: 'cloud-sql', step: step as CloudSqlCreate };
  }
  if (step.action === 'change' && step.cloudSql) {
    return { kind: 'cloud-sql-change', step: step as CloudSqlChange };
  }
  if (step.action === 'create' && step.memorystore) {
    return { kind: 'memorystore', step: step as MemorystoreCreate };
  }
  if (step.action === 'change' && step.memorystore) {
    return { kind: 'memorystore-change', step: step as MemorystoreChange };
  }
  if (
    step.action === 'change' &&
    step.serviceType === 'application' &&
    CLOUD_RUN_BUILDER_KINDS.has(step.kind)
  ) {
    return { kind: 'cloud-run-change', step: step as CloudRunChange };
  }
  // A static site on Cloud Storage + Cloud CDN.
  if (step.action === 'create' && step.kind === 'static' && step.site) {
    return { kind: 'static', step: step as StaticCreate };
  }
  if (
    step.action === 'change' &&
    step.serviceType === 'application' &&
    step.kind === 'static'
  ) {
    return { kind: 'static-change', step: step as StaticChange };
  }
  return null;
}

/**
 * A plan step read from Google Cloud (the Google Cloud spec, "Plan behaviour"): the
 * Google half of {@link CloudPlanReads}, which picks it by the Cloud
 * account's cloud (ADR-0043), as it picks `AwsPlanReads` for an AWS one, and runs this in the Cloud run pool as it runs an AWS
 * read. Slice 3's behaviour, Google's pieces:
 *
 * - **A 2-hour proof per read** (S16), inside the credential configuration
 *   the run's provider reads from the run's own folder, gone with it; a
 *   refusal fails the read before `tofu`, naming the Cloud account.
 * - **The definition** the generator makes, with stand-in network names
 *   while the Environment network is not made yet, and the size's Cloud Run
 *   pair (S3), Cloud SQL machine or Memorystore node type;
 * - **a plan-only Cloud run** through the shared runner, against a new
 *   state for a create, or the one a made network or instance has;
 * - **a search by name** over the Google client port for each kind the plan
 *   creates, by the state's fixed name prefix (S4): what the
 *   reader adopts or notes as "found in Google Cloud, in no state".
 *
 * The network is read with the private link it holds and the kinds its
 * step adds, so the first plan that creates a Cloud SQL or a
 * Memorystore instance shows that kind's link pieces as the network's own
 * creates.
 *
 * **What exists is read from its own state, for Drift** (copying AWS):
 * a made `web` on its live image and a made network with
 * every Domain it holds, each written as its next run would write it, so
 * what the plan shows beyond the config's change is a hand change ("will be
 * put back"), a hand deletion ("will be made again") or a thing its state
 * lost, adopted by name.
 *
 * Every refusal is the step's `failed` reason, an API that is off naming the
 * API and the setup step that turns it on. A `web`, a Worker, a
 * Private web service, a Cron service, a postgres on Cloud SQL
 * a redis on Memorystore, a bucket on Cloud Storage,
 * a static site on Cloud Storage + Cloud CDN, a Compose stack's Stack VM
 * and the network read Google; any other step fails, naming Google Cloud.
 */
@Injectable()
export class GooglePlanReads implements CloudStepReader<GcpCloudAccount> {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly states: InfrastructureStatesService,
    private readonly applications: ApplicationsService,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    private readonly instanceMode: InstanceMode,
  ) {}

  async read(
    account: GcpCloudAccount,
    place: { readonly environmentId: string; readonly region: string },
    step: PlanStep,
    control: CloudRunControl,
    options: GoogleReadOptions = {},
  ): Promise<CloudRead> {
    const readable = readableOf(step);
    if (!readable) {
      return failed(
        `Cloud account ${account.name} is a Google Cloud project, and reading ${cloudStepName(step)} there is not available on Google Cloud yet`,
      );
    }
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return failed(session.refusal);
    const planning: GooglePlanning = {
      ...place,
      account,
      credential: session.credential,
      token: session.token,
    };
    switch (readable.kind) {
      case 'network':
        return this.readNetwork(planning, readable.step, control, options);
      case 'cloud-run':
        return this.readCreate(planning, readable.step, control, options);
      case 'cloud-run-change':
        return this.readChange(planning, readable.step, control, options);
      case 'cloud-sql':
        return this.readCloudSql(planning, readable.step, control, options);
      case 'cloud-sql-change':
        return this.readCloudSqlChange(planning, readable.step, control);
      case 'memorystore':
        return this.readMemorystore(planning, readable.step, control, options);
      case 'memorystore-change':
        return this.readMemorystoreChange(planning, readable.step, control);
      case 'bucket':
        return this.readBucket(planning, readable.step, control, options);
      case 'static':
      case 'static-change':
        return this.readStatic(planning, readable.step, control, options);
      case 'stack-vm':
        return this.readStackVm(planning, readable.step, control, options);
      case 'stack-vm-change':
        return this.readStackVmChange(planning, readable.step, control);
    }
  }

  /**
   * The Environment network: a create against a new state (or the one an
   * unfinished create left), or a made one against its own, with the
   * private link it holds and the kinds its step adds and every
   * Domain on it as the database holds them, as its run
   * writes them, so a Domain is never read as one to take off.
   */
  private async readNetwork(
    planning: GooglePlanning,
    step: NetworkStep,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    const { account, environmentId, region } = planning;
    let existing: string | null;
    let held: readonly NetworkLinkKind[] = [];
    let domains: GcpNetworkDomain[] = [];
    if (step.action === 'network-change') {
      const [row] = await this.db
        .select({ privateLinks: environmentNetwork.privateLinks })
        .from(environmentNetwork)
        .where(
          eq(
            environmentNetwork.environmentNetworkId,
            step.environmentNetworkId,
          ),
        );
      held = row?.privateLinks ?? [];
      domains = await networkDomains(this.db, {
        environmentId,
        cloudAccountId: account.cloudAccountId,
        region,
      });
      existing =
        (await this.states.findForNetwork(step.environmentNetworkId))
          ?.infrastructureStateId ?? null;
      if (existing === null) {
        return failed(`The ${cloudStepName(step)} has no Infrastructure state`);
      }
    } else {
      existing = options.unfinishedNetworkState ?? null;
    }
    const stateId = existing ?? nanoid();
    const certificate = makeDefaultCertificate();
    return this.plan(planning, {
      existing: existing !== null,
      stateId,
      definition: networkDefinition({
        cloudAccountId: account.cloudAccountId,
        projectId: account.cloudId,
        region,
        environmentId,
        stateId,
        domains,
        privateLinks: linksAfter(held, step),
        // A hosted cloud build's source bucket: the Hosted
        // instance's cloud Services build in Cloud Build in this project.
        cloudBuilds: this.instanceMode.isHosted,
      }),
      variables: {
        [DEFAULT_CERTIFICATE_VARIABLES.certificate]: certificate.certificatePem,
        [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
      },
      namePrefix: networkNamePrefix(environmentId),
      context: {},
      ids: {},
      control,
    });
  }

  /**
   * A `web` a plan creates on Cloud Run, against a new state, at its size's
   * Cloud Run pair and the copy range a create writes (S10). It has no
   * typed values yet: they are set once it exists and reach Google with a
   * deploy. Its wired variables are its config's (ADR-0031), each a Secret
   * Manager secret in the plan (S1), at a stand-in value while its source
   * is not made, as on AWS.
   */
  private async readCreate(
    planning: GooglePlanning,
    step: CloudRunCreate,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    const { service } = step.cloud;
    const sizing = cloudRunSize(step.configName, service.size ?? undefined);
    if (!sizing.ok) return failed(sizing.refusal.message);
    const stateId = options.kept?.stateId ?? nanoid();
    const serviceId = options.kept?.serviceId ?? nanoid();
    const network = await this.networkNames(planning);
    const values = await wiredEnv(
      this.db,
      planning.environmentId,
      step.cloud.links,
      {
        standIns: {
          region: planning.region,
          cloud: 'gcp',
          kinds: options.creates,
        },
      },
    );
    const generated = cloudRunServiceDefinition({
      configName: step.configName,
      entry: entryOf(service),
      // A `web` behind the load balancer, a Private web service internal-only
      // a Worker's worker pool at the count a new Service's row
      // starts at, which its first deploy writes, a Cron service's
      // job.
      routing: cloudRunRoutingOf(step.kind, service.port, NEW_SERVICE_REPLICAS),
      service: { serviceId, copies: CLOUD_RUN_COPIES },
      cloudAccountId: planning.account.cloudAccountId,
      projectId: planning.account.cloudId,
      region: planning.region,
      environmentId: planning.environmentId,
      stateId,
      network: network.names,
      pair: sizing.pair,
      imageTag: STAND_IN_IMAGE_TAG,
      variables: values,
      // Its entry's `native.gcp`, laid as its deploy will lay it.
      native: step.cloud.nativeGcp,
    });
    if (!generated.ok) return failed(generated.refusal.message);
    return this.plan(planning, {
      existing: false,
      stateId,
      definition: generated.definition,
      variables: generated.variables,
      namePrefix: serviceName(serviceId),
      context: {
        serviceName: step.configName,
        ...(step.cloud.size.name === null
          ? {}
          : { sizeName: step.cloud.size.name }),
        variableNames: Object.keys(values).filter((name) => values[name]),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId },
      control,
    });
  }

  /**
   * A `web` that is on Cloud Run, read from its own state: its definition as
   * its next deploy writes it — the config the
   * plan gives it or the one it has, its copy range, its typed and wired
   * variables — on its live image, so a plan that changes nothing of its
   * config reads only Drift, and its Apply puts it back on that image. Stop's
   * scaling, Reload's label and the copy range Google holds are the
   * definition's to ignore (S9), so they never read as a change.
   */
  private async readChange(
    planning: GooglePlanning,
    step: CloudRunChange,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    const app = await this.applications.findDeployable(step.serviceId);
    const state = await this.states.findForApplication(step.serviceId);
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const entry = step.cloud ? entryOf(step.cloud.service) : webEntryOf(app);
    const port = step.cloud ? step.cloud.service.port : app.port;
    const sizing = cloudRunSize(step.configName, entry.size);
    if (!sizing.ok) return failed(sizing.refusal.message);
    const network = await this.networkNames(planning);
    const live = await liveImageOf(this.db, step.serviceId);
    // The links the plan gives it, or the ones it has (ADR-0031).
    const links = step.cloud ? step.cloud.links : app.configLinks;
    const values = {
      ...getEnvironmentVariablesObject(
        app.env,
        app.environment.project.env,
        app.environment.env,
      ),
      ...(await wiredEnv(this.db, planning.environmentId, links, {
        standIns: {
          region: planning.region,
          cloud: 'gcp',
          kinds: options.creates,
        },
      })),
    };
    const generated = cloudRunServiceDefinition({
      configName: step.configName,
      entry,
      // Routed by the kind it runs as, as its deploy writes it.
      routing: cloudRunRoutingOf(app.configKind, port, app.replicas),
      service: {
        serviceId: step.serviceId,
        copies: {
          min: app.minCopies ?? CLOUD_RUN_COPIES.min,
          max: app.maxCopies ?? CLOUD_RUN_COPIES.max,
        },
      },
      cloudAccountId: planning.account.cloudAccountId,
      projectId: planning.account.cloudId,
      region: planning.region,
      environmentId: planning.environmentId,
      stateId: state.infrastructureStateId,
      network: network.names,
      pair: sizing.pair,
      imageTag: live?.tag ?? STAND_IN_IMAGE_TAG,
      variables: values,
      // The `native.gcp` the plan gives it, or the one its last Apply laid
      // so its cloud lines show the native values, and a hand
      // change to one reads as Drift against the merged definition.
      native: step.cloud ? step.cloud.nativeGcp : app.nativeGcp,
    });
    if (!generated.ok) return failed(generated.refusal.message);
    const read = await this.plan(planning, {
      existing: true,
      stateId: state.infrastructureStateId,
      definition: generated.definition,
      variables: generated.variables,
      namePrefix: serviceName(step.serviceId),
      context: {
        serviceName: step.configName,
        ...(step.cloud?.size.name ? { sizeName: step.cloud.size.name } : {}),
        variableNames: Object.keys(values).filter((name) => values[name]),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId: step.serviceId },
      control,
    });
    return read.status === 'read'
      ? { ...read, liveImage: live?.tag ?? null }
      : read;
  }

  /**
   * A `postgres` a plan creates on Cloud SQL, against a new state:
   * the planner's machine and version, the config's user and database, and
   * a throwaway password, since the real one is made by the create path; it
   * is a `sensitive` variable, which no plan line shows. Read again by an
   * Apply, it keeps the ids it was first read with. A `mysql`'s is
   * the same read with MySQL's engine, and a throwaway `root` password too,
   * made only for an engine whose `root` gets one.
   */
  private async readCloudSql(
    planning: GooglePlanning,
    step: CloudSqlCreate,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    const stateId = options.kept?.stateId ?? nanoid();
    const serviceId = options.kept?.serviceId ?? nanoid();
    const network = await this.networkNames(planning);
    const { cloudSql } = step;
    const engine = step.kind === 'mysql' ? 'mysql' : 'postgres';
    const generated = cloudSqlDefinition({
      engine,
      serviceId,
      cloudAccountId: planning.account.cloudAccountId,
      projectId: planning.account.cloudId,
      region: planning.region,
      environmentId: planning.environmentId,
      stateId,
      network: network.names,
      tier: cloudSql.size.tier,
      databaseVersion: cloudSql.version.databaseVersion,
      login: {
        ...cloudSql.login,
        password: randomBytes(24).toString('hex'),
        ...(CLOUD_SQL_ENGINES[engine].rootPassword
          ? { rootPassword: randomBytes(24).toString('hex') }
          : {}),
      },
      backupRetentionDays: cloudSql.backupRetentionDays,
      pointInTimeRecovery: cloudSql.pointInTimeRecovery,
      // Its entry's `native.gcp`, laid as its Cloud run will lay it.
      native: cloudSql.native,
    });
    return this.plan(planning, {
      existing: false,
      stateId,
      definition: generated.definition,
      variables: generated.variables,
      namePrefix: serviceName(serviceId),
      context: {
        serviceName: step.configName,
        ...(cloudSql.size.name === null
          ? {}
          : { sizeName: cloudSql.size.name }),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId },
      control,
    });
  }

  /**
   * A change to a postgres on Cloud SQL read from its own state:
   * its definition as the Apply's Cloud run will write it — the machine and
   * version the change moves to, its login as saved — planned against the
   * state that holds the instance, so the lines are what Google will do.
   */
  private async readCloudSqlChange(
    planning: GooglePlanning,
    step: CloudSqlChange,
    control: CloudRunControl,
  ): Promise<CloudRead> {
    // A postgres's or a mysql's, by the kind the step changes.
    const row = await findRdsRow(
      this.db,
      step.serviceType === 'mysql' ? 'mysql' : 'postgres',
      step.serviceId,
    );
    if (!row) return failed(`${step.configName} is gone`);
    const state = await findRdsState(this.states, rdsKindOf(row), rdsIdOf(row));
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await this.networkNames(planning);
    const { cloudSql } = step;
    const written = savedCloudSqlDefinition({
      row,
      account: planning.account,
      stateId: state.infrastructureStateId,
      network: network.names,
      ...(cloudSql.tier ? { tier: cloudSql.tier.to } : {}),
      ...(cloudSql.version
        ? { databaseVersion: cloudSql.version.databaseVersion }
        : {}),
      // A catch-up's backups, or a point-in-time recovery flip, as its
      // Apply will save them.
      applied: cloudSqlAppliedAfter(row, cloudSql),
      // The `native.gcp` the change lays, before its Apply saves it.
      ...(cloudSql.native !== undefined ? { native: cloudSql.native } : {}),
    });
    if (!written.ok) return failed(written.message);
    const read = await this.plan(planning, {
      existing: true,
      stateId: state.infrastructureStateId,
      definition: written.generated.definition,
      variables: written.generated.variables,
      namePrefix: serviceName(rdsIdOf(row)),
      context: {
        serviceName: step.configName,
        ...(cloudSql.tier?.sizeName
          ? { sizeName: cloudSql.tier.sizeName }
          : {}),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId: rdsIdOf(row) },
      control,
    });
    return refusingNativeReplace(step.configName, cloudSql.native, read);
  }

  /**
   * A `redis` a plan creates on Memorystore, against a new state:
   * the planner's node type and Valkey version. Nothing secret is in it:
   * Google makes the token, read after the create. Read again by an Apply,
   * it keeps the ids it was first read with.
   */
  private async readMemorystore(
    planning: GooglePlanning,
    step: MemorystoreCreate,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    const stateId = options.kept?.stateId ?? nanoid();
    const serviceId = options.kept?.serviceId ?? nanoid();
    const network = await this.networkNames(planning);
    const { memorystore } = step;
    return this.plan(planning, {
      existing: false,
      stateId,
      definition: memorystoreDefinition({
        serviceId,
        cloudAccountId: planning.account.cloudAccountId,
        projectId: planning.account.cloudId,
        region: planning.region,
        environmentId: planning.environmentId,
        stateId,
        network: network.names,
        nodeType: memorystore.size.nodeType,
        engineVersion: memorystore.version.engineVersion,
        // One node, unless its `native.gcp` sets a replica: high
        // availability is otherwise turned on on a made cache.
        highAvailability: memorystore.nodes > 1,
        backupRetentionDays: memorystore.backupRetentionDays,
        // Its entry's `native.gcp`, laid as its Cloud run will lay it.
        native: memorystore.native,
      }),
      variables: {},
      namePrefix: serviceName(serviceId),
      context: {
        serviceName: step.configName,
        ...(memorystore.size.name === null
          ? {}
          : { sizeName: memorystore.size.name }),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId },
      control,
    });
  }

  /**
   * A Compose stack's Stack VM create (ADR-0070, #1362), against a new
   * state: its definition written as its Apply will write it, on the
   * Environment network's names, or their stand-ins while the same plan
   * makes the network, with its entry's `native.gcp` laid. A new Stack VM
   * reads Ubuntu 24.04's current image; the Apply records the one it was
   * made from. Read again by an Apply, it keeps the ids it was first read
   * with.
   */
  private async readStackVm(
    planning: GooglePlanning,
    step: StackVmCreate,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    const stateId = options.kept?.stateId ?? nanoid();
    const serviceId =
      options.kept?.serviceId ??
      // A console-made stack's Stack VM is made for the row it has (#1372).
      step.stackVm.consoleStackId ??
      nanoid();
    const network = await this.networkNames(planning);
    const { stackVm } = step;
    return this.plan(planning, {
      existing: false,
      stateId,
      definition: googleStackVmDefinition({
        configName: step.configName,
        serviceId,
        cloudAccountId: planning.account.cloudAccountId,
        projectId: planning.account.cloudId,
        region: planning.region,
        environmentId: planning.environmentId,
        stateId,
        network: network.names,
        machineType: stackVm.size.machineType,
        dataDiskGb: stackVm.dataDiskGb,
        snapshotDays: stackVm.snapshotDays,
        imageId: null,
        zone: null,
        pins: stackVmPinsOn('gcp'),
        native: stackVm.nativeGcp,
        sshPublicKey: null,
      }).definition,
      variables: {},
      namePrefix: serviceName(serviceId),
      context: {
        serviceName: step.configName,
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId },
      control,
    });
  }

  /**
   * A change to a Compose stack's Stack VM, or its read for Drift
   * (#1368): its definition as the Apply's Cloud run will write it, on
   * the made network, against the stack's own state, with `-replace` on
   * an approved "replace VM". A plan that would shrink or delete its data
   * disk fails the read: on Google Cloud a smaller size would replace the
   * disk, and a data disk only grows.
   */
  private async readStackVmChange(
    planning: GooglePlanning,
    step: StackVmChangeStep,
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const [row] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, step.serviceId));
    if (!row?.stackVm) return failed(`${step.configName} has no Stack VM`);
    const state = await this.states.findForCompose(step.serviceId);
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await this.networkNames(planning);
    if (network.standIns) {
      return failed(
        `${step.configName}'s Environment network in ${planning.region} is not made`,
      );
    }
    const written = stackVmWritten(
      stackVmSettingsAfter(row.stackVm, step.stackVm),
      'gcp',
    );
    return this.plan(planning, {
      existing: true,
      stateId: state.infrastructureStateId,
      definition: googleStackVmDefinition({
        configName: step.configName,
        serviceId: step.serviceId,
        cloudAccountId: planning.account.cloudAccountId,
        projectId: planning.account.cloudId,
        region: planning.region,
        environmentId: planning.environmentId,
        stateId: state.infrastructureStateId,
        network: network.names,
        machineType: written.machineType,
        dataDiskGb: written.dataDiskGb,
        snapshotDays: written.snapshotDays,
        imageId: written.imageId,
        zone: written.zone,
        pins: written.pins,
        native: step.stackVm.nativeGcp,
        // Its first boot is never changed in place, so a read leaves the
        // key out: what its run writes differs only there.
        sshPublicKey: null,
        // As its run writes them, so the plan shows its backends kept.
        ports: googleStackVmPorts(row.stackVm),
      }).definition,
      variables: {},
      namePrefix: serviceName(step.serviceId),
      context: { serviceName: step.configName },
      ids: { serviceId: step.serviceId },
      control,
      ...(written.replace
        ? { replaces: [GOOGLE_STACK_VM_INSTANCE_ADDRESS] }
        : {}),
      refuse: (show) =>
        dataDiskRefusal(step.configName, show, 'google_compute_disk'),
    });
  }
  /**
   * A change to a redis on Memorystore read from its own state: its
   * definition as the Apply's Cloud run will write it — the node type and
   * version the change moves to — planned against the state that holds the
   * instance, so the lines are what Google will do in place.
   */
  private async readMemorystoreChange(
    planning: GooglePlanning,
    step: MemorystoreChange,
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, step.serviceId));
    if (!row) return failed(`${step.configName} is gone`);
    const state = await this.states.findForRedis(row.redisId);
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await this.networkNames(planning);
    const { memorystore } = step;
    const written = savedMemorystoreDefinition({
      row,
      account: planning.account,
      stateId: state.infrastructureStateId,
      network: network.names,
      ...(memorystore.nodeType ? { nodeType: memorystore.nodeType.to } : {}),
      ...(memorystore.version
        ? { engineVersion: memorystore.version.engineVersion }
        : {}),
      ...(memorystore.backupRetentionDays
        ? { backupRetentionDays: memorystore.backupRetentionDays.to }
        : {}),
      // The `native.gcp` the change lays, before its Apply saves it.
      ...(memorystore.native !== undefined
        ? { native: memorystore.native }
        : {}),
    });
    if (!written.ok) return failed(written.message);
    const read = await this.plan(planning, {
      existing: true,
      stateId: state.infrastructureStateId,
      definition: written.definition,
      variables: {},
      namePrefix: serviceName(row.redisId),
      context: {
        serviceName: step.configName,
        ...(memorystore.nodeType?.sizeName
          ? { sizeName: memorystore.nodeType.sizeName }
          : {}),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      ids: { serviceId: row.redisId },
      control,
    });
    return refusingNativeReplace(step.configName, memorystore.native, read);
  }

  /**
   * A bucket on Cloud Storage: its definition — the bucket, its
   * settings and CORS, its own service account, that account's binding on it
   * and its HMAC key — against a new state for a create, under the real name
   * and Service id the plan minted together and with no origin trusted yet;
   * or against its own state for one that exists, with the origins its page
   * holds now, so what differs is its CORS change or Drift. A bucket sits in
   * no Environment network.
   */
  private async readBucket(
    planning: GooglePlanning,
    step: Create | Change,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    let made: {
      stateId: string;
      serviceId: string;
      bucketName: string;
      origins: readonly string[];
      existing: boolean;
      keys?: GcpBucketKeys;
    };
    if (step.action === 'create') {
      if (!step.bucket?.serviceId) {
        return failed(
          `${step.configName} was planned without its bucket's real name; plan again`,
        );
      }
      made = {
        stateId: options.kept?.stateId ?? nanoid(),
        serviceId: step.bucket.serviceId,
        bucketName: step.bucket.name,
        origins: [],
        existing: false,
      };
    } else {
      const [row] = await this.db
        .select({
          bucketName: bucket.bucketName,
          origins: bucket.origins,
          googleKeySlot: bucket.googleKeySlot,
          rotationKeys: bucket.rotationKeys,
        })
        .from(bucket)
        .where(eq(bucket.bucketId, step.serviceId));
      const state = await this.states.findForBucket(step.serviceId);
      if (!row || !state) {
        return failed(`${step.configName} has no Infrastructure state`);
      }
      made = {
        stateId: state.infrastructureStateId,
        serviceId: step.serviceId,
        bucketName: row.bucketName,
        origins: row.origins,
        existing: true,
        // The keys its state holds, so a key a rotation moved or
        // holds apart is no change.
        keys: googleKeyLayout(row),
      };
    }
    return this.plan(planning, {
      existing: made.existing,
      stateId: made.stateId,
      definition: gcpBucketDefinition({
        serviceId: made.serviceId,
        bucketName: made.bucketName,
        cloudAccountId: planning.account.cloudAccountId,
        projectId: planning.account.cloudId,
        region: planning.region,
        environmentId: planning.environmentId,
        stateId: made.stateId,
        origins: made.origins,
        keys: made.keys,
      }),
      variables: {},
      namePrefix: serviceName(made.serviceId),
      context: { serviceName: step.configName },
      ids: { serviceId: made.serviceId },
      control,
    });
  }

  /**
   * A `static` site on Cloud Storage + Cloud CDN: its definition —
   * its private bucket, its backend bucket and the load balancer's grant —
   * against a new state for a create, under the bucket name and Service id
   * the plan minted; or against its own state for one that exists, for
   * Drift. It sits in no Environment network: its host rules are the
   * network's, written by its Domains' runs, so a plan of the site never
   * changes them.
   */
  private async readStatic(
    planning: GooglePlanning,
    step: StaticCreate | StaticChange,
    control: CloudRunControl,
    options: GoogleReadOptions,
  ): Promise<CloudRead> {
    let made: {
      existing: boolean;
      stateId: string;
      serviceId: string;
      bucketName: string;
    };
    if (step.action === 'create') {
      if (!step.bucket) {
        return failed(
          `${step.configName} was planned without its bucket's real name; plan again`,
        );
      }
      made = {
        existing: false,
        stateId: options.kept?.stateId ?? nanoid(),
        serviceId: options.kept?.serviceId ?? step.bucket.serviceId ?? nanoid(),
        bucketName: step.bucket.name,
      };
    } else {
      const app = await this.applications.findDeployable(step.serviceId);
      const state = await this.states.findForApplication(step.serviceId);
      if (!state || !app.cloudBucketName) {
        return failed(`${step.configName} has no Infrastructure state`);
      }
      made = {
        existing: true,
        stateId: state.infrastructureStateId,
        serviceId: step.serviceId,
        bucketName: app.cloudBucketName,
      };
    }
    return this.plan(planning, {
      existing: made.existing,
      stateId: made.stateId,
      definition: gcpStaticDefinition({
        serviceId: made.serviceId,
        bucketName: made.bucketName,
        cloudAccountId: planning.account.cloudAccountId,
        projectId: planning.account.cloudId,
        projectNumber: planning.account.projectNumber,
        region: planning.region,
        environmentId: planning.environmentId,
        stateId: made.stateId,
      }),
      variables: {},
      namePrefix: serviceName(made.serviceId),
      context: { serviceName: step.configName },
      ids: { serviceId: made.serviceId },
      control,
    });
  }

  /**
   * An **Existing database** that is a Cloud SQL `postgres` (ADR-0033
   * as amended), or a `mysql`, looked
   * up on every plan: the instance read through the Google client port and
   * judged (`judgeExistingCloudSql`, which refuses another engine's),
   * refusing with its fix; then what Cloudgate makes for it — its manual
   * endpoint and private zone, in the Service's own state, a new one until
   * the first Apply makes them — planned as its Cloud run will write them,
   * so the plan shows their cost, or a change of address replaces them. Its
   * `….sql.goog.` name and CA, read as given, are saved on the first
   * lookup; a later one that finds either changed is an Output change its
   * Apply saves. Once the endpoint is made, its acceptance is read
   * again for the page.
   */
  async readExistingCloudSql(
    account: GcpCloudAccount,
    existing: {
      readonly existingDatabaseId: string;
      readonly kind: CloudSqlEngineName;
      readonly serviceId: string;
      readonly environmentId: string;
      readonly region: string;
      readonly identifier: string;
    },
    step: Change & { readonly existing: NonNullable<Change['existing']> },
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const name = step.configName;
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return failed(session.refusal);
    const planning: GooglePlanning = {
      environmentId: existing.environmentId,
      region: existing.region,
      account,
      credential: session.credential,
      token: session.token,
    };
    const parts = parseConnectionName(existing.identifier);
    let lookup: CloudSqlLookup = { kind: 'missing' };
    if (parts) {
      try {
        const answer = await this.google.cloudSqlInstance(session.token, {
          projectId: parts.projectId,
          instance: parts.instance,
        });
        if (answer.ok) {
          lookup = { kind: 'found', instance: answer.value };
        } else if (answer.code === PERMISSION_DENIED) {
          lookup = { kind: 'unreadable', message: answer.message };
        } else if (answer.code !== NOT_FOUND) {
          return failed(
            googleRefusalReason(
              `${name}: Google Cloud could not be asked for the existing database ${existing.identifier}: ${answer.code}: ${answer.message}`,
              account.cloudId,
            ),
          );
        }
      } catch (error) {
        return failed(
          `${name}: Google Cloud could not be reached for the existing database ${existing.identifier}: ${describeError(error)}. Check for changes to read it again`,
        );
      }
    }
    const verdict = judgeExistingCloudSql(lookup, {
      engine: existing.kind,
      serviceName: name,
      connectionName: existing.identifier,
      project: {
        projectId: account.cloudId,
        projectNumber: account.projectNumber,
      },
      region: existing.region,
      serviceAccount: account.deployServiceAccount,
      configVersion: step.existing.version,
    });
    // Gone: its page says so until a lookup finds it again.
    await noteFound(this.db, existing.existingDatabaseId, verdict);
    if (!verdict.ok) return failed(verdict.reason);
    await this.db
      .update(existingDatabase)
      .set({ serviceAttachment: verdict.serviceAttachment })
      .where(
        eq(existingDatabase.existingDatabaseId, existing.existingDatabaseId),
      );
    const moved = await lookedUpAddress(this.db, {
      existingDatabaseId: existing.existingDatabaseId,
      serviceType: step.serviceType,
      configName: name,
      identifier: existing.identifier,
      found: verdict.address,
      ca: verdict.ca,
    });
    const { serviceId } = existing;
    const state = await findRdsState(this.states, existing.kind, serviceId);
    const stateId = state?.infrastructureStateId ?? nanoid();
    const read = await this.plan(planning, {
      existing: state !== null,
      stateId,
      definition: existingCloudSqlDefinition({
        serviceId,
        cloudAccountId: account.cloudAccountId,
        projectId: account.cloudId,
        region: existing.region,
        environmentId: existing.environmentId,
        stateId,
        serviceAttachment: verdict.serviceAttachment,
        dnsName: verdict.address.host,
      }),
      variables: {},
      namePrefix: serviceName(serviceId),
      context: { serviceName: name },
      ids: { serviceId },
      control,
    });
    if (read.status !== 'read') return read;
    if (state) {
      await readEndpointStatus(this.db, this.google, session.token, {
        existingDatabaseId: existing.existingDatabaseId,
        projectId: account.cloudId,
        region: existing.region,
        serviceId,
      });
    }
    return {
      ...read,
      summary: [
        ...verdict.lines,
        ...(moved ? [moved.line] : []),
        ...read.summary,
      ],
      ...(moved ? { addressMoved: moved.addressMoved } : {}),
    };
  }

  /**
   * An **Existing database** that is a Memorystore for Valkey `redis`
   * (ADR-0033 as amended, ADR-0042), looked up on every
   * plan: the instance read through the Google client port and judged
   * (`judgeExistingValkey`), refusing with its fix; then Cloudgate's two
   * manual endpoints, in the redis's own state — a new one until the first
   * Apply makes them — planned as its Cloud run will write them, so the plan
   * shows their cost. Its TLS and CA are read, never typed: saved on the
   * first lookup, and a later one that finds either changed is an Output
   * change its Apply saves and redeploys from. Once the endpoints are
   * made, whether both are registered on the instance is read again for the
   * page; nothing waits on it.
   */
  async readExistingRedis(
    account: GcpCloudAccount,
    existing: {
      readonly existingDatabaseId: string;
      readonly redisId: string;
      readonly environmentId: string;
      readonly region: string;
      readonly identifier: string;
    },
    step: Change & { readonly existing: NonNullable<Change['existing']> },
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const name = step.configName;
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return failed(session.refusal);
    const looked = await lookUpValkey(this.google, session.token, {
      serviceName: name,
      identifier: existing.identifier,
      projectId: account.cloudId,
    });
    if (!looked.ok) return failed(looked.reason);
    const verdict = judgeExistingValkey(looked.lookup, {
      serviceName: name,
      identifier: existing.identifier,
      projectId: account.cloudId,
      region: existing.region,
      serviceAccount: account.deployServiceAccount,
    });
    // Gone: its page says so until a lookup finds it again.
    await noteFound(this.db, existing.existingDatabaseId, verdict);
    if (!verdict.ok) return failed(verdict.reason);
    const where = eq(
      existingDatabase.existingDatabaseId,
      existing.existingDatabaseId,
    );
    const [saved] = await this.db.select().from(existingDatabase).where(where);
    if (!saved) return failed(`${name} is no longer an existing database`);
    // Its TLS and CA as read. Before its endpoints give it an address there
    // is nothing to deploy from, so they are saved now; after, a new CA
    // waits for this plan's Apply, as an address does (ADR-0006: no Output
    // is written into a plan).
    const moved: string[] = [];
    if (saved.address) {
      if (saved.tls !== verdict.tls) moved.push('url', 'ca');
      else if ((saved.ca ?? null) !== verdict.ca) moved.push('ca');
    }
    await this.db
      .update(existingDatabase)
      .set({
        serviceAttachments: verdict.serviceAttachments,
        tls: verdict.tls,
        ...(saved.address
          ? { foundCa: moved.length > 0 ? verdict.ca : null }
          : { ca: verdict.ca, foundCa: null }),
      })
      .where(where);
    const state = await this.states.findForRedis(existing.redisId);
    const stateId = state?.infrastructureStateId ?? nanoid();
    const read = await this.plan(
      {
        environmentId: existing.environmentId,
        region: existing.region,
        account,
        credential: session.credential,
        token: session.token,
      },
      {
        existing: state !== null,
        stateId,
        definition: existingValkeyDefinition({
          serviceId: existing.redisId,
          cloudAccountId: account.cloudAccountId,
          projectId: account.cloudId,
          region: existing.region,
          environmentId: existing.environmentId,
          stateId,
          serviceAttachments: verdict.serviceAttachments,
        }),
        variables: {},
        namePrefix: serviceName(existing.redisId),
        context: { serviceName: name },
        ids: { serviceId: existing.redisId },
        control,
      },
    );
    if (read.status !== 'read') return read;
    const registration =
      looked.lookup.kind === 'found'
        ? await saveRegistration(
            this.db,
            saved,
            account.cloudId,
            looked.lookup.instance,
          )
        : null;
    const made = read.raw.filter(
      (line) =>
        line.address.startsWith('google_compute_forwarding_rule.') &&
        line.action === 'create',
    ).length;
    const outputs = moved.map((output) => `${name}.${output}`);
    const them = outputs.length === 1 ? 'it' : 'them';
    const movedLine =
      outputs.length === 0
        ? null
        : `${name}: ${existing.identifier} ${moved.includes('url') ? `now has TLS ${verdict.tls ? 'on' : 'off'}` : 'reports a new CA'}; ${outputs.join(', ')} changed, so Apply saves ${them}, then redeploys what links to ${them}`;
    return {
      ...read,
      summary: [
        ...verdict.lines,
        ...(movedLine ? [movedLine] : []),
        ...(made === 2
          ? [
              `${name}: Cloudgate's two endpoints to ${existing.identifier}, its primary's and its reader's, ${VALKEY_ENDPOINTS_COST} together; after the Apply its page shows the one command that registers them on the instance, and linked Services deploy without waiting for it`,
            ]
          : []),
        ...(registration === 'waiting'
          ? [
              `${name}: Cloudgate's endpoints are ${WAITING_FOR_REGISTRATION} on ${existing.identifier}; its page shows the command`,
            ]
          : []),
        ...read.summary,
      ],
      ...(outputs.length > 0 && saved.address
        ? {
            addressMoved: {
              from: saved.address,
              to: saved.address,
              moved: outputs,
            },
          }
        : {}),
    };
  }

  /**
   * An **existing bucket** on Cloud Storage (ADR-0033 as amended), looked up on
   * every plan: the bucket read through the Google
   * client port with Cloudgate's own token and judged
   * (`judgeExistingGoogleBucket`), refusing with its fix or noting a
   * location that does not hold the Environment's region; then what
   * Cloudgate makes for it — the bucket Service's own service account and
   * HMAC key, never the bucket nor a grant on it — planned as its Cloud run
   * will write them, in its own state, a new one until the first Apply
   * makes them. Once its key exists, its access is checked again for the
   * page; the plan never waits on it or refuses for it.
   */
  async readExistingBucket(
    account: GcpCloudAccount,
    existing: GoogleExistingBucket,
    step: Change,
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const name = step.configName;
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return failed(session.refusal);
    let lookup: GoogleBucketLookup;
    try {
      const answer = await this.google.storageBucket(
        session.token,
        existing.bucketName,
      );
      if (answer.ok) {
        lookup = { kind: 'found', bucket: answer.value };
      } else if (answer.code === NOT_FOUND) {
        lookup = { kind: 'missing' };
      } else if (answer.code === PERMISSION_DENIED) {
        lookup = { kind: 'unreadable', message: answer.message };
      } else {
        return failed(
          googleRefusalReason(
            `${name}: Google Cloud could not be asked for the existing bucket ${existing.bucketName}: ${answer.code}: ${answer.message}`,
            account.cloudId,
          ),
        );
      }
    } catch (error) {
      return failed(
        `${name}: Google Cloud could not be reached for the existing bucket ${existing.bucketName}: ${describeError(error)}. Check for changes to read it again`,
      );
    }
    const verdict = judgeExistingGoogleBucket(lookup, {
      serviceName: name,
      bucketName: existing.bucketName,
      project: {
        projectId: account.cloudId,
        projectNumber: account.projectNumber,
      },
      region: existing.region,
      serviceAccount: account.deployServiceAccount,
    });
    if (!verdict.ok) return failed(verdict.reason);
    // Its own project, which its page names.
    const [row] =
      lookup.kind === 'found'
        ? await this.db
            .update(bucket)
            .set({ googleProjectNumber: lookup.bucket.projectNumber })
            .where(eq(bucket.bucketId, existing.bucketId))
            .returning()
        : await this.db
            .select()
            .from(bucket)
            .where(eq(bucket.bucketId, existing.bucketId));
    if (!row) return failed(`${name} is no longer an existing bucket`);
    const state = await this.states.findForBucket(existing.bucketId);
    const stateId = state?.infrastructureStateId ?? nanoid();
    const read = await this.plan(
      {
        environmentId: existing.environmentId,
        region: existing.region,
        account,
        credential: session.credential,
        token: session.token,
      },
      {
        existing: state !== null,
        stateId,
        definition: gcpBucketDefinition({
          serviceId: existing.bucketId,
          bucketName: existing.bucketName,
          cloudAccountId: account.cloudAccountId,
          projectId: account.cloudId,
          region: existing.region,
          environmentId: existing.environmentId,
          stateId,
          origins: [],
          // The keys its state holds, so a key a rotation moved or
          // holds apart is no change.
          keys: googleKeyLayout(row),
          existing: true,
        }),
        variables: {},
        namePrefix: serviceName(existing.bucketId),
        context: { serviceName: name },
        ids: { serviceId: existing.bucketId },
        control,
      },
    );
    if (read.status !== 'read') return read;
    if (state) await checkGoogleBucketAccess(this.db, this.objectStorage, row);
    return { ...read, summary: [...verdict.lines, ...read.summary] };
  }

  /** The `tofu plan`, the search by name for what it creates, and the reader's lines. */
  private async plan(
    planning: GooglePlanning,
    run: {
      existing: boolean;
      stateId: string;
      definition: Record<string, unknown>;
      variables: Record<string, string>;
      namePrefix: string;
      context: GooglePlanReadContext;
      ids: { serviceId?: string };
      control: CloudRunControl;
      /** Addresses planned anew: an approved "replace VM"'s Stack VM. */
      replaces?: string[];
      /** Why the plan it read is refused before it is shown, or `null`. */
      refuse?: (show: TofuShowJson) => string | null;
    },
  ): Promise<CloudRead> {
    const projectId = planning.account.cloudId;
    const request = {
      stateId: run.stateId,
      credential: planning.credential,
      definition: run.definition,
      variables: run.variables,
      signal: run.control.signal,
      ...(run.replaces ? { replaces: run.replaces } : {}),
    };
    const outcome = run.existing
      ? await this.states.plan(request)
      : await this.states.planFresh(request);
    if (!outcome.ok) {
      return failed(googleRefusalReason(outcome.message, projectId));
    }
    const refused = run.refuse?.(outcome.show) ?? null;
    if (refused) return failed(refused);
    const found = await this.findByName(planning, outcome.show, run.namePrefix);
    if (!found.ok) return failed(found.reason);
    const reading = readGooglePlan({
      show: outcome.show,
      nameSearch: found.value,
      context: run.context,
    });
    return {
      status: 'read',
      ...reading,
      stateId: run.stateId,
      ...run.ids,
      readAt: new Date().toISOString(),
    };
  }

  /**
   * One list call per kind the plan creates, by the state's name prefix:
   * Google keeps no label on most kinds, so the fixed name is
   * how a lost state's things are found again.
   */
  private async findByName(
    planning: GooglePlanning,
    show: TofuShow,
    namePrefix: string,
  ): Promise<
    { ok: true; value: FoundByName[] } | { ok: false; reason: string }
  > {
    const projectId = planning.account.cloudId;
    const kinds = createdKinds(show);
    const value: FoundByName[] = [];
    for (const resourceType of kinds) {
      try {
        const answer = await this.google.findByName(planning.token, {
          projectId,
          region: planning.region,
          resourceType,
          namePrefix,
        });
        if (!answer.ok) {
          return {
            ok: false,
            reason: googleRefusalReason(
              `Google refused the search for ${resourceType} by Cloudgate's names: ${answer.code}: ${answer.message}`,
              projectId,
            ),
          };
        }
        value.push(...answer.value);
      } catch (error) {
        return {
          ok: false,
          reason: `Google Cloud could not be reached for the search by name: ${describeError(error)}. Check for changes to read it again`,
        };
      }
    }
    return { ok: true, value };
  }

  /** The network names a Service's definition is written with. */
  private networkNames({ environmentId, account, region }: GooglePlanning) {
    return googleNetworkNames(this.db, {
      environmentId,
      cloudAccountId: account.cloudAccountId,
      region,
    });
  }
}

/** The kinds a plan creates, each once, in the order the plan names them. */
function createdKinds(show: TofuShowJson): string[] {
  return [
    ...new Set(
      (show.resource_changes ?? [])
        .filter(
          (change) =>
            change.mode !== 'data' && change.change.actions.includes('create'),
        )
        .map((change) => change.type),
    ),
  ];
}

/**
 * A planned `web`'s or Worker's config as the definition is written from it;
 * its port, if it has one, is its routing's (`cloudRunRoutingOf`).
 */
function entryOf(
  service: NonNullable<Create['cloud']>['service'],
): CloudRunEntry & Pick<WebEntry, 'size'> {
  return {
    ...(service.command === null ? {} : { command: service.command }),
    args: service.args,
    ...(service.size === null ? {} : { size: service.size }),
  };
}

function failed(reason: string): CloudRead {
  return { status: 'failed', reason };
}

/**
 * A read whose plan carries out a native change as a replace of a Cloud
 * SQL or Memorystore instance (ADR-0044 rule 10) fails naming each
 * native path, so its Apply is refused: native never loses a database's
 * data. `native` is the block the change lays.
 */
function refusingNativeReplace(
  configName: string,
  native: NativeGcpBlock | null | undefined,
  read: CloudRead,
): CloudRead {
  if (read.status !== 'read') return read;
  const refused = nativeGcpReplaceRefusals(configName, native, read.raw);
  return refused.length === 0
    ? read
    : failed(refused.map((one) => one.message).join('; '));
}
