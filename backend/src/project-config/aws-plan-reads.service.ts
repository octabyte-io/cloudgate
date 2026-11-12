import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNotNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { ApplicationsService } from '../applications/applications.service';
import { makeDefaultCertificate } from '../cloud-accounts/definitions/default-certificate';
import { networkDefinition } from '../cloud-accounts/aws/definitions/network-definition';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../cloud-accounts/definitions/default-certificate';
import {
  STAND_IN_IMAGE_TAG,
  PRIVATE_DNS_NAMESPACE_STAND_IN,
  STAND_IN_MARKER,
  networkStandIns,
} from '../cloud-accounts/aws/definitions/stand-ins';
import type { NetworkIds } from '../cloud-accounts/aws/definitions/stand-ins';
import { linksAfter } from '../cloud-accounts/definitions/network-links';
import type { NetworkLinkKind } from '../cloud-accounts/definitions/network-links';
import {
  RDS_POSTGRES_DEFAULTS,
  rdsDatabaseDefinition,
} from '../cloud-accounts/aws/definitions/postgres-definition';
import {
  ELASTICACHE_REDIS_DEFAULTS,
  redisDefinition,
} from '../cloud-accounts/aws/definitions/redis-definition';
import {
  joinedToCreate,
  withNamespaceImportIds,
  roleFind,
  rolesToCreate,
} from '../cloud-accounts/aws/definitions/imports';
import { TAG_KEYS } from '../cloud-accounts/aws/definitions/tags';
import { bucketDefinition } from '../cloud-accounts/aws/definitions/bucket-definition';
import { staticDefinition } from '../cloud-accounts/aws/definitions/static-definition';
import { ecsDefinitionOf } from '../cloud-accounts/aws/definitions/web-definition';
import {
  STACK_VM_INSTANCE_ADDRESS,
  stackVmDefinition,
} from '../cloud-accounts/aws/definitions/stack-vm-definition';
import { stackVmPinsOn } from '../cloud-accounts/definitions/stack-vm-pins';
import {
  dataDiskRefusal,
  stackVmSettingsAfter,
  stackVmWritten,
} from '../cloud-accounts/definitions/stack-vm-written';
import type { EcsServiceEntry } from '../cloud-accounts/aws/definitions/web-definition';
import {
  olderValkey,
  runningValkeyVersion,
} from '../cloud-accounts/aws/plan-reader/cache-lines';
import { runningPostgresVersion } from '../cloud-accounts/aws/plan-reader/database-lines';
import { readPlan } from '../cloud-accounts/aws/plan-reader/read-plan';
import type {
  NoStateNote,
  PlanReadContext,
  PlanReading,
} from '../cloud-accounts/aws/plan-reader/read-plan';
import { setupNames } from '../cloud-accounts/aws/setup-template';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { awsAccountOf, credentialOf } from '../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  TaggedResource,
  TofuShow,
} from '../cloud-accounts/cloud.port';
import { infrastructureState } from '../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { Env } from '../common/config/env.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  bucket,
  compose,
  environmentNetwork,
  NEW_SERVICE_REPLICAS,
  redis,
} from '../db/schema';
import type { CloudRunControl } from '../deployment-queue/cloud-run-job.types';
import { getEnvironmentVariablesObject } from '../docker/docker.utils';
import { webEntryOf } from './applier/cloud-deploy-steps';
import { deployedDomains } from './applier/deployed-domains';
import { awsStackVmDomainPieces } from './applier/stack-vm-domain-pieces';
import { liveImageOf } from './applier/live-image';
import { sortFinds, withStrays } from './cloud-read-finds';
import { savedRedisDefinition } from './elasticache-redis-places';
import { describeError } from '../common/describe-error';
import { rdsClassOf } from './planner/cloud-postgres';
import { RDS_ENGINES } from '../cloud-accounts/aws/definitions/rds-engines';
import type { RdsEngineName } from '../cloud-accounts/aws/definitions/rds-engines';
import {
  findRdsRow,
  findRdsState,
  rdsIdOf,
} from '../databases/common/rds-rows';
import { elastiCacheNodeTypeOf } from './planner/cloud-redis';
import { cloudStepName } from './planner/cloud-steps';
import type { CloudRead } from './planner/plan.types';
import { linkedS3Buckets, wiredEnv } from './outputs';
import type { ConfigLinks } from './project-config.types';
import {
  databaseNetworkStandIns,
  savedDatabaseNetwork,
  savedRdsDatabaseDefinition,
  snapshotDate,
  snapshotNames,
} from './rds-postgres-places';
import type {
  Change,
  CloudStep,
  CloudStepReader,
  Create,
  KeptIds,
  PostgresCreate,
  RedisCreate,
  StackVmCreate,
  StepReadOptions,
} from './cloud-step-reader';
import { failed } from './cloud-step-reader';
import { nativeAwsReplaceRefusals } from '../native/aws-lay';
import { nativeFargateOf } from '../native/aws-size';
import type { NativeAwsBlock } from '../native/aws-native';
import { InstanceMode } from '../instance-mode/instance-mode.service';

/** Where a read writes from, and what it plans against. */
interface Planning {
  readonly environmentId: string;
  readonly region: string;
  readonly account: AwsCloudAccount;
  readonly credential: AwsCredential;
  readonly session: AwsCredential;
  /** Whether the strays of the tag search are this step's to note. */
  readonly notesStrays: boolean;
  /** The kind of each Service the plan creates, by Config name. */
  readonly creates: Readonly<Record<string, string>>;
  /**
   * The real name of each bucket on AWS the same plan creates, by Config
   * name: what a cloud Service linking one is read with before its
   * row exists.
   */
  readonly plannedBuckets: ReadonlyMap<string, string>;
}

