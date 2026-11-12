import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import { POSTGRES_OUTPUTS } from '../../cloud-accounts/aws/definitions/postgres-definition';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import { CLOUD_SQL_OUTPUTS } from '../../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { CLOUD_SQL_ENGINES } from '../../cloud-accounts/gcp/definitions/cloud-sql-engines';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { DatabaseStatus } from '../../databases/common/database-service';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, existingDatabase } from '../../db/schema';
import type { Deployment, ExistingDatabase } from '../../db/schema';
import { RDS_ENGINES } from '../../cloud-accounts/aws/definitions/rds-engines';
import type { RdsEngineName } from '../../cloud-accounts/aws/definitions/rds-engines';
import {
  findRdsRow,
  findRdsState,
  rdsExistingColumn,
  rdsIdOf,
  rdsKindOf,
  updateRdsRow,
} from '../../databases/common/rds-rows';
import type { RdsOwner, RdsRow } from '../../databases/common/rds-rows';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { savedCloudSqlDefinition } from '../cloud-sql-places';
import { describeError } from '../../common/describe-error';
import { blameNativeAws, storedNativeAwsRefusal } from '../../native/aws-lay';
import { blameNativeGcp, storedNativeGcpRefusal } from '../../native/gcp-lay';
import {
  savedDatabaseNetwork,
  savedRdsDatabaseDefinition,
} from '../rds-postgres-places';
import type { PlanStepDeploy } from './apply.types';
import { approvedOnPlan, beforeApplyingApproved } from './approved-run';
import type { ApprovedRun } from './approved-run';
import { applyGoogleDatabase } from './google-database-apply';
import { existingCloudSqlDefinition } from '../../cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { GOOGLE_CLOUD_PORT } from '../../cloud-accounts/google-cloud.port';
import type { GoogleCloudPort } from '../../cloud-accounts/google-cloud.port';
import {
  ENDPOINT_ACCEPTED,
  endpointSentence,
  readEndpointStatus,
} from '../existing-endpoint-status';

/**
 * **A postgres on RDS is made by a Cloud run** (the AWS databases spec "OpenTofu
 * generation for a postgres on AWS").
 *
 * An Apply that creates a cloud `postgres` writes its row (its Cloud
 * account, region and Cloudgate's settings), keeps the Infrastructure state
 * its plan read against, and records the run as a Deployment whose parent
 * is the postgres (ADR-0017 extended), with its own Deployment log on the
 * platform host. The run waits in the Cloud run pool as a `database` run,
 * behind the Environment network's when the same Apply makes it.
 *
 * The run writes the definition from the saved row — its class, version,
 * login and Cloudgate's generated password, which reaches `tofu` as a
 * sensitive variable only — reads AWS again, and applies only if that plan
 * makes what the Apply approved (the AWS spec "Cloud run"). The postgres's
 * status follows the run: `running`, then `done` or `error`.
 *
 * **A change is the same run**: an Apply that moves an instance (its
 * class, version or Cloudgate's settings) records a run that writes the
 * definition from the row the Apply just saved, so it writes what the
 * plan's read wrote. A major upgrade the Apply confirmed sets
 * `allow_major_version_upgrade` for that run alone; nothing keeps it.
 *
 * **On Google Cloud the same run makes a Cloud SQL instance**: the
 * Cloud account's own 2-hour proof, the Cloud SQL definition from the row,
 * Google read again before the apply, and the instance's PSC DNS name and
 * own CA saved (encrypted) for its linked Services.
 *
 * **A mysql on RDS is the same run**: its row, state and
 * Deployment are the mysql's, and its definition the RDS one with MySQL's
 * engine and port. So is a mysql on Cloud SQL, with the Cloud SQL
 * definition's MySQL parameters, and its Existing database's endpoint.
 *
 * What it does is read from the Deployment row and the plan whose Apply
 * recorded it, so a run start-up queues again runs alike.
 */
