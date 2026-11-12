import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import { ApplicationsService } from '../../applications/applications.service';
import { withImports } from '../../cloud-accounts/aws/definitions/imports';
import {
  STATIC_OUTPUTS,
  staticDefinition,
} from '../../cloud-accounts/aws/definitions/static-definition';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { withGoogleImports } from '../../cloud-accounts/gcp/definitions/imports';
import { gcpStaticDefinition } from '../../cloud-accounts/gcp/definitions/static-definition';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { application, deployment } from '../../db/schema';
import type { Application, Deployment } from '../../db/schema';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { describeError } from '../../common/describe-error';
import type { PlanStepDeploy } from './apply.types';
import { approvedOnPlan, beforeApplyingApproved } from './approved-run';
import type { ApprovedRun } from './approved-run';
import { applyApprovedOnGoogle, googleRunProof } from './google-apply';
import { CloudDomainRuns } from './cloud-domain-runs.service';
import { deployedDomains } from './deployed-domains';
import { blameNativeAws, storedNativeAwsRefusal } from '../../native/aws-lay';

/**
 * **A `static` site on AWS is made by a Cloud run** (the AWS buckets spec
 * "`static` on S3 + CloudFront"), the way a bucket on S3 is
 * (`CloudBucketRuns`): nothing is built, so no build slot is taken.
 *
 * An Apply that creates a cloud `static` writes its Application (its Cloud
 * account, region and the real name the plan minted for its own bucket),
 * keeps the Infrastructure state its plan read against, and records the run
 * as a Deployment of the Application, its log on the platform host. The run
 * writes the definition from the row — the bucket, the OAC, the bucket
 * policy, the function and the distribution with the error responses its
 * `spa` picks — reads AWS again, and applies only if that plan makes what
 * the Apply approved (the AWS spec "Cloud run"). What the plan adopted by tag is
 * imported, never made twice. The run saves the distribution's id on the
 * Application, which its deploys switch and clear (`CloudStaticDeploys`).
 *
 * **A change is the same run.** An Apply of a `spa` change, or of a read
 * that found Drift, records a run that writes the definition again and puts
 * AWS back to it. The distribution's origin path is its deploys', and
 * the definition never reads it back as a change.
 *
 * **On Google Cloud** the same run makes the site's private Cloud
 * Storage bucket, its Cloud CDN backend bucket and the load balancer's grant
 * (`gcpStaticDefinition`), with the run's own proof, read again by the
 * Google reader before it applies. It has no generated Domain: until one is
 * added it answers nowhere, which the run's last line says.
 *
 * The Application's status follows the run: `running`, then `done` or
 * `error`. What it does is read from the Deployment row and the plan whose
 * Apply recorded it, so a run start-up queues again runs alike.
 */