/**
 * A plan step read from AWS (the AWS spec "Plan behaviour"): the
 * AWS half of {@link CloudPlanReads}, which picks it by the Cloud account's
 * cloud (ADR-0043) and runs it in the Cloud run pool, as it runs
 * `GooglePlanReads` for a Google Cloud project.
 *
 * It writes the definition the generator makes, asks the cloud port
 * for a `tofu plan` and answers the plan reader's lines. A
 * create plans against a new state; a Service that exists, or a made
 * network, against its own, with the live image and the variables, Domains
 * and running count it has, so what differs is Drift or the config's change.
 *
 * **Every read searches by tag** (ADR-0036 item 6): what carries the
 * Environment's and Cloud account's tags in the region. A find tagged with
 * the state read is the reader's to adopt (imported on Apply) or note; one
 * tagged with a state Cloudgate has no record of is "found in AWS, in no
 * state", noted once per plan, on its first cloud step.
 *
 * **Before `tofu`, the credential.** The Cloud account's key takes on the
 * deploy role; a refusal fails the read, naming the Cloud account and AWS's
 * error, and is recorded on the Cloud account until a check passes.
 */
@Injectable()
export class AwsPlanReads implements CloudStepReader<AwsCloudAccount> {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly states: InfrastructureStatesService,
    private readonly applications: ApplicationsService,
    private readonly config: ConfigService<Env, true>,
    private readonly instanceMode: InstanceMode,
  ) {}

  async read(
    account: AwsCloudAccount,
    place: { readonly environmentId: string; readonly region: string },
    step: CloudStep,
    control: CloudRunControl,
    options: StepReadOptions,
  ): Promise<CloudRead> {
    const credential = credentialOf(account);
    const session = await this.cloudAccounts.deployRoleSession(
      account,
      credential,
    );
    if (!session.ok) return failed(session.refusal);
    const planning: Planning = {
      environmentId: place.environmentId,
      region: place.region,
      account,
      credential,
      session: session.session,
      notesStrays: options.notesStrays,
      creates: options.creates ?? {},
      plannedBuckets: options.plannedBuckets,
    };

    switch (step.action) {
      case 'network-create':
      case 'network-change':
        return this.readNetwork(
          planning,
          step,
          control,
          options.unfinishedNetworkState,
        );
      case 'change':
        if (step.serviceType === 'bucket') {
          return this.readBucket(planning, step, control, {});
        }
        if (step.stackVm) {
          return this.readStackVmChange(
            planning,
            { ...step, stackVm: step.stackVm },
            control,
          );
        }
        if (step.kind === 'static') {
          return this.readStatic(planning, step, control, {});
        }
        return this.readService(planning, step, control);
      case 'create':
        if (step.kind === 'bucket') {
          return this.readBucket(planning, step, control, options.kept ?? {});
        }
        if (step.kind === 'static') {
          return this.readStatic(planning, step, control, options.kept ?? {});
        }
        if (step.database) {
          return this.readPostgres(
            planning,
            { ...step, database: step.database },
            control,
            options.kept ?? {},
          );
        }
        if (step.cache) {
          return this.readRedis(
            planning,
            { ...step, cache: step.cache },
            control,
            options.kept ?? {},
          );
        }
        if (step.stackVm) {
          return this.readStackVm(
            planning,
            { ...step, stackVm: step.stackVm },
            control,
            options.kept ?? {},
          );
        }
        if (!step.cloud) return failed(`${step.configName} reads no AWS`);
        return this.readCreate(
          planning,
          { ...step, cloud: step.cloud },
          control,
          options.kept ?? {},
        );
    }
  }

  /**
   * The Environment network: a create against a new state — or, when a
   * create failed, the state it left, so its Apply finishes it rather than
   * making a second network beside it — or a made one against its
   * own, for Drift. Written with the private DNS namespace it holds
   * and the one its step adds, so a read for Drift never shows a
   * held namespace as destroyed.
   */
  private async readNetwork(
    planning: Planning,
    step: Extract<CloudStep, { action: 'network-create' | 'network-change' }>,
    control: CloudRunControl,
    unfinishedNetworkState: string | null,
  ): Promise<CloudRead> {
    const { account, environmentId, region } = planning;
    let held: readonly NetworkLinkKind[] = [];
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
    }
    const existing =
      step.action === 'network-change'
        ? ((await this.states.findForNetwork(step.environmentNetworkId))
            ?.infrastructureStateId ?? null)
        : unfinishedNetworkState;
    if (step.action === 'network-change' && existing === null) {
      return failed(`The ${cloudStepName(step)} has no Infrastructure state`);
    }
    const stateId = existing ?? nanoid();
    const certificate = makeDefaultCertificate();
    return this.plan(
      planning,
      existing !== null,
      {
        stateId,
        credential: planning.credential,
        definition: networkDefinition({
          cloudAccountId: account.cloudAccountId,
          account: accessOf(account),
          region,
          environmentId,
          stateId,
          privateLinks: linksAfter(held, step),
          // A hosted cloud build's standing pieces: the Hosted
          // instance's cloud Services build in CodeBuild in this account.
          cloudBuilds: this.instanceMode.isHosted,
        }),
        variables: {
          [DEFAULT_CERTIFICATE_VARIABLES.certificate]:
            certificate.certificatePem,
          [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
        },
        signal: control.signal,
      },
      // The NAT gateway's line prices it in its region.
      { region },
      {},
    );
  }

  /**
   * A cloud `web` a plan creates, against a new state. Read again by an
   * Apply, it keeps the ids it was first read with, so what the Apply makes
   * is in the state the plan showed.
   */
  private async readCreate(
    planning: Planning,
    step: Create & { readonly cloud: NonNullable<Create['cloud']> },
    control: CloudRunControl,
    kept: KeptIds,
  ): Promise<CloudRead> {
    const stateId = kept.stateId ?? nanoid();
    const serviceId = kept.serviceId ?? nanoid();
    const network = await this.networkIds(planning);
    const { service } = step.cloud;
    // A Service a plan creates has no typed values yet: they are set once
    // it exists, and reach AWS with a deploy. Its wired variables are
    // its config's: their parameters are in the plan, at stand-in
    // values while their sources are not made.
    const values = await this.plannedWired(planning, step.cloud.links);
    // A `web` routed by its target group, a Worker by nothing, a
    // Cron service its task definition with no ECS service.
    const generated = ecsDefinitionOf(
      step.kind,
      {
        configName: step.configName,
        entry: entryOf(service),
        service: { serviceId, replicas: NEW_SERVICE_REPLICAS },
        account: webAccountOf(planning.account),
        region: planning.region,
        environmentId: planning.environmentId,
        stateId,
        network: network.ids,
        image: { tag: STAND_IN_IMAGE_TAG, architecture: 'amd64' },
        variables: { values, digestSecret: this.digestSecret() },
        buckets: await this.plannedBucketAccess(planning, step.cloud.links),
        // Its entry's `native.aws`, laid as its deploy will lay it.
        native: step.cloud.native,
      },
      { port: service.port },
    );
    if (!generated.ok) return failed(generated.refusal.message);
    return this.plan(
      planning,
      false,
      {
        stateId,
        credential: planning.credential,
        definition: generated.definition,
        variables: generated.variables,
        signal: control.signal,
      },
      {
        serviceName: step.configName,
        ...(step.cloud.size.name === null
          ? {}
          : { sizeName: step.cloud.size.name }),
        ...nativePairOf(step.cloud.native),
        variableNames: Object.keys(values),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      { serviceId },
    );
  }

  /**
   * A `postgres` create's read: its RDS definition, written as its
   * Apply will write it, against a new state. The instance's password does
   * not exist until its create, so the read plans with a throwaway one;
   * it is a `sensitive` variable, which no plan line shows.
   */
  private async readPostgres(
    planning: Planning,
    step: PostgresCreate,
    control: CloudRunControl,
    kept: KeptIds,
  ): Promise<CloudRead> {
    const { environmentId, region, account } = planning;
    const stateId = kept.stateId ?? nanoid();
    const serviceId = kept.serviceId ?? nanoid();
    const saved = await savedDatabaseNetwork(this.db, {
      environmentId,
      cloudAccountId: account.cloudAccountId,
      region,
    });
    const standIn = saved
      ? null
      : databaseNetworkStandIns(region, account.cloudId);
    const { database } = step;
    const generated = rdsDatabaseDefinition({
      // A mysql on RDS is the same definition with MySQL's engine.
      engine: step.kind === 'mysql' ? 'mysql' : 'postgres',
      configName: step.configName,
      serviceId,
      account: { ...accessOf(account), cloudAccountId: account.cloudAccountId },
      region,
      environmentId,
      stateId,
      network: saved ?? standIn!.ids,
      version: database.version,
      settings: {
        ...RDS_POSTGRES_DEFAULTS,
        instanceClass: database.size.instanceClass,
      },
      login: {
        ...database.login,
        password: randomBytes(24).toString('hex'),
      },
      finalSnapshot: {
        ...(await snapshotNames(this.db, environmentId)),
        date: snapshotDate(new Date()),
      },
      // Its entry's `native.aws`, laid as its Cloud run will lay it.
      native: database.native,
    });
    return this.plan(
      planning,
      false,
      {
        stateId,
        credential: planning.credential,
        definition: generated.definition,
        variables: generated.variables,
        signal: control.signal,
      },
      {
        serviceName: step.configName,
        ...(database.size.name === null
          ? { noSize: database.size.smallest }
          : { sizeName: database.size.name }),
        // A class its `native.aws` sets wins over the size.
        ...(database.size.native ? { nativeMachine: true } : {}),
        ...(standIn ? { standIns: standIn.standIns } : {}),
      },
      { serviceId },
    );
  }

  /**
   * A Compose stack's Stack VM create (ADR-0070): its definition, written
   * as its Apply will write it, against a new state, in the Environment
   * network's private subnets — or their stand-ins while the same plan
   * makes the network. A new Stack VM reads the region's Ubuntu image;
   * the Apply records the one it was made from.
   */
  private async readStackVm(
    planning: Planning,
    step: StackVmCreate,
    control: CloudRunControl,
    kept: KeptIds,
  ): Promise<CloudRead> {
    const { environmentId, region, account } = planning;
    const stateId = kept.stateId ?? nanoid();
    const serviceId =
      kept.serviceId ??
      // A console-made stack's Stack VM is made for the row it has (#1372).
      step.stackVm.consoleStackId ??
      nanoid();
    const saved = await savedDatabaseNetwork(this.db, {
      environmentId,
      cloudAccountId: account.cloudAccountId,
      region,
    });
    const standIn = saved
      ? null
      : databaseNetworkStandIns(region, account.cloudId);
    const { stackVm } = step;
    const generated = stackVmDefinition({
      configName: step.configName,
      serviceId,
      account: { ...accessOf(account), cloudAccountId: account.cloudAccountId },
      region,
      environmentId,
      stateId,
      network: saved ?? standIn!.ids,
      machineType: stackVm.size.machineType,
      dataDiskGb: stackVm.dataDiskGb,
      snapshotDays: stackVm.snapshotDays,
      imageId: null,
      zone: null,
      pins: stackVmPinsOn('aws'),
      native: stackVm.native,
      // The stack and its SSH key are made by the Apply, after this read;
      // only the first boot's text differs, never what is made.
      sshPublicKey: null,
    });
    return this.plan(
      planning,
      false,
      {
        stateId,
        credential: planning.credential,
        definition: generated.definition,
        signal: control.signal,
      },
      {
        serviceName: step.configName,
        ...(standIn ? { standIns: standIn.standIns } : {}),
      },
      { serviceId },
    );
  }

  /**
   * A change to a Compose stack's Stack VM, or its read for Drift
   * (#1368): its definition as the Apply's Cloud run will write it — the
   * machine type, data disk and cloud block the change moves to, the image,
   * zone and pins it was made with, or on an approved "replace VM" the
   * new pins, planned with `-replace` — against the stack's own state.
   * A plan that would shrink its data disk, as one grown by hand in AWS
   * reads, fails the read, naming the size it is: a data disk only grows.
   */
  private async readStackVmChange(
    planning: Planning,
    step: Change & { readonly stackVm: NonNullable<Change['stackVm']> },
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const { environmentId, region, account } = planning;
    const [row] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, step.serviceId));
    if (!row?.stackVm) {
      return failed(`${step.configName} has no Stack VM`);
    }
    const state = await this.states.findForCompose(step.serviceId);
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await savedDatabaseNetwork(this.db, {
      environmentId,
      cloudAccountId: account.cloudAccountId,
      region,
    });
    if (!network) {
      return failed(
        `${step.configName}'s Environment network in ${region} is not made`,
      );
    }
    const written = stackVmWritten(
      stackVmSettingsAfter(row.stackVm, step.stackVm),
      'aws',
    );
    const generated = stackVmDefinition({
      configName: step.configName,
      serviceId: step.serviceId,
      account: { ...accessOf(account), cloudAccountId: account.cloudAccountId },
      region,
      environmentId,
      stateId: state.infrastructureStateId,
      network,
      machineType: written.machineType,
      dataDiskGb: written.dataDiskGb,
      snapshotDays: written.snapshotDays,
      imageId: written.imageId,
      zone: written.zone,
      pins: written.pins,
      native: step.stackVm.native,
      // Its first boot is never changed in place, so a read leaves the
      // key out: what its run writes differs only there.
      sshPublicKey: null,
      // As its run writes them, so the plan shows its Domains kept.
      ...(await awsStackVmDomainPieces(this.db, {
        composeId: step.serviceId,
        environmentId,
        cloudAccountId: account.cloudAccountId,
        region,
      })),
    });
    return this.plan(
      planning,
      true,
      {
        stateId: state.infrastructureStateId,
        credential: planning.credential,
        definition: generated.definition,
        ...(written.replace ? { replaces: [STACK_VM_INSTANCE_ADDRESS] } : {}),
        signal: control.signal,
      },
      { serviceName: step.configName },
      { serviceId: step.serviceId },
      (show) => dataDiskRefusal(step.configName, show, 'aws_ebs_volume'),
    );
  }

  /**
   * A bucket on S3: its definition — the bucket, its settings and its
   * CORS — against a new state for a create, under the real name the plan
   * minted and with no origin trusted yet; or against its own state for one
   * that exists, with the origins its page holds now, so what differs is
   * its CORS change or Drift. A bucket sits in no Environment network.
   */
  private async readBucket(
    planning: Planning,
    step: Create | Change,
    control: CloudRunControl,
    kept: KeptIds,
  ): Promise<CloudRead> {
    let made: {
      stateId: string;
      serviceId: string;
      bucketName: string;
      origins: readonly string[];
      existing: boolean;
      native: NativeAwsBlock | null;
    };
    if (step.action === 'create') {
      if (!step.bucket) {
        return failed(
          `${step.configName} was planned without its bucket's real name; plan again`,
        );
      }
      made = {
        stateId: kept.stateId ?? nanoid(),
        serviceId: kept.serviceId ?? nanoid(),
        bucketName: step.bucket.name,
        origins: [],
        existing: false,
        native: step.nativeAws ?? null,
      };
    } else {
      const [row] = await this.db
        .select({
          bucketName: bucket.bucketName,
          origins: bucket.origins,
          nativeAws: bucket.nativeAws,
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
        native: nativeOf(step, row.nativeAws),
      };
    }
    return refusingNativeReplace(
      step.configName,
      made.native,
      await this.plan(
        planning,
        made.existing,
        {
          stateId: made.stateId,
          credential: planning.credential,
          definition: bucketDefinition({
            configName: step.configName,
            bucketName: made.bucketName,
            account: {
              ...accessOf(planning.account),
              cloudAccountId: planning.account.cloudAccountId,
            },
            region: planning.region,
            environmentId: planning.environmentId,
            stateId: made.stateId,
            origins: made.origins,
            // The block the plan gives it, or its last Apply's.
            native: made.native,
          }),
          signal: control.signal,
        },
        { serviceName: step.configName },
        { serviceId: made.serviceId },
      ),
    );
  }

  /**
   * A `redis` create's read: its ElastiCache definition, written as
   * its Apply will write it, against a new state. Its AUTH token does not
   * exist until its create, so the read plans with a throwaway one; it is a
   * `sensitive` variable, which no plan line shows.
   */
  private async readRedis(
    planning: Planning,
    step: RedisCreate,
    control: CloudRunControl,
    kept: KeptIds,
  ): Promise<CloudRead> {
    const { environmentId, region, account } = planning;
    const stateId = kept.stateId ?? nanoid();
    const serviceId = kept.serviceId ?? nanoid();
    const saved = await savedDatabaseNetwork(this.db, {
      environmentId,
      cloudAccountId: account.cloudAccountId,
      region,
    });
    const standIn = saved
      ? null
      : databaseNetworkStandIns(region, account.cloudId);
    const { cache } = step;
    const generated = redisDefinition({
      configName: step.configName,
      serviceId,
      account: { ...accessOf(account), cloudAccountId: account.cloudAccountId },
      region,
      environmentId,
      stateId,
      network: saved ?? standIn!.ids,
      version: cache.version,
      settings: {
        ...ELASTICACHE_REDIS_DEFAULTS,
        nodeType: cache.size.nodeType,
      },
      authToken: randomBytes(32).toString('hex'),
      finalSnapshot: {
        ...(await snapshotNames(this.db, environmentId)),
        date: snapshotDate(new Date()),
      },
      // Its entry's `native.aws`, laid as its Cloud run will lay it.
      native: cache.native,
    });
    return this.plan(
      planning,
      false,
      {
        stateId,
        credential: planning.credential,
        definition: generated.definition,
        variables: generated.variables,
        signal: control.signal,
      },
      {
        serviceName: step.configName,
        ...(cache.size.name === null
          ? { noSize: cache.size.smallest }
          : { sizeName: cache.size.name }),
        // A node type its `native.aws` sets wins over the size.
        ...(cache.size.native ? { nativeMachine: true } : {}),
        ...(standIn ? { standIns: standIn.standIns } : {}),
      },
      { serviceId },
    );
  }

  /**
   * A `static` site on S3 + CloudFront: its definition — its own
   * bucket, the OAC, the bucket policy, the function and the distribution —
   * against a new state for a create, under the bucket name the plan
   * minted; or against its own state for one that exists, with the `spa`
   * the plan gives it (or the one it has, on a read for Drift), so what
   * differs is that change or Drift. It sits in no Environment network.
   */
  private async readStatic(
    planning: Planning,
    step: Create | Change,
    control: CloudRunControl,
    kept: KeptIds,
  ): Promise<CloudRead> {
    let made: {
      stateId: string;
      serviceId: string;
      bucketName: string;
      spa: boolean;
      liveFolder: string | null;
      existing: boolean;
      native: NativeAwsBlock | null;
    };
    if (step.action === 'create') {
      if (!step.bucket) {
        return failed(
          `${step.configName} was planned without its bucket's real name; plan again`,
        );
      }
      made = {
        stateId: kept.stateId ?? nanoid(),
        serviceId: kept.serviceId ?? nanoid(),
        bucketName: step.bucket.name,
        spa: step.site?.spa ?? false,
        liveFolder: null,
        existing: false,
        native: step.nativeAws ?? null,
      };
    } else {
      const app = await this.applications.findDeployable(step.serviceId);
      const state = await this.states.findForApplication(step.serviceId);
      if (!state || !app.cloudBucketName) {
        return failed(`${step.configName} has no Infrastructure state`);
      }
      made = {
        stateId: state.infrastructureStateId,
        serviceId: step.serviceId,
        bucketName: app.cloudBucketName,
        spa: step.site?.spa ?? app.isStaticSpa ?? false,
        liveFolder: app.cloudLiveFolder,
        existing: true,
        native: nativeOf(step, app.nativeAws),
      };
    }
    const read = await this.plan(
      planning,
      made.existing,
      {
        stateId: made.stateId,
        credential: planning.credential,
        definition: staticDefinition({
          configName: step.configName,
          serviceId: made.serviceId,
          bucketName: made.bucketName,
          spa: made.spa,
          account: {
            ...accessOf(planning.account),
            cloudAccountId: planning.account.cloudAccountId,
          },
          region: planning.region,
          environmentId: planning.environmentId,
          stateId: made.stateId,
          // The origin path is the live folder its deploys switched to, so
          // a deploy is no change and the rest of the origin is Drift.
          liveFolder: made.liveFolder,
          // Its Domain is the Domain runs': never a plan's change.
          domains: made.existing
            ? await deployedDomains(this.db, made.serviceId)
            : [],
          // The block the plan gives it, or its last Apply's.
          native: made.native,
        }),
        signal: control.signal,
      },
      { serviceName: step.configName },
      { serviceId: made.serviceId },
    );
    return refusingNativeReplace(step.configName, made.native, read);
  }

  /**
   * A cloud Service that exists, against its own state: its
   * definition as its next deploy would write it — the config the plan
   * gives it, or the one it has, with its live image, variables, Domains and
   * running count — so what the plan shows besides the config's change is
   * Drift, a resource deleted by hand, or one a state lost (adopt).
   */
  private async readService(
    planning: Planning,
    step: Change,
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const app = await this.applications.findDeployable(step.serviceId);
    const state = await this.states.findForApplication(step.serviceId);
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await this.networkIds(planning);
    const live = await liveImageOf(this.db, step.serviceId);
    // The links the plan gives it, or the ones it has.
    const links = step.cloud ? step.cloud.links : app.configLinks;
    const values = {
      ...getEnvironmentVariablesObject(
        app.env,
        app.environment.project.env,
        app.environment.env,
      ),
      ...(await this.plannedWired(planning, links)),
    };
    // Shaped and routed by the kind it runs as, as its deploy writes it.
    const generated = ecsDefinitionOf(
      app.configKind,
      {
        configName: app.configName ?? app.appName,
        entry: step.cloud ? entryOf(step.cloud.service) : webEntryOf(app),
        service: { serviceId: step.serviceId, replicas: app.replicas },
        account: webAccountOf(planning.account),
        region: planning.region,
        environmentId: planning.environmentId,
        stateId: state.infrastructureStateId,
        network: network.ids,
        image: live ?? { tag: STAND_IN_IMAGE_TAG, architecture: 'amd64' },
        variables: { values, digestSecret: this.digestSecret() },
        buckets: await this.plannedBucketAccess(planning, links),
        // The `native.aws` the plan gives it, or the one its last Apply
        // laid: so its cloud lines show the native values, and a
        // hand change to one reads as Drift against the merged definition.
        native: step.cloud ? step.cloud.native : app.nativeAws,
      },
      {
        port: step.cloud ? step.cloud.service.port : app.port,
        domains:
          app.configKind === 'cron'
            ? []
            : await deployedDomains(this.db, step.serviceId),
      },
    );
    if (!generated.ok) return failed(generated.refusal.message);
    const read = await this.plan(
      planning,
      true,
      {
        stateId: state.infrastructureStateId,
        credential: planning.credential,
        definition: generated.definition,
        variables: generated.variables,
        signal: control.signal,
      },
      {
        serviceName: step.configName,
        ...(step.cloud?.size.name ? { sizeName: step.cloud.size.name } : {}),
        ...nativePairOf(step.cloud ? step.cloud.native : app.nativeAws),
        variableNames: Object.keys(values).filter((name) => values[name]),
        ...(network.standIns ? { standIns: network.standIns } : {}),
      },
      { serviceId: step.serviceId },
    );
    return read.status === 'read'
      ? { ...read, liveImage: live?.tag ?? null }
      : read;
  }

  /**
   * A cloud Service's wired variables as its next deploy will write them
   * built from their sources where they are made, so a read of a
   * Service that exists digests what its deploy will; a stand-in where a
   * source is not made yet, so the parameter is still in the plan.
   */
  private plannedWired(
    planning: Planning,
    links: ConfigLinks | null | undefined,
  ): Promise<Record<string, string>> {
    return wiredEnv(this.db, planning.environmentId, links, {
      standIns: {
        region: planning.region,
        kinds: planning.creates,
        buckets: planning.plannedBuckets,
      },
    });
  }

  /**
   * The buckets on S3 a cloud Service's task role will reach, as its next
   * deploy writes them: one the plan creates by the name it minted.
   */
  private plannedBucketAccess(
    planning: Planning,
    links: ConfigLinks | null | undefined,
  ): Promise<string[]> {
    return linkedS3Buckets(
      this.db,
      planning.environmentId,
      links,
      planning.plannedBuckets,
    );
  }

  /**
   * A change to a postgres or a mysql on RDS read from its own
   * state: its
   * definition as the Apply's Cloud run will write it — the class and
   * version the change moves to, the console's settings as they are now,
   * the major upgrade allowed when the step has one — planned against the
   * state that holds the instance, so the lines and outage marks are what
   * AWS will do. A version older than the one the state says it runs fails
   * the read, naming it: RDS cannot go back.
   */
  async readPostgresChange(
    step: Change & {
      readonly database: NonNullable<Change['database']>;
    },
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const kind = step.serviceType === 'mysql' ? 'mysql' : 'postgres';
    const engine = RDS_ENGINES[kind];
    const row = await findRdsRow(this.db, kind, step.serviceId);
    if (!row?.cloudAccountId || !row.region) {
      return failed(`${step.configName} does not run in a Cloud account`);
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      row.cloudAccountId,
    );
    if (!cloudAccountRow) {
      return failed(
        `The Cloud account ${step.configName} runs in is gone, so its instance cannot be read`,
      );
    }
    const onAws = awsAccountOf(cloudAccountRow);
    if (!onAws.ok) {
      return failed(onAws.refusal);
    }
    const account = onAws.account;
    const credential = credentialOf(account);
    const refused = await this.credentialRefusal(account, credential);
    if (refused) return failed(refused);
    const state = await this.rdsStateOf(kind, rdsIdOf(row));
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await savedDatabaseNetwork(this.db, {
      environmentId: row.environmentId,
      cloudAccountId: row.cloudAccountId,
      region: row.region,
    });
    if (!network) {
      return failed(
        `The Environment network in ${row.region} is not made, so ${step.configName} cannot be read`,
      );
    }
    const { database } = step;
    const written = await savedRdsDatabaseDefinition(this.db, {
      row,
      account,
      stateId: state.infrastructureStateId,
      network,
      instanceClass:
        database.instanceClass?.to ??
        rdsClassOf(step.configName, {
          instanceClass: row.rdsApplied?.instanceClass ?? row.instanceClass,
          cpuLimit: row.cpuLimit,
          memoryLimit: row.memoryLimit,
        }) ??
        undefined,
      ...(database.version ? { version: database.version } : {}),
      allowMajorUpgrade: step.majorUpgrade !== undefined,
      // The `native.aws` the change lays, before its Apply saves it.
      ...(database.native !== undefined ? { native: database.native } : {}),
    });
    if (!written.ok) return failed(written.message);

    const outcome = await this.states.plan({
      stateId: state.infrastructureStateId,
      credential,
      definition: written.generated.definition,
      variables: written.generated.variables,
      signal: control.signal,
    });
    if (!outcome.ok) return failed(outcome.message);
    const running = runningPostgresVersion(outcome.show);
    const asked = database.version?.engineVersion;
    if (
      running &&
      asked &&
      (engine.majorOf(asked) ?? 0) < (engine.majorOf(running) ?? 0)
    ) {
      return failed(
        `${step.configName}.version: "${database.version.to}" is older than ${engine.label} ${running}, which ${step.configName} runs on RDS, and RDS cannot move an instance back to an older major version`,
      );
    }
    const reading = readPlan({
      show: outcome.show,
      tagSearch: [],
      context: {
        serviceName: step.configName,
        ...(database.instanceClass?.sizeName
          ? { sizeName: database.instanceClass.sizeName }
          : {}),
        ...(database.instanceClass?.native ? { nativeMachine: true } : {}),
      },
    });
    // A native change AWS would carry out as a replace: the block
    // the change lays, none when it moves no native value.
    const replaced = nativeAwsReplaceRefusals(
      step.configName,
      database.native,
      reading.raw,
    );
    if (replaced.length > 0) {
      return failed(replaced.map((one) => one.message).join('; '));
    }
    return {
      status: 'read',
      ...reading,
      stateId: state.infrastructureStateId,
      serviceId: rdsIdOf(row),
      readAt: new Date().toISOString(),
    };
  }

  /** The state a postgres or a mysql on RDS owns. */
  private rdsStateOf(kind: RdsEngineName, id: string) {
    return findRdsState(this.states, kind, id);
  }

  /**
   * A change to a redis on ElastiCache read from its own state, as a
   * postgres on RDS's is: its definition as the Apply's Cloud run will write
   * it — the node type and Valkey the change moves to, the console's replica
   * and snapshot retention as they are now — planned against the state that
   * holds the replication group, so the lines and outage marks are what AWS
   * will do. A version older than the one the state says it runs fails the
   * read, naming it: ElastiCache cannot go back.
   */
  async readRedisChange(
    step: Change & { readonly cache: NonNullable<Change['cache']> },
    control: CloudRunControl,
  ): Promise<CloudRead> {
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, step.serviceId));
    if (!row?.cloudAccountId || !row.region) {
      return failed(`${step.configName} does not run in a Cloud account`);
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      row.cloudAccountId,
    );
    if (!cloudAccountRow) {
      return failed(
        `The Cloud account ${step.configName} runs in is gone, so its replication group cannot be read`,
      );
    }
    const onAws = awsAccountOf(cloudAccountRow);
    if (!onAws.ok) {
      return failed(onAws.refusal);
    }
    const account = onAws.account;
    const credential = credentialOf(account);
    const refused = await this.credentialRefusal(account, credential);
    if (refused) return failed(refused);
    const state = await this.states.findForRedis(row.redisId);
    if (!state) return failed(`${step.configName} has no Infrastructure state`);
    const network = await savedDatabaseNetwork(this.db, {
      environmentId: row.environmentId,
      cloudAccountId: row.cloudAccountId,
      region: row.region,
    });
    if (!network) {
      return failed(
        `The Environment network in ${row.region} is not made, so ${step.configName} cannot be read`,
      );
    }
    const { cache } = step;
    const written = await savedRedisDefinition(this.db, {
      row,
      account,
      stateId: state.infrastructureStateId,
      network,
      nodeType:
        cache.nodeType?.to ??
        elastiCacheNodeTypeOf(step.configName, {
          nodeType: row.elasticacheApplied?.nodeType ?? row.nodeType,
          cpuLimit: row.cpuLimit,
          memoryLimit: row.memoryLimit,
        }) ??
        undefined,
      ...(cache.version ? { version: cache.version } : {}),
      // The `native.aws` the change lays, before its Apply saves it.
      ...(cache.native !== undefined ? { native: cache.native } : {}),
    });
    if (!written.ok) return failed(written.message);

    const outcome = await this.states.plan({
      stateId: state.infrastructureStateId,
      credential,
      definition: written.generated.definition,
      variables: written.generated.variables,
      signal: control.signal,
    });
    if (!outcome.ok) return failed(outcome.message);
    const running = runningValkeyVersion(outcome.show);
    const asked = cache.version?.engineVersion;
    if (running && asked && olderValkey(asked, running)) {
      return failed(
        `${step.configName}.version: "${cache.version.to}" is older than Valkey ${running}, which ${step.configName} runs on ElastiCache, and ElastiCache cannot move a cache back to an older version`,
      );
    }
    const reading = readPlan({
      show: outcome.show,
      tagSearch: [],
      context: {
        serviceName: step.configName,
        ...(cache.nodeType?.sizeName
          ? { sizeName: cache.nodeType.sizeName }
          : {}),
        ...(cache.nodeType?.native ? { nativeMachine: true } : {}),
      },
    });
    // A native change AWS would carry out as a replace: the block
    // the change lays, none when it moves no native value.
    const replaced = nativeAwsReplaceRefusals(
      step.configName,
      cache.native,
      reading.raw,
    );
    if (replaced.length > 0) {
      return failed(replaced.map((one) => one.message).join('; '));
    }
    return {
      status: 'read',
      ...reading,
      stateId: state.infrastructureStateId,
      serviceId: row.redisId,
      readAt: new Date().toISOString(),
    };
  }

  private async plan(
    planning: Planning,
    existing: boolean,
    request: Parameters<InfrastructureStatesService['planFresh']>[0],
    context: PlanReadContext,
    ids: { serviceId?: string },
    /** Why the plan it read is refused before it is shown, or `null`. */
    refuse?: (show: TofuShow) => string | null,
  ): Promise<CloudRead> {
    const found = await this.tagSearch(planning);
    if (!found.ok) return failed(found.reason);
    const { ours, strays } = sortFinds(
      found.value,
      request.stateId,
      await this.knownStates(),
    );
    const outcome = existing
      ? await this.states.plan(request)
      : await this.states.planFresh(request);
    if (!outcome.ok) return failed(outcome.message);
    const refused = refuse?.(outcome.show) ?? null;
    if (refused) return failed(refused);
    const read = await this.readWith(
      planning,
      outcome.show,
      request.stateId,
      ours,
      context,
    );
    if (!read.ok) return failed(read.reason);
    const reading = read.reading;
    const noState: NoStateNote[] = planning.notesStrays
      ? withStrays(reading.noState, strays)
      : reading.noState;
    return {
      status: 'read',
      ...reading,
      noState,
      summary: reading.summary.map(newImageLine),
      stateId: request.stateId,
      ...ids,
      readAt: new Date().toISOString(),
    };
  }

  /** A plan read with what the state's tag search and role lookups found. */
  private async readWith(
    planning: Pick<Planning, 'session'>,
    show: TofuShow,
    stateId: string,
    ours: readonly TaggedResource[],
    context: PlanReadContext,
  ): Promise<
    { ok: true; reading: PlanReading } | { ok: false; reason: string }
  > {
    const roles = await this.rolesByName(planning, show, stateId);
    if (!roles.ok) return roles;
    const reading = readPlan({
      show,
      // A role found by name implies what is made with it (a Stack
      // VM's instance profile and policy attachments) as a tag find does.
      tagSearch: [
        ...ours,
        ...joinedToCreate(show, [...ours, ...roles.value], stateId),
        ...roles.value,
      ],
      context,
    });
    return {
      ok: true,
      reading: {
        ...reading,
        adopt: withNamespaceImportIds(reading.adopt, ours),
      },
    };
  }

  /**
   * A deploy's own plan read again with the state's tag search (the AWS spec
   * "Recovery by tag": every plan searches by the state's tag), for the
   * plan a stopped deploy opens: what a lost or restored state would make
   * twice reads as adopt there, and its Apply imports it.
   */
  async readFound(
    place: {
      session: AwsCredential;
      region: string;
      environmentId: string;
      account: AwsCloudAccount;
    },
    show: TofuShow,
    stateId: string,
    context: PlanReadContext,
  ): Promise<
    { ok: true; reading: PlanReading } | { ok: false; reason: string }
  > {
    const found = await this.tagSearch(place);
    if (!found.ok) return found;
    const { ours } = sortFinds(found.value, stateId, await this.knownStates());
    return this.readWith(place, show, stateId, ours, context);
  }

  /**
   * What carries this Environment's and Cloud account's tags in the region
   * one search for every state of the place.
   */
  private async tagSearch(
    planning: Pick<
      Planning,
      'session' | 'region' | 'environmentId' | 'account'
    >,
  ): Promise<
    { ok: true; value: TaggedResource[] } | { ok: false; reason: string }
  > {
    try {
      const answer = await this.cloud.findTagged(planning.session, {
        region: planning.region,
        tags: {
          [TAG_KEYS.environment]: planning.environmentId,
          [TAG_KEYS.cloudAccount]: planning.account.cloudAccountId,
        },
      });
      if (answer.ok) return answer;
      return {
        ok: false,
        reason: `AWS refused the search for what Cloudgate's tags mark: ${answer.code}: ${answer.message}`,
      };
    } catch (error) {
      return {
        ok: false,
        reason: `AWS could not be reached for the search by tag: ${describeError(error)}. Check for changes to read it again`,
      };
    }
  }

  /**
   * The IAM roles the plan would create that exist already, looked up by
   * name since no tag search sees a role (ADR-0036 §6): what a lost or
   * rebuilt state adopts rather than failing on `EntityAlreadyExists`.
   */
  private async rolesByName(
    planning: Pick<Planning, 'session'>,
    show: TofuShow,
    stateId: string,
  ): Promise<
    { ok: true; value: TaggedResource[] } | { ok: false; reason: string }
  > {
    const value: TaggedResource[] = [];
    for (const { address, name } of rolesToCreate(show)) {
      try {
        const role = await this.cloud.findIamRole(planning.session, name);
        if (!role.ok) {
          return {
            ok: false,
            reason: `AWS refused the check of IAM role ${name}: ${role.code}: ${role.message}`,
          };
        }
        if (role.value) value.push(roleFind(address, role.value.arn, stateId));
      } catch (error) {
        return {
          ok: false,
          reason: `AWS could not be reached for the check of IAM role ${name}: ${describeError(error)}. Check for changes to read it again`,
        };
      }
    }
    return { ok: true, value };
  }

  /** Every Infrastructure state Cloudgate has a record of. */
  private async knownStates(): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: infrastructureState.infrastructureStateId })
      .from(infrastructureState);
    return new Set(rows.map((row) => row.id));
  }

  private digestSecret(): string {
    return this.config.get('APP_ENCRYPTION_SECRET', { infer: true });
  }

  /**
   * Whether the Cloud account's key still takes on its deploy role. A
   * refusal is recorded on the Cloud account and fails the read
   * before `tofu` runs, naming the Cloud account and AWS's own words.
   */
  async credentialRefusal(
    account: AwsCloudAccount,
    credential: AwsCredential,
  ): Promise<string | null> {
    const session = await this.cloudAccounts.deployRoleSession(
      account,
      credential,
    );
    return session.ok ? null : session.refusal;
  }

  /**
   * The network ids a Service's definition is written with: the Environment
   * network's saved ones, or stand-ins while it is not made yet,
   * which the plan shows as "made by this plan (Environment network)".
   */
  private async networkIds({
    environmentId,
    account,
    region,
  }: Planning): Promise<{ ids: NetworkIds; standIns: string[] | null }> {
    const [saved] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, environmentId),
          eq(environmentNetwork.cloudAccountId, account.cloudAccountId),
          eq(environmentNetwork.region, region),
          eq(environmentNetwork.status, 'ready'),
          isNotNull(environmentNetwork.vpcId),
          isNotNull(environmentNetwork.publicSubnetIds),
          isNotNull(environmentNetwork.clusterArn),
          isNotNull(environmentNetwork.httpsListenerArn),
          isNotNull(environmentNetwork.albSecurityGroupId),
        ),
      );
    if (saved) {
      // A namespace this same plan adds to the made network is a
      // stand-in until its Apply saves it, as a new network's ids are.
      const namespace = saved.privateDnsNamespaceId;
      return {
        ids: {
          vpcId: saved.vpcId!,
          publicSubnetIds: saved.publicSubnetIds!,
          clusterArn: saved.clusterArn!,
          httpsListenerArn: saved.httpsListenerArn!,
          albSecurityGroupId: saved.albSecurityGroupId!,
          privateDnsNamespaceId: namespace ?? PRIVATE_DNS_NAMESPACE_STAND_IN,
        },
        standIns: namespace ? null : [PRIVATE_DNS_NAMESPACE_STAND_IN],
      };
    }
    const ids = networkStandIns(region, account.cloudId);
    return {
      ids,
      // Each whole stand-in first, then the marker any other carries.
      standIns: [
        ids.vpcId,
        ...ids.publicSubnetIds,
        ids.clusterArn,
        ids.httpsListenerArn,
        ids.albSecurityGroupId,
        PRIVATE_DNS_NAMESPACE_STAND_IN,
        STAND_IN_MARKER,
      ],
    };
  }
}