@Injectable()
export class CloudPostgresRuns implements OnModuleInit {
  private readonly logger = new Logger(CloudPostgresRuns.name);
  /** What each Apply approved for the run it recorded, until the run reads it. */
  private readonly approved = new Map<string, Approved>();

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
      .handle('database', (job, control) => this.run(job, control));
  }

  /**
   * The create's or change's run, recorded and submitted to the pool: the
   * step's result names its Deployment, whose log the operator follows.
   * Answers once the run waits, not once it ends.
   */
  async start(
    created: RdsOwner & {
      appName: string;
      name: string;
    },
    environmentId: string,
    approved: PlanReading & { readonly stateId: string },
    run: {
      readonly change: boolean;
      readonly allowMajorUpgrade: boolean;
      /** What makes it, as its Deployment's title names it: RDS unless said. */
      readonly product?: 'RDS' | 'Cloud SQL';
      /** The Deployment's title in place of the product's: an Existing database's endpoint. */
      readonly title?: string;
    } = {
      change: false,
      allowMajorUpgrade: false,
    },
  ): Promise<PlanStepDeploy> {
    const recorded = {
      appName: created.appName,
      title:
        run.title ??
        `${run.change ? 'Change' : 'Create'} ${created.name} on ${run.product ?? 'RDS'}`,
      description: `Applied from a plan, into Infrastructure state ${approved.stateId}`,
    };
    const kind = rdsKindOf(created);
    const id = rdsIdOf(created);
    const record =
      kind === 'mysql'
        ? await this.deployments.recordMysqlCloudRun({
            mysqlId: id,
            ...recorded,
          })
        : await this.deployments.recordPostgresCloudRun({
            postgresId: id,
            ...recorded,
          });
    this.approved.set(record.deploymentId, {
      reading: approved,
      change: run.change,
      allowMajorUpgrade: run.allowMajorUpgrade,
    });
    await this.setStatus(kind, id, 'running');
    void this.cloudRuns
      .submit(record.deploymentId, {
        kind: 'database',
        stateKey: `${kind}:${id}`,
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
    const [kind, id] = row?.mysqlId
      ? (['mysql', row.mysqlId] as const)
      : (['postgres', row?.postgresId] as const);
    if (!row || !id) throw new Error('This Cloud run records no database');
    try {
      await this.make(row, kind, id, control);
      await this.setStatus(kind, id, 'done');
    } catch (error) {
      await this.setStatus(kind, id, 'error').catch(() => undefined);
      throw error;
    } finally {
      this.approved.delete(row.deploymentId);
    }
  }

  private async make(
    row: Deployment,
    kind: RdsEngineName,
    id: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const found = await findRdsRow(this.db, kind, id);
    if (!found) throw new Error(`The ${kind} is gone`);
    const name = found.configName ?? found.name;
    // An Existing database's endpoint and zone, a postgres's or a
    // mysql's: its place is its existing row's, never the
    // Service row's.
    const [existing] = await this.db
      .select()
      .from(existingDatabase)
      .where(eq(rdsExistingColumn(kind), id));
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
            `${name} uses an existing database on AWS, where Cloudgate makes nothing for it`,
          );
        },
        gcp: (account) =>
          this.makeExistingEndpoint(
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
      throw new Error(`The Cloud account this ${kind} uses is gone`);
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) =>
        this.makeOnRds(row, { found, name, place }, account, control, log),
      gcp: (account) => this.makeOnCloudSql(row, found, account, control, log),
    });
  }

  /** A postgres's or a mysql's Cloud run on RDS. */
  private async makeOnRds(
    row: Deployment,
    {
      found,
      name,
      place,
    }: {
      readonly found: RdsRow;
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
    const id = rdsIdOf(found);
    const kind = rdsKindOf(found);
    const state = await findRdsState(this.states, kind, id);
    if (!state) throw new Error(`${name} has no Infrastructure state`);
    const network = await savedDatabaseNetwork(this.db, place);
    if (!network) {
      throw new Error(
        `The Environment network in ${place.region} is not made, so ${name} has no private subnets to sit in`,
      );
    }
    const approved =
      this.approved.get(row.deploymentId) ??
      (await this.approvedOnPlan(row.deploymentId, name));
    if (!approved) {
      throw new Error(
        'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
      );
    }

    // Its stored `native.aws`, refused whole, before anything
    // changes, when it now holds a value locked since it was applied.
    const refusedNative = storedNativeAwsRefusal(name, kind, found.nativeAws, {
      linkedKinds: [],
    });
    if (refusedNative) throw new Error(refusedNative);

    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);

    const written = await savedRdsDatabaseDefinition(this.db, {
      row: found,
      account,
      stateId: state.infrastructureStateId,
      network,
      allowMajorUpgrade: approved.allowMajorUpgrade,
    });
    if (!written.ok) throw new Error(written.message);
    const generated = written.generated;
    await log(
      `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} ${name} on RDS in Cloud account ${account.name} in ${place.region}, Infrastructure state ${state.infrastructureStateId}` +
        (approved.allowMajorUpgrade
          ? ', a major version upgrade the Apply confirmed'
          : ''),
    );

    await log('Reading AWS again before applying');
    const applied = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: generated.definition,
      variables: generated.variables,
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: beforeApplyingApproved(approved, log, control),
    });
    // A value only AWS can judge names the native path it refused.
    if (!applied.ok) {
      throw new Error(blameNativeAws(applied.message, found.nativeAws));
    }
    const address = applied.outputs[POSTGRES_OUTPUTS.address];
    const said = Number(applied.outputs[POSTGRES_OUTPUTS.port]);
    const port =
      Number.isInteger(said) && said > 0 ? said : RDS_ENGINES[kind].port;
    if (typeof address === 'string') {
      // Where the Services linking to it reach it: a re-create's new
      // address is what their next deploy builds their variables from.
      await updateRdsRow(this.db, kind, id, {
        rdsEndpoint: { host: address, port },
      });
    }
    await log(
      typeof address === 'string'
        ? `${name} is ${approved.change ? 'changed' : 'made'}; it answers at ${address}:${port} inside the Environment network`
        : `${name} is ${approved.change ? 'changed' : 'made'}`,
    );
  }

  /**
   * A postgres on Cloud SQL's create or change: the run's own 2-hour
   * proof (S16), the definition from the saved row — its machine, version,
   * login and Cloudgate's generated password, which reaches `tofu` as a
   * sensitive variable only — on the made Environment network, applied only
   * if Google read again makes what the Apply approved. Then where the
   * instance answers and its own CA are saved: its Private Service Connect
   * DNS name, never the endpoint's IP. A mysql's is the
   * same run, at MySQL's port.
   */
  private async makeOnCloudSql(
    row: Deployment,
    found: RdsRow,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const kind = rdsKindOf(found);
    const { port } = CLOUD_SQL_ENGINES[kind];
    const { name, text, verb } = await applyGoogleDatabase(
      { db: this.db, states: this.states, cloudAccounts: this.cloudAccounts },
      {
        found,
        account,
        product: 'Cloud SQL',
        state: () => this.stateOf(found),
        approved: async (name) =>
          this.approved.get(row.deploymentId) ??
          (await this.approvedOnPlan(row.deploymentId, name)),
        write: ({ stateId, network }) => {
          // Its stored `native.gcp`, refused whole, before anything
          // changes, when it now holds a value locked since it was applied.
          const refusedNative = storedNativeGcpRefusal(
            found.configName ?? found.name,
            kind,
            found.nativeGcp,
          );
          if (refusedNative) return { ok: false, message: refusedNative };
          const written = savedCloudSqlDefinition({
            row: found,
            account,
            stateId,
            network,
          });
          return written.ok ? { ok: true, ...written.generated } : written;
        },
        control,
        log,
        // A value only Google can judge names the native path it refused.
        blame: (message) => blameNativeGcp(message, found.nativeGcp),
      },
    );
    const host = text(CLOUD_SQL_OUTPUTS.dnsName);
    const ca = text(CLOUD_SQL_OUTPUTS.ca);
    if (!host || !ca) {
      throw new Error(
        `${name} is ${verb}, but Google did not answer its private DNS name and CA. Check for changes, then apply the new plan`,
      );
    }
    // Where the Services linking to it reach it, and the CA they check it
    // with: what their next deploy builds their variables from.
    await updateRdsRow(this.db, kind, rdsIdOf(found), {
      cloudSqlEndpoint: { host, port, ca },
    });
    const address = text(CLOUD_SQL_OUTPUTS.privateAddress);
    await log(
      `${name} is ${verb}; it answers at ${host}:${port}${address ? ` (${address})` : ''} inside the Environment network, through its private link`,
    );
  }

  /** The Infrastructure state of a postgres's or a mysql's Cloud SQL instance or endpoint. */
  private stateOf(found: RdsRow) {
    return findRdsState(this.states, rdsKindOf(found), rdsIdOf(found));
  }

  /**
   * An Existing database's endpoint and private zone on Google Cloud
   * the run's own proof (S16), the definition from what the last
   * lookup saved — the instance's service attachment and its `….sql.goog.`
   * name, which this plan's Apply saved first when it moved — on the made
   * Environment network, applied only if Google read again makes what the
   * Apply approved. The instance is never in it. Then the endpoint's
   * acceptance is read for the page; linked Services do not wait on it.
   */
  private async makeExistingEndpoint(
    row: Deployment,
    found: RdsRow,
    existing: ExistingDatabase,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const serviceId = rdsIdOf(found);
    const { name, token } = await applyGoogleDatabase(
      { db: this.db, states: this.states, cloudAccounts: this.cloudAccounts },
      {
        found: { ...found, region: existing.region },
        account,
        product: `Cloudgate's endpoint to ${existing.identifier}`,
        state: () => this.stateOf(found),
        approved: async (name) =>
          this.approved.get(row.deploymentId) ??
          (await this.approvedOnPlan(row.deploymentId, name)),
        write: ({ stateId }) => {
          if (!existing.address || !existing.serviceAttachment) {
            return {
              ok: false,
              message: `${found.configName ?? found.name}: no plan has found ${existing.identifier} yet. Check for changes, then apply the new plan`,
            };
          }
          return {
            ok: true,
            definition: existingCloudSqlDefinition({
              serviceId,
              cloudAccountId: account.cloudAccountId,
              projectId: account.cloudId,
              region: existing.region,
              environmentId: found.environmentId,
              stateId,
              serviceAttachment: existing.serviceAttachment,
              dnsName: existing.address.host,
            }),
            variables: {},
          };
        },
        control,
        log,
      },
    );
    const status = await readEndpointStatus(this.db, this.google, token, {
      existingDatabaseId: existing.existingDatabaseId,
      projectId: account.cloudId,
      region: existing.region,
      serviceId,
    });
    await log(
      status === ENDPOINT_ACCEPTED
        ? `${name} reaches ${existing.identifier} at ${existing.address?.host}:${existing.address?.port}, through Cloudgate's endpoint, which ${existing.identifier} accepted`
        : (endpointSentence(existing.identifier, status) ??
            `${name}: Cloudgate's endpoint to ${existing.identifier} is made; Google did not say yet whether it is accepted`),
    );
  }

  /** The step the plan whose Apply recorded this run approved, after a restart. */
  private async approvedOnPlan(
    deploymentId: string,
    configName: string,
  ): Promise<Approved | null> {
    const found = await approvedOnPlan(this.db, deploymentId, configName);
    if (!found) return null;
    return {
      reading: found.reading,
      change: found.change,
      allowMajorUpgrade:
        found.step.action === 'change' && !!found.step.majorUpgrade,
    };
  }

  private async setStatus(
    kind: RdsEngineName,
    id: string,
    status: DatabaseStatus,
  ): Promise<void> {
    await updateRdsRow(this.db, kind, id, { applicationStatus: status });
  }
}

/** What an Apply approved for one run: the plan's read, and what it allows. */
interface Approved extends ApprovedRun {
  /** A major upgrade the Apply confirmed by name: this run only. */
  readonly allowMajorUpgrade: boolean;
}