@Injectable()
export class CloudStaticRuns implements OnModuleInit {
  private readonly logger = new Logger(CloudStaticRuns.name);
  /** What each Apply approved for the run it recorded, until the run reads it. */
  private readonly approved = new Map<string, ApprovedRun>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly applications: ApplicationsService,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('static', (job, control) => this.run(job, control));
  }

  /**
   * The create's or change's run, recorded and submitted to the pool: the
   * step's result names its Deployment, whose log the operator follows.
   * Answers once the run waits, not once it ends.
   */
  async start(
    made: { applicationId: string; appName: string; configName: string },
    environmentId: string,
    approved: PlanReading & { readonly stateId: string },
    change: boolean,
  ): Promise<PlanStepDeploy> {
    const record = await this.deployments.recordApplicationCloudRun({
      applicationId: made.applicationId,
      appName: made.appName,
      title: `${change ? 'Change' : 'Create'} ${made.configName} on ${await this.placeOf(made.applicationId)}`,
      description: `Applied from a plan, into Infrastructure state ${approved.stateId}`,
    });
    this.approved.set(record.deploymentId, { reading: approved, change });
    await this.applications.updateStatus(made.applicationId, 'running');
    void this.cloudRuns
      .submit(record.deploymentId, {
        kind: 'static',
        stateKey: `application:${made.applicationId}`,
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
    if (!row?.applicationId)
      throw new Error('This Cloud run records no Service');
    try {
      await this.make(row, row.applicationId, control);
      await this.applications.updateStatus(row.applicationId, 'done');
    } catch (error) {
      await this.applications
        .updateStatus(row.applicationId, 'error')
        .catch(() => undefined);
      throw error;
    } finally {
      this.approved.delete(row.deploymentId);
    }
  }

  /**
   * Where the site is served, as a run's title names it: its cloud's
   * product (ADR-0043).
   */
  private async placeOf(applicationId: string): Promise<string> {
    const [found] = await this.db
      .select({ cloudAccountId: application.cloudAccountId })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    const row = found?.cloudAccountId
      ? await this.cloudAccounts.findForUse(found.cloudAccountId)
      : null;
    if (!row) return 'its Cloud account';
    return onCloud(row, {
      aws: () => 'S3 + CloudFront',
      gcp: () => 'Cloud Storage + Cloud CDN',
    });
  }

  private async make(
    row: Deployment,
    applicationId: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const [found] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    if (!found) throw new Error('The Service is gone');
    const name = found.configName ?? found.appName;
    if (!found.cloudAccountId || !found.region || !found.cloudBucketName) {
      throw new Error(`${name} is not a static site in a Cloud account`);
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      found.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw new Error('The Cloud account this Service runs in is gone');
    }
    const state = await this.states.findForApplication(applicationId);
    if (!state) throw new Error(`${name} has no Infrastructure state`);
    const approved =
      this.approved.get(row.deploymentId) ??
      (await approvedOnPlan(this.db, row.deploymentId, name));
    if (!approved) {
      throw new Error(
        'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
      );
    }
    const site: MadeSite = {
      found,
      name,
      region: found.region,
      bucketName: found.cloudBucketName,
      state,
      approved,
    };
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) => this.makeOnAws(site, account, control, log),
      gcp: (account) => this.makeOnGoogle(site, account, control, log),
    });
  }

  /**
   * On Google Cloud: the site's bucket, backend bucket and the load
   * balancer's grant, applied only if Google read again makes what the
   * Apply approved. What the plan adopted by name is imported.
   */
  private async makeOnGoogle(
    { found, name, region, bucketName, state, approved }: MadeSite,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const proof = await googleRunProof(this.cloudAccounts, account);
    const definition = gcpStaticDefinition({
      serviceId: found.applicationId,
      bucketName,
      cloudAccountId: account.cloudAccountId,
      projectId: account.cloudId,
      projectNumber: account.projectNumber,
      region,
      environmentId: found.environmentId,
      stateId: state.infrastructureStateId,
    });
    await log(
      `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} ${name} on Cloud Storage + Cloud CDN, its files in ${bucketName}, in Cloud account ${account.name} in ${region}, Infrastructure state ${state.infrastructureStateId}`,
    );
    await applyApprovedOnGoogle(
      this.states,
      account,
      proof,
      { approved, control, log },
      {
        stateId: state.infrastructureStateId,
        definition: withGoogleImports(definition, approved.reading.adopt),
        variables: {},
      },
    );
    const domains = await deployedDomains(this.db, found.applicationId);
    await log(
      `${name} is ${approved.change ? 'changed' : 'made'} on Cloud CDN; ` +
        (domains.length === 0
          ? 'it answers nowhere until a Domain is added'
          : `it answers at ${domains.map((one) => one.host).join(', ')} once deployed`),
    );
  }

  /** On AWS: the bucket, OAC, bucket policy, function and distribution. */
  private async makeOnAws(
    { found, name, region, bucketName, state, approved }: MadeSite,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const applicationId = found.applicationId;
    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);

    const spa = found.isStaticSpa ?? false;
    // Its stored `native.aws`, refused whole, before anything
    // changes, when it now holds a value locked since it was applied.
    const refusedNative = storedNativeAwsRefusal(
      name,
      'static',
      found.nativeAws,
      { linkedKinds: [], spa },
    );
    if (refusedNative) throw new Error(refusedNative);
    const definition = staticDefinition({
      configName: name,
      serviceId: applicationId,
      bucketName,
      spa,
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region,
      environmentId: found.environmentId,
      stateId: state.infrastructureStateId,
      // A change keeps the origin on the folder its deploys switched to
      // and the site's Domain as it is.
      liveFolder: found.cloudLiveFolder,
      domains: await deployedDomains(this.db, applicationId),
      // What its last Apply laid, over Cloudgate's definition.
      native: found.nativeAws,
    });
    await log(
      `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} ${name} on S3 + CloudFront, its files in ${bucketName}, in Cloud account ${account.name} in ${region}, Infrastructure state ${state.infrastructureStateId}`,
    );

    await log('Reading AWS again before applying');
    const applied = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: withImports(definition, approved.reading.adopt),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: beforeApplyingApproved(approved, log, control),
    });
    // A value only AWS can judge names the native path it refused.
    if (!applied.ok) {
      throw new Error(blameNativeAws(applied.message, found.nativeAws));
    }
    // Its deploys switch, clear and wait on the distribution by its id
    // its `*.cloudfront.net` name is its generated Domain.
    const distributionId = applied.outputs[STATIC_OUTPUTS.distributionId];
    const distributionDomain =
      applied.outputs[STATIC_OUTPUTS.distributionDomain];
    if (typeof distributionId === 'string' && distributionId !== '') {
      await this.db
        .update(application)
        .set({
          cloudDistributionId: distributionId,
          ...(typeof distributionDomain === 'string' && distributionDomain
            ? { cloudDistributionDomain: distributionDomain }
            : {}),
        })
        .where(eq(application.applicationId, applicationId));
      if (typeof distributionDomain === 'string' && distributionDomain) {
        await log(`🌐 ${name} answers at https://${distributionDomain}`);
      }
    }
    await log(
      `${name} is ${approved.change ? 'changed' : 'made'} on CloudFront; ` +
        (spa
          ? 'a missing path answers /index.html'
          : 'a missing path answers 404'),
    );
    // A Domain run that met a hand change this Apply put back changed
    // nothing: its change goes on now, in a run of its own.
    const again = await this.moduleRef
      .get(CloudDomainRuns, { strict: false })
      .afterSiteApplied(applicationId);
    if (again) {
      await log(
        `🌐 ${name}'s Domain was waiting on this Apply; its change goes on in Deployment ${again}`,
      );
    }
  }
}

/** What a static site's run reads once, before its cloud's half applies. */
interface MadeSite {
  readonly found: Application;
  readonly name: string;
  readonly region: string;
  readonly bucketName: string;
  readonly state: InfrastructureState;
  readonly approved: ApprovedRun;
}