function accessOf(account: AwsCloudAccount) {
  return {
    awsAccountId: account.cloudId,
    deployRoleArn: account.deployRoleArn,
    externalId: account.externalId,
  };
}

function webAccountOf(account: AwsCloudAccount) {
  return {
    ...accessOf(account),
    cloudAccountId: account.cloudAccountId,
    taskExecutionRoleArn: account.taskExecutionRoleArn,
    permissionsBoundaryArn: setupNames({
      accountId: account.cloudId,
      tagValue: account.cloudAccountId,
    }).boundaryPolicyArn,
  };
}

/** A planned `web`'s config as the definition is written from it. */
function entryOf(
  service: NonNullable<Create['cloud']>['service'],
): EcsServiceEntry {
  return {
    ...(service.command === null ? {} : { command: service.command }),
    args: service.args,
    ...(service.size === null ? {} : { size: service.size }),
  };
}

/**
 * The halves of a task's Fargate pair its `native.aws` sets, so its
 * ECS service line marks each; nothing when it sets neither.
 */
function nativePairOf(block: NativeAwsBlock | null | undefined): {
  readonly nativePair?: { readonly cpu: boolean; readonly memory: boolean };
} {
  const laid = nativeFargateOf(block);
  const cpu = laid.cpuUnits !== undefined;
  const memory = laid.memoryMb !== undefined;
  return cpu || memory ? { nativePair: { cpu, memory } } : {};
}

