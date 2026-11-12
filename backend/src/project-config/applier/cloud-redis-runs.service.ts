import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import {
  REDIS_OUTPUTS,
  REDIS_PORT,
} from '../../cloud-accounts/aws/definitions/redis-definition';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import {
  MEMORYSTORE_OUTPUTS,
  MEMORYSTORE_PORT,
} from '../../cloud-accounts/gcp/definitions/memorystore-definition';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { DatabaseStatus } from '../../databases/common/database-service';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, existingDatabase, redis } from '../../db/schema';
import type {
  Deployment,
  ExistingDatabase,
  ExistingEndpoint,
  Redis,
} from '../../db/schema';
import {
  EXISTING_VALKEY_OUTPUTS,
  existingValkeyDefinition,
  existingValkeyEndpointName,
  VALKEY_ENDPOINTS,
} from '../../cloud-accounts/gcp/definitions/existing-valkey-definition';
import { GOOGLE_CLOUD_PORT } from '../../cloud-accounts/google-cloud.port';
import type { GoogleCloudPort } from '../../cloud-accounts/google-cloud.port';
import {
  lookUpValkey,
  saveRegistration,
  valkeyRegistrationView,
  WAITING_FOR_REGISTRATION,
} from '../existing-valkey-status';
import { savedMemorystoreDefinition } from '../memorystore-places';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { savedRedisDefinition } from '../elasticache-redis-places';
import { blameNativeAws, storedNativeAwsRefusal } from '../../native/aws-lay';
import { blameNativeGcp, storedNativeGcpRefusal } from '../../native/gcp-lay';
import { parameterFamilyOf } from '../../native/aws-native';
import { describeError } from '../../common/describe-error';
import { savedDatabaseNetwork } from '../rds-postgres-places';
import type { PlanStepDeploy } from './apply.types';
import { approvedOnPlan, beforeApplyingApproved } from './approved-run';
import type { ApprovedRun } from './approved-run';
import { applyGoogleDatabase } from './google-database-apply';

/** What makes a cloud redis, as its Deployment's title names it. */
type CacheProduct = 'ElastiCache' | 'Memorystore';

/**
 * **A redis on ElastiCache is made by a Cloud run** (the AWS databases spec
 * "OpenTofu generation for a redis on AWS"), as a postgres on RDS is
 * (`CloudPostgresRuns`).
 *
 * An Apply that creates a cloud `redis` writes its row (its Cloud account,
 * region, Cloudgate's settings and its generated AUTH token), keeps the
 * Infrastructure state its plan read against, and records the run as a
 * Deployment whose parent is the redis (ADR-0017 extended), its log on the
 * platform host. The run waits in the Cloud run pool as a `cache` run,
 * behind the Environment network's when the same Apply makes it.
 *
 * The run writes the definition from the saved row — the token reaching
 * `tofu` as a sensitive variable only — reads AWS again, and applies only
 * if that plan makes what the Apply approved (the AWS spec "Cloud run"). It
 * then saves where the replication group answers, which the Services
 * linking to it are filled in from. The redis's status follows the run.
 *
 * **A change is the same run**: an Apply that moves the replication
 * group (its node type, version or Cloudgate's settings) records a run that
 * writes the definition from the row the Apply just saved, so it writes
 * what the plan's read wrote.
 *
 * **On Google Cloud the same run makes a Memorystore instance**:
 * the Cloud account's own 2-hour proof, the Memorystore definition from the
 * row, Google read again before the apply, and where the instance answers
 * and its own CA saved (encrypted). It has no password to read (ADR-0042): only
 * its Environment's private network reaches it, over TLS.
 *
 * What it does is read from the Deployment row and the plan whose Apply
 * recorded it, so a run start-up queues again runs alike.
 */