/**
 * A created Service's task definition always runs the image its first
 * deploy builds (the AWS spec, "Plan behaviour"): before that build its repository
 * does not exist, so `tofu` cannot know the image's address and the reader
 * cannot match it. Its line says so.
 */
function newImageLine(line: string): string {
  return /^Task definition: create(, image `[^`]*`)?$/.test(line)
    ? 'Task definition: create, new image, built by this deploy'
    : line;
}

/**
 * The `native.aws` a bucket's or a static site's read lays: the
 * block its step carries once it plans a native line (`null` for none), or
 * else the one its last Apply laid, so a read for Drift compares AWS with
 * the merged definition.
 */
function nativeOf(
  step: Create | Change,
  stored: NativeAwsBlock | null,
): NativeAwsBlock | null {
  return 'nativeAws' in step && step.nativeAws !== undefined
    ? step.nativeAws
    : stored;
}

/**
 * A read whose plan carries out a native change as a replace of what holds
 * data fails naming each native path, so its Apply is
 * refused: native never loses a bucket's files.
 */
function refusingNativeReplace(
  configName: string,
  native: NativeAwsBlock | null,
  read: CloudRead,
): CloudRead {
  if (read.status !== 'read') return read;
  const refused = nativeAwsReplaceRefusals(configName, native, read.raw);
  return refused.length === 0
    ? read
    : failed(refused.map((one) => one.message).join('; '));
}