@Injectable()
export class CloudRedisRuns implements OnModuleInit {
  private readonly logger = new Logger(CloudRedisRuns.name);
  /** What each Apply approved for the run it recorded, until the run reads it. */
  private readonly approved = new Map<string, ApprovedRun>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('cache', (job, control) => this.run(job, control));
  }

  /**
   * The create's or change's run, recorded and submitted to the pool: the
   * step's result names its Deployment. Answers once the run waits, not
   * once it ends.
   */
  async start(
    created: { redisId: string; appName: string; name: string },
    environmentId: string,
    approved: PlanReading & { readonly stateId: string },
    change = false,
    product: CacheProduct = 'ElastiCache',
    /** The Deployment's title in place of the product's: an existing Valkey's endpoints. */
    title?: string,
  ): Promise<PlanStepDeploy> {
    const record = await this.deployments.recordRedisCloudRun({
      redisId: created.redisId,
      appName: created.appName,
      title:
        title ??
        `${change ? 'Change' : 'Create'} ${created.name} on ${product}`,
      description: `Applied from a plan, into Infrastructure state ${approved.stateId}`,
    });
    this.approved.set(record.deploymentId, { reading: approved, change });
    await this.setStatus(created.redisId, 'running');
    void this.cloudRuns
      .submit(record.deploymentId, {
        kind: 'cache',
        stateKey: `redis:${created.redisId}`,
        environmentId,
        touchesNetwork: false,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Cloud run ${record.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return { status: 'queued', deploymentId: record.deploymentId };
  }

  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.redisId) throw new Error('This Cloud run records no redis');
    try {
      await this.make(row, row.redisId, control);
      await this.setStatus(row.redisId, 'done');
    } catch (error) {
      await this.setStatus(row.redisId, 'error').catch(() => undefined);
      throw error;
    } finally {
      this.approved.delete(row.deploymentId);
    }
  }

  private async make(
    row: Deployment,
    redisId: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const [found] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, redisId));
    if (!found) throw new Error('The redis is gone');
    const name = found.configName ?? found.name;
    // An existing Valkey's endpoints: its place is its existing
    // row's, never the redis row's.
    const [existing] = await this.db
      .select()
      .from(existingDatabase)
      .where(eq(existingDatabase.redisId, redisId));
    if (existing) {
      const existingAccount = await this.cloudAccounts.findForUse(
        existing.cloudAccountId,
      );
      if (!existingAccount) {
        throw new Error(`The Cloud account ${name} is looked up in is gone`);
      }
      await onCloud(existingAccount, {
        aws: () => {
          throw new Error(
            `${name} uses an existing cache on AWS, where Cloudgate makes nothing for it`,
          );
        },
        gcp: (account) =>
          this.makeExistingEndpoints(
            row,
            found,
            existing,
            account,
            control,
            log,
          ),
      });
      return;
    }
    if (!found.cloudAccountId || !found.region) {
      throw new Error(`${name} does not run in a Cloud account`);
    }
    const place = {
      environmentId: found.environmentId,
      cloudAccountId: found.cloudAccountId,
      region: found.region,
    };
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      place.cloudAccountId,
    );
    if (!cloudAccountRow)
      throw new Error('The Cloud account this redis uses is gone');
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) =>
        this.makeOnElastiCache(
          row,
          { found, name, place },
          account,
          control,
          log,
        ),
      gcp: (account) =>
        this.makeOnMemorystore(row, found, account, control, log),
    });
  }

  /** A redis's Cloud run on ElastiCache. */
  private async makeOnElastiCache(
    row: Deployment,
    {
      found,
      name,
      place,
    }: {
      readonly found: Redis;
      readonly name: string;
      readonly place: {
        readonly environmentId: string;
        readonly cloudAccountId: string;
        readonly region: string;
      };
    },
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const redisId = found.redisId;
    const state = await this.states.findForRedis(redisId);
    if (!state) throw new Error(`${name} has no Infrastructure state`);
    const network = await savedDatabaseNetwork(this.db, place);
    if (!network) {
      throw new Error(
        `The Environment network in ${place.region} is not made, so ${name} has no private subnets to sit in`,
      );
    }
    const approved =
      this.approved.get(row.deploymentId) ??
      (await approvedOnPlan(this.db, row.deploymentId, name));
    if (!approved) {
      throw new Error(
        'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
      );
    }

    // Its stored `native.aws`, refused whole, before anything
    // changes, when it now holds a value locked since it was applied.
    const family = parameterFamilyOf(found.dockerImage);
    const refusedNative = storedNativeAwsRefusal(
      name,
      'redis',
      found.nativeAws,
      { linkedKinds: [], ...(family ? { parameterFamily: family } : {}) },
    );
    if (refusedNative) throw new Error(refusedNative);

    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);

    const written = await savedRedisDefinition(this.db, {
      row: found,
      account,
      stateId: state.infrastructureStateId,
      network,
    });
    if (!written.ok) throw new Error(written.message);
    await log(
      `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} ${name} on ElastiCache for Valkey in Cloud account ${account.name} in ${place.region}, Infrastructure state ${state.infrastructureStateId}`,
    );

    await log('Reading AWS again before applying');
    const applied = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: written.generated.definition,
      variables: written.generated.variables,
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: beforeApplyingApproved(approved, log, control),
    });
    // A value only AWS can judge names the native path it refused.
    if (!applied.ok) {
      throw new Error(blameNativeAws(applied.message, found.nativeAws));
    }
    const address = applied.outputs[REDIS_OUTPUTS.address];
    const said = Number(applied.outputs[REDIS_OUTPUTS.port]);
    const port = Number.isInteger(said) && said > 0 ? said : REDIS_PORT;
    if (typeof address === 'string' && address !== '') {
      // Where the Services linking to it reach it (ADR-0031): what their
      // next deploy builds their wired variables from.
      await this.db
        .update(redis)
        .set({ elasticacheEndpoint: { host: address, port } })
        .where(eq(redis.redisId, redisId));
    }
    await log(
      typeof address === 'string' && address !== ''
        ? `${name} is ${approved.change ? 'changed' : 'made'}; it answers at ${address}:${port} inside the Environment network, over TLS`
        : `${name} is ${approved.change ? 'changed' : 'made'}`,
    );
  }

  /**
   * A redis on Memorystore's create or change: the run's own 2-hour
   * proof (S16), the definition from the saved row — its node type and
   * Valkey version — on the made Environment network, applied only if
   * Google read again makes what the Apply approved. Then where the
   * instance answers and its own CA are saved, encrypted; it has no
   * password (ADR-0042).
   */
  private async makeOnMemorystore(
    row: Deployment,
    found: Redis,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const applied = await applyGoogleDatabase(
      { db: this.db, states: this.states, cloudAccounts: this.cloudAccounts },
      {
        found,
        account,
        product: 'Memorystore for Valkey',
        state: () => this.states.findForRedis(found.redisId),
        approved: async (name) =>
          this.approved.get(row.deploymentId) ??
          (await approvedOnPlan(this.db, row.deploymentId, name)),
        write: ({ stateId, network }) => {
          // Its stored `native.gcp`, refused whole, before anything
          // changes, when it now holds a value locked since it was applied.
          const refusedNative = storedNativeGcpRefusal(
            found.configName ?? found.name,
            'redis',
            found.nativeGcp,
          );
          if (refusedNative) return { ok: false, message: refusedNative };
          const written = savedMemorystoreDefinition({
            row: found,
            account,
            stateId,
            network,
          });
          return written.ok ? { ...written, variables: {} } : written;
        },
        control,
        log,
        // A value only Google can judge names the native path it refused.
        blame: (message) => blameNativeGcp(message, found.nativeGcp),
      },
    );
    const { name, text, verb } = applied;
    const host = text(MEMORYSTORE_OUTPUTS.address);
    const ca = text(MEMORYSTORE_OUTPUTS.ca);
    const said = Number(applied.outputs[MEMORYSTORE_OUTPUTS.port]);
    const port = Number.isInteger(said) && said > 0 ? said : MEMORYSTORE_PORT;
    if (!host || !ca) {
      throw new Error(
        `${name} is ${verb}, but Google did not answer its primary endpoint and CA. Check for changes, then apply the new plan`,
      );
    }
    // Where the Services linking to it reach it, and the CA they check it
    // with: what their next deploy builds their variables from.
    await this.db
      .update(redis)
      .set({ memorystoreEndpoint: { host, port, ca } })
      .where(eq(redis.redisId, found.redisId));

    await log(
      `${name} is ${verb}; it answers at ${host}:${port} inside the Environment network, through its private link, over TLS, with no password: only this Environment's network reaches it`,
    );
  }

  /**
   * An existing Valkey's two manual endpoints: the run's own proof
   * (S16), the definition from what the last lookup saved — the instance's
   * two service attachments — on the made Environment network, applied only
   * if Google read again makes what the Apply approved. The instance is
   * never in it. Then each endpoint as made is saved, the primary's address
   * as where the Services linking it reach it, and whether the operator has
   * registered both on the instance is read for the page. Nothing waits on
   * that: until it is registered the log and the page show the one command
   * that does it.
   */
  private async makeExistingEndpoints(
    row: Deployment,
    found: Redis,
    existing: ExistingDatabase,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const attachments = existing.serviceAttachments;
    const applied = await applyGoogleDatabase(
      { db: this.db, states: this.states, cloudAccounts: this.cloudAccounts },
      {
        found: { ...found, region: existing.region },
        account,
        product: `Cloudgate's endpoints to ${existing.identifier}`,
        state: () => this.states.findForRedis(found.redisId),
        approved: async (name) =>
          this.approved.get(row.deploymentId) ??
          (await approvedOnPlan(this.db, row.deploymentId, name)),
        write: ({ stateId }) =>
          attachments
            ? {
                ok: true,
                definition: existingValkeyDefinition({
                  serviceId: found.redisId,
                  cloudAccountId: account.cloudAccountId,
                  projectId: account.cloudId,
                  region: existing.region,
                  environmentId: found.environmentId,
                  stateId,
                  serviceAttachments: attachments,
                }),
                variables: {},
              }
            : {
                ok: false,
                message: `${found.configName ?? found.name}: no plan has found ${existing.identifier} yet. Check for changes, then apply the new plan`,
              },
        control,
        log,
      },
    );
    const { name, text, verb } = applied;
    const endpoints: ExistingEndpoint[] = [];
    for (const endpoint of VALKEY_ENDPOINTS) {
      const outputs = EXISTING_VALKEY_OUTPUTS[endpoint];
      const address = text(outputs.address);
      const said = applied.outputs[outputs.pscConnectionId];
      const pscConnectionId =
        typeof said === 'number' ? String(said) : text(outputs.pscConnectionId);
      if (!address || !pscConnectionId || !attachments) {
        throw new Error(
          `${name}'s endpoints are ${verb}, but Google did not answer the ${endpoint} endpoint's address and connection id. Check for changes, then apply the new plan`,
        );
      }
      endpoints.push({
        endpoint,
        // The name the definition fixed (S4), which the rule was made under.
        name: existingValkeyEndpointName(found.redisId, endpoint),
        address,
        pscConnectionId,
        serviceAttachment: attachments[endpoint],
      });
    }
    const primary = endpoints[0];
    // Where the Services linking it reach it (ADR-0031): its primary's
    // endpoint, inside this Environment's network.
    await this.db
      .update(existingDatabase)
      .set({
        endpoints,
        address: { host: primary.address, port: MEMORYSTORE_PORT },
        notFoundAt: null,
      })
      .where(
        eq(existingDatabase.existingDatabaseId, existing.existingDatabaseId),
      );
    const looked = await lookUpValkey(this.google, applied.token, {
      serviceName: name,
      identifier: existing.identifier,
      projectId: account.cloudId,
    });
    const status =
      looked.ok && looked.lookup.kind === 'found'
        ? await saveRegistration(
            this.db,
            { ...existing, endpoints },
            account.cloudId,
            looked.lookup.instance,
          )
        : null;
    if (status === 'registered') {
      await log(
        `${name} reaches ${existing.identifier} at ${primary.address}:${MEMORYSTORE_PORT} through Cloudgate's endpoints, which ${existing.identifier} lists as registered`,
      );
      return;
    }
    if (status === null) {
      await this.db
        .update(existingDatabase)
        .set({ registrationStatus: 'waiting' })
        .where(
          eq(existingDatabase.existingDatabaseId, existing.existingDatabaseId),
        );
    }
    const [saved] = await this.db
      .select()
      .from(existingDatabase)
      .where(
        eq(existingDatabase.existingDatabaseId, existing.existingDatabaseId),
      );
    const view = saved
      ? valkeyRegistrationView(saved, {
          projectId: account.cloudId,
          environmentId: found.environmentId,
        })
      : null;
    await log(
      `${name}: Cloudgate's endpoints to ${existing.identifier} are ${verb} at ${endpoints.map((one) => one.address).join(' and ')}, ${WAITING_FOR_REGISTRATION}. Register them on the instance once, then Check for changes: ${view?.command ?? ''}`,
    );
  }

  private async setStatus(
    redisId: string,
    status: DatabaseStatus,
  ): Promise<void> {
    await this.db
      .update(redis)
      .set({ applicationStatus: status })
      .where(eq(redis.redisId, redisId));
  }
}
