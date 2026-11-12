import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';

import { STAND_IN_IMAGE_TAG } from '../../cloud-accounts/aws/definitions/stand-ins';
import {
  STATIC_DOMAIN_ADDRESSES,
  staticDefinition,
} from '../../cloud-accounts/aws/definitions/static-definition';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import {
  byCloud,
  cloudOrLegacy,
  onCloud,
} from '../../cloud-accounts/cloud-provider';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { runsAsCloudStatic } from '../../deployment-engine/cloud-build';
import {
  DOMAIN_ADDRESSES,
  BUCKET_ACCESS_ADDRESS,
  webDefinition,
} from '../../cloud-accounts/aws/definitions/web-definition';
import { setupNames } from '../../cloud-accounts/aws/setup-template';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { awsAccountOf } from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  ForgetRequest,
} from '../../cloud-accounts/cloud.port';
import type { Env } from '../../common/config/env.schema';
import { getEnvironmentVariablesObject } from '../../docker/docker.utils';
import { ApplicationsService } from '../../applications/applications.service';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  application,
  certificateDeletion,
  cloudAccount,
  compose,
  deployment,
  domain,
  environmentNetwork,
} from '../../db/schema';
import type { Application, DnsRecord, Domain } from '../../db/schema';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { environmentNetworkName } from '../../deployments/service-scope';
import {
  certificatePollDue,
  dnsNames,
  nextCertificateState,
} from '../../domains/cloud-domain';
import type { PointTarget } from '../../domains/cloud-domain';
import type { CloudDomainRunner } from '../../domains/cloud-domain-runner.port';
import { deletionDue, tryDeletion } from '../../domains/certificate-deletions';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { describeError } from '../../common/describe-error';
import { checkBeforeApply, webEntryOf } from './cloud-deploy-steps';
import { AwsStaticDeploys } from './aws-static-deploys.service';
import { webDomainOf } from './deployed-domains';
import { onlyBlocks } from './domain-blocks';
import { domainRunCheck, domainRunError } from './unmade-domains';
import {
  DOMAIN_CERTIFICATE_BLOCK,
  deleteForgottenCertificates,
  forgetUnnamedCertificates,
  recordAwsCertificates,
  regionOfArn,
} from './aws-domain-certificates';
import { GoogleDomainRuns } from './google-domain-runs.service';
import { StackVmDomainRuns } from './stack-vm-domain-runs.service';
import { liveImageOf } from './live-image';

export { deployedDomains, webDomainOf } from './deployed-domains';

/** The poller's job: once a minute, asking only what is due (the AWS spec). */
export const CLOUD_CERTIFICATE_POLL_JOB = 'cloud-domain-certificate-poll';
const EVERY_MINUTE = '* * * * *';

/** The statuses whose certificate the poller still asks ACM about. */
const PENDING = ['waiting-for-dns', 'checking'] as const;

/** The network's ids a Domain run and the poller need. */
interface ReadyNetwork {
  vpcId: string;
  publicSubnetIds: [string, string];
  clusterArn: string;
  httpsListenerArn: string;
  albSecurityGroupId: string;
  albDnsName: string;
}

/**
 * **A cloud `web`'s Domains** (the AWS spec, "Domains"): the short Cloud
 * run each add, edit, remove or Ask again queues, and the ACM poller.
 *
 * **The run** is a Deployment of the Service with a log and no plan: the
 * Service's definition written with its Domains as the database holds them,
 * applied with `-target` on the three Domain blocks only (each Domain's
 * certificate, host rule and, once issued, listener certificate), so a
 * removed Domain is destroyed by the same run. Before it changes anything the
 * plan may touch nothing but those blocks. It writes each new certificate's
 * ARN and validation record on its Domain, and calls an attached one live.
 * A Service's first deploy makes the target group these rules forward to, so
 * a Service takes no Domain before it.
 *
 * **The poller** asks ACM about each pending certificate about once a minute
 * for half an hour after its request, then about every 10 minutes, and DNS
 * whether the validation record and the host's record are there. The ticks
 * only inform. An issued certificate is attached by another such run, and is
 * live once it has. A deploy never waits on any of it.
 *
 * **A `static` site on AWS** has its Domain on its CloudFront
 * distribution instead: its run applies the site's definition with
 * `-target` on the certificate (in `us-east-1`) and the distribution, whose
 * alternate domain name and viewer certificate it changes once the
 * certificate is issued, then waits for CloudFront to read `Deployed`, at
 * most 30 minutes (`AwsStaticDeploys.awaitDomainSpread`). Its host's
 * record points at the distribution's `*.cloudfront.net` name.
 *
 * **A `web` on Google Cloud** (the Google Cloud spec) dispatches here on its Cloud
 * account to `GoogleDomainRuns`: its Domains are rules on the Environment
 * network, so its run is a Cloud run of the network, listed on the Service,
 * and its certificates are Certificate Manager's, polled on the same tick.
 */
@Injectable()
export class CloudDomainRuns
  implements CloudDomainRunner, OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger(CloudDomainRuns.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly deployments: DeploymentsService,
    private readonly scheduling: SchedulingService,
    private readonly moduleRef: ModuleRef,
    private readonly applications: ApplicationsService,
    private readonly config: ConfigService<Env, true>,
    private readonly statics: AwsStaticDeploys,
    private readonly google: GoogleDomainRuns,
    private readonly stacks: StackVmDomainRuns,
  ) {}

  /** A Compose stack's on its Stack VM (#1371): `StackVmDomainRuns`'. */
  stackRefusal(composeId: string): Promise<string | null> {
    return this.stacks.refusal(composeId);
  }

  queueStack(input: {
    composeId: string;
    title: string;
    description: string;
  }): Promise<string> {
    return this.stacks.queue(input);
  }

  stackPointTarget(composeId: string): Promise<PointTarget | null> {
    return this.stacks.pointTarget(composeId);
  }

  networkPointTarget(place: {
    environmentId: string;
    cloudAccountId: string;
    region: string;
  }): Promise<PointTarget | null> {
    return this.stacks.networkPointTarget(place);
  }

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('domain', (job, control) => this.run(job, control));
  }

  onApplicationBootstrap(): void {
    try {
      this.scheduling.register(
        CLOUD_CERTIFICATE_POLL_JOB,
        EVERY_MINUTE,
        null,
        () => this.poll(),
      );
    } catch (error) {
      this.logger.error('The ACM certificate poller could not be armed', error);
    }
  }

  async refusal(applicationId: string): Promise<string | null> {
    const [app] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    if (!app) return this.refusalOnAws(undefined, applicationId);
    // Each cloud's own (ADR-0043).
    return byCloud<() => Promise<string | null>>(await this.cloudOf(app), {
      aws: () => this.refusalOnAws(app, applicationId),
      gcp: () => Promise.resolve(this.google.refusal(app)),
    })();
  }

  /** What an AWS Domain waits for: its static site's distribution, or its first deploy. */
  private async refusalOnAws(
    app: Application | undefined,
    applicationId: string,
  ): Promise<string | null> {
    if (app && runsAsCloudStatic(app)) {
      // Its Domain goes on the distribution its create's run makes.
      return app.cloudDistributionId
        ? null
        : `${app.name}'s CloudFront distribution is not made yet. Add the Domain once its Cloud run has made it`;
    }
    if (await liveImageOf(this.db, applicationId)) return null;
    return `${app?.name ?? 'This Service'} has not finished its first deploy on AWS, which makes what its Domains forward to. Add the Domain once it runs`;
  }

  async queue(input: {
    applicationId: string;
    title: string;
    description: string;
  }): Promise<string> {
    const [app] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, input.applicationId));
    if (!app) throw new Error('The Service is gone');
    // Each cloud's own (ADR-0043): on Google Cloud a run of the network.
    return byCloud<() => Promise<string>>(await this.cloudOf(app), {
      aws: () => this.queueOnAws(app, input),
      gcp: () =>
        this.google.queue(app, {
          title: input.title,
          description: input.description,
        }),
    })();
  }

  /** A Domain's own short Cloud run on AWS, under its Service's state lock. */
  private async queueOnAws(
    app: Application,
    input: { applicationId: string; title: string; description: string },
  ): Promise<string> {
    const row = await this.deployments.recordApplicationCloudRun({
      ...input,
      appName: app.appName,
    });
    void this.cloudRuns
      .submit(row.deploymentId, {
        kind: 'domain',
        stateKey: `application:${input.applicationId}`,
        environmentId: app.environmentId,
        touchesNetwork: false,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Domain run ${row.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return row.deploymentId;
  }

  async pointTarget(applicationId: string): Promise<PointTarget | null> {
    const [app] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    if (!app?.cloudAccountId || !app.region) return null;
    // Each cloud's own (ADR-0043).
    return byCloud<() => Promise<PointTarget | null>>(await this.cloudOf(app), {
      aws: () => this.targetOf(app),
      gcp: () => Promise.resolve(this.google.pointTarget(app)),
    })();
  }

  /** The cloud the Service runs in, by the seam's rule when it has none or it is gone. */
  private async cloudOf(
    app: Pick<Application, 'cloudAccountId'>,
  ): Promise<CloudKind> {
    if (!app.cloudAccountId) return cloudOrLegacy(null);
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, app.cloudAccountId));
    return cloudOrLegacy(found?.cloud);
  }

  /**
   * What the Service's Domains point at: a `static` site's distribution
   * or the Environment network's load balancer; `null` while it is
   * not made.
   */
  private async targetOf(app: Application): Promise<PointTarget | null> {
    if (runsAsCloudStatic(app)) {
      return app.cloudDistributionDomain
        ? { dnsName: app.cloudDistributionDomain, kind: 'cloudfront' }
        : null;
    }
    const network = await this.readyNetwork(app);
    return network
      ? { dnsName: network.albDnsName, kind: 'load-balancer' }
      : null;
  }

  /** The Service's Domain run, as the pool runs it, read off its row. */
  private async run(job: CloudRunJob, control: CloudRunControl): Promise<void> {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    // On Google Cloud a Domain is a rule on the network, run as its own.
    if (row?.environmentNetworkId) {
      return this.google.run(row, control, (line) =>
        this.cloudRuns.appendLog(row.logPath, line),
      );
    }
    // A Compose stack's, on its Stack VM (#1371).
    if (row?.composeId) {
      return this.stacks.run(row, control, (line) =>
        this.cloudRuns.appendLog(row.logPath, line),
      );
    }
    if (!row?.applicationId) {
      throw new Error('This Cloud run records no Service');
    }
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const [app] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, row.applicationId));
    if (!app?.cloudAccountId || !app.region) {
      throw new Error('This Service does not run in a Cloud account');
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      app.cloudAccountId,
    );
    if (!cloudAccountRow)
      throw new Error('The Cloud account this Service runs in is gone');
    const onAws = awsAccountOf(cloudAccountRow);
    if (!onAws.ok) throw new Error(onAws.refusal);
    const account = onAws.account;
    const state = await this.states.findForApplication(app.applicationId);
    if (!state) throw new Error(`${app.name} has no Infrastructure state`);
    const credential = credentialOf(account);
    if (runsAsCloudStatic(app)) {
      const refused = await this.awsReads.credentialRefusal(
        account,
        credential,
      );
      if (refused) throw new Error(refused);
      return this.runStatic({ app, account, state, credential }, control, log);
    }
    const network = await this.readyNetwork(app);
    if (!network) {
      throw new Error(
        `The ${environmentNetworkName(app.region)} is not made, so there is no load balancer for a Domain`,
      );
    }
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);

    const domains = await this.cloudDomains(app.applicationId);
    await log(
      `☁️ [Cloud run] Applying the Domains of ${app.name} on the load balancer in Cloud account ${account.name}, ${app.region}, Infrastructure state ${state.infrastructureStateId}`,
    );
    for (const one of domains) {
      await log(`  ${one.host}${one.path === '/' ? '' : one.path}`);
    }
    if (domains.length === 0)
      await log('  (no Domains: each one left is removed)');

    const generated = webDefinition({
      configName: app.configName ?? app.appName,
      entry: webEntryOf(app),
      service: { serviceId: app.applicationId, replicas: app.replicas },
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
        taskExecutionRoleArn: account.taskExecutionRoleArn,
        permissionsBoundaryArn: setupNames({
          accountId: account.cloudId,
          tagValue: account.cloudAccountId,
        }).boundaryPolicyArn,
      },
      region: app.region,
      environmentId: app.environmentId,
      stateId: state.infrastructureStateId,
      network,
      // Only the Domain blocks are applied, and neither the task nor its
      // image is among them or what they depend on.
      image: {
        tag:
          (await liveImageOf(this.db, app.applicationId))?.tag ??
          STAND_IN_IMAGE_TAG,
        architecture: 'amd64',
      },
      // Not applied either (the SSM blocks are not targeted), but every
      // variable the definition declares needs its value to plan.
      variables: {
        values: await this.variableValues(app.applicationId),
        digestSecret: this.config.get('APP_ENCRYPTION_SECRET', { infer: true }),
      },
      domains: domains.map((one) =>
        webDomainOf(one, one.certificateIssuedAt !== null),
      ),
      // What its last Apply laid: a Domain block depends on the
      // target group, which a targeted apply writes too, so it is written
      // as the deploy wrote it rather than put back to Cloudgate's. The
      // bucket access this definition leaves out is not laid either.
      native: app.nativeAws
        ? Object.fromEntries(
            Object.entries(app.nativeAws).filter(
              ([address]) => address !== BUCKET_ACCESS_ADDRESS,
            ),
          )
        : null,
    });
    if (!generated.ok) throw new Error(generated.refusal.message);

    const check = domainRunCheck((show) =>
      checkBeforeApply(
        show,
        // Every targeted block is the Domain's own: nothing to stop on.
        onlyBlocks(DOMAIN_ADDRESSES, {
          other: 'deploy the Service, then change the Domain again',
          drift: 'apply that plan, then change the Domain again',
          owns: () => true,
        }),
        () => control.beginApply(),
      ),
    );
    const applied = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: generated.definition,
      variables: generated.variables,
      targets: [...DOMAIN_ADDRESSES],
      forget: this.forgetting(account, state, domains, log),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: check.beforeApply,
    });
    if (!applied.ok) {
      throw await domainRunError(this.db, {
        check,
        applied,
        domains,
        madeBy: 'acmCertificateArn',
        refusal: applied.message,
        log,
      });
    }
    await this.record(domains, applied.outputs, log, 'the load balancer');
    await this.deleteForgotten(account, state.infrastructureStateId, log);
    await log(`✅ [Cloud run] The Domains of ${app.name} are applied`);
  }

  /**
   * A `static` site's Domain run: its certificate in `us-east-1`
   * and, once issued, its host and certificate on the distribution, then
   * the wait for CloudFront to spread that, at most 30 minutes.
   */
  private async runStatic(
    on: {
      app: Application;
      account: AwsCloudAccount;
      state: InfrastructureState;
      credential: AwsCredential;
    },
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const { app, account, state, credential } = on;
    if (!app.cloudBucketName || !app.cloudDistributionId) {
      throw new Error(
        `${app.name}'s CloudFront distribution is not made yet, so there is nothing to add a Domain to`,
      );
    }
    const domains = await this.cloudDomains(app.applicationId);
    await log(
      `☁️ [Cloud run] Applying the Domain of ${app.name} on CloudFront distribution ${app.cloudDistributionId} in Cloud account ${account.name}, its certificate in us-east-1, Infrastructure state ${state.infrastructureStateId}`,
    );
    for (const one of domains) await log(`  ${one.host}`);
    if (domains.length === 0) {
      await log('  (no Domain: the one left is removed)');
    }
    const definition = staticDefinition({
      configName: app.configName ?? app.appName,
      serviceId: app.applicationId,
      bucketName: app.cloudBucketName,
      spa: app.isStaticSpa ?? false,
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: app.region!,
      environmentId: app.environmentId,
      stateId: state.infrastructureStateId,
      // The origin stays on the folder its deploys switched to.
      liveFolder: app.cloudLiveFolder,
      domains: domains.map((one) =>
        webDomainOf(one, one.certificateIssuedAt !== null),
      ),
      // What its last Apply laid: the distribution this targeted
      // apply writes is written as the site's Cloud run wrote it, not put
      // back to Cloudgate's.
      native: app.nativeAws,
    });
    const check = domainRunCheck((show) =>
      checkBeforeApply(
        show,
        onlyBlocks(STATIC_DOMAIN_ADDRESSES, {
          other:
            'Check for changes, apply the plan, then change the Domain again',
          // The site's Apply queues this Domain's run again
          // (`afterSiteApplied`).
          drift: "its Apply puts it back, and the Domain's change follows",
          owns: staticDomainOwns,
        }),
        () => control.beginApply(),
      ),
    );
    const applied = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition,
      targets: [...STATIC_DOMAIN_ADDRESSES],
      forget: this.forgetting(account, state, domains, log),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: check.beforeApply,
    });
    if (!applied.ok) {
      throw await domainRunError(this.db, {
        check,
        applied,
        domains,
        madeBy: 'acmCertificateArn',
        refusal:
          cnameRefusal(applied.message, domains, app.cloudDistributionDomain) ??
          applied.message,
        log,
      });
    }
    await this.record(domains, applied.outputs, log, 'CloudFront');
    await this.deleteForgotten(account, state.infrastructureStateId, log);
    await this.statics.awaitDomainSpread(
      account,
      app.cloudDistributionId,
      control,
      log,
    );
    await log(`✅ [Cloud run] The Domain of ${app.name} is applied`);
  }

  /**
   * A site's Domain run again after its Apply: a Domain run that met
   * a hand change on the distribution changed nothing and left its Domain
   * with no certificate yet, or issued and not on the distribution. The
   * Apply put the hand change back, so the Domain's change goes on in a run
   * of its own; `null` when the Domain is where its runs left it.
   */
  async afterSiteApplied(applicationId: string): Promise<string | null> {
    const unfinished = (await this.cloudDomains(applicationId)).find(
      (one) =>
        one.cloudCertificateStatus !== 'failed' &&
        (!one.acmCertificateArn ||
          (one.certificateIssuedAt !== null &&
            one.cloudCertificateStatus !== 'live')),
    );
    if (!unfinished) return null;
    return this.queue({
      applicationId,
      title: `Finish the Domain ${unfinished.host}`,
      description:
        "The site's Apply put back what was changed by hand; the Domain's change goes on",
    });
  }

  /**
   * The certificates no Domain names any more, taken out of the state
   * before the plan (`forgetUnnamedCertificates`).
   */
  private forgetting(
    account: AwsCloudAccount,
    state: InfrastructureState,
    domains: Domain[],
    log: (line: string) => Promise<void>,
  ): ForgetRequest {
    return forgetUnnamedCertificates(this.db, {
      account,
      stateId: state.infrastructureStateId,
      domains,
      log,
    });
  }

  /** One try at deleting each certificate the state let go of, now. */
  private async deleteForgotten(
    account: AwsCloudAccount,
    stateId: string,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    await deleteForgottenCertificates(
      { db: this.db, cloud: this.cloud, cloudAccounts: this.cloudAccounts },
      account,
      stateId,
      log,
    );
  }

  /** Every certificate waiting for ACM to let go that is due a try. */
  private async deletePending(now: Date): Promise<void> {
    const rows = await this.db.select().from(certificateDeletion);
    for (const row of rows.filter((one) => deletionDue(one, now))) {
      try {
        const found = await this.cloudAccounts.findForUse(row.cloudAccountId);
        if (!found) continue;
        const onAws = awsAccountOf(found);
        if (!onAws.ok) continue;
        const session = await this.cloudAccounts.deployRoleSession(
          onAws.account,
        );
        if (!session.ok) continue;
        const tried = await tryDeletion(
          this.db,
          this.cloud,
          session.session,
          row,
          now,
        );
        if (typeof tried === 'object') {
          this.logger.warn(
            `ACM refused to delete the certificate ${row.certificateArn}: ${tried.refused.code}: ${tried.refused.message}`,
          );
        } else if (tried !== 'in-use') {
          this.logger.log(
            `The certificate of ${row.host ?? row.certificateArn} is deleted from ACM`,
          );
        }
      } catch (error) {
        this.logger.error(
          `The certificate ${row.certificateArn} could not be deleted: ${describeError(error)}`,
        );
      }
    }
  }

  /** Each new certificate's ARN and record, and each attached one live. */
  private async record(
    domains: Domain[],
    outputs: Record<string, unknown>,
    log: (line: string) => Promise<void>,
    servedBy: string,
  ): Promise<void> {
    await recordAwsCertificates(this.db, { domains, outputs, log, servedBy });
  }

  /**
   * One poller tick: every pending certificate that is due, and every live
   * Domain whose host has not yet been seen pointing at the load balancer.
   * One Domain's failure is logged and never stops the rest.
   */
  async poll(now: Date = new Date()): Promise<void> {
    try {
      await this.deletePending(now);
    } catch (error) {
      this.logger.error(
        `The certificates waiting for ACM could not be read: ${describeError(error)}`,
      );
    }
    const rows = await this.db
      .select()
      .from(domain)
      .where(
        or(
          inArray(domain.cloudCertificateStatus, [...PENDING]),
          and(
            eq(domain.cloudCertificateStatus, 'live'),
            eq(domain.pointsAtLoadBalancer, false),
          ),
        ),
      );
    for (const row of rows) {
      if (!certificatePollDue(row, now)) continue;
      try {
        await this.pollOne(row, now);
      } catch (error) {
        this.logger.error(
          `The certificate of ${row.host} could not be polled: ${describeError(error)}`,
        );
      }
    }
  }

  private async pollOne(row: Domain, now: Date): Promise<void> {
    if (row.composeId) return this.pollStackDomain(row, row.composeId, now);
    const [app] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, row.applicationId ?? ''));
    if (!app?.cloudAccountId || !app.region) return;
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      app.cloudAccountId,
    );
    if (!cloudAccountRow) return;
    const { region } = app;
    // Each cloud's half (ADR-0043).
    return onCloud(cloudAccountRow, {
      aws: async (account) => {
        const target = await this.targetOf(app);
        return this.pollOneOnAws(row, account, now, {
          region,
          target,
          requeue: async (title, description) => {
            await this.queue({
              applicationId: app.applicationId,
              title,
              description,
            });
          },
          pointedAgain: () => this.attachAgain(app.applicationId, row.host),
        });
      },
      gcp: (account) => this.google.pollOne(row, app, account, now),
    });
  }

  /** A Domain of a Compose stack on its Stack VM, polled as any cloud Domain (#1371). */
  private async pollStackDomain(
    row: Domain,
    composeId: string,
    now: Date,
  ): Promise<void> {
    const [stack] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    if (!stack?.cloudAccountId || !stack.region) return;
    const accountRow = await this.cloudAccounts.findForUse(
      stack.cloudAccountId,
    );
    if (!accountRow) return;
    const place = {
      environmentId: stack.environmentId,
      cloudAccountId: stack.cloudAccountId,
      region: stack.region,
    };
    return onCloud(accountRow, {
      aws: async (account) =>
        this.pollOneOnAws(row, account, now, {
          region: place.region,
          target: await this.stacks.pointTarget(composeId),
          requeue: async (title, description) => {
            await this.stacks.queue({ composeId, title, description });
          },
        }),
      gcp: (account) => this.google.pollOne(row, place, account, now),
    });
  }

  /**
   * A Domain's ACM certificate polled, and where its host points. `on`
   * is its parent's: what its host should point at, the run that attaches
   * an issued certificate, and, for a static site, the attach queued again
   * once its host points at the distribution.
   */
  private async pollOneOnAws(
    row: Domain,
    account: AwsCloudAccount,
    now: Date,
    on: {
      region: string;
      target: PointTarget | null;
      requeue: (title: string, description: string) => Promise<void>;
      pointedAgain?: () => Promise<void>;
    },
  ): Promise<void> {
    const { target } = on;
    const pointsAtLoadBalancer = target
      ? await this.pointsAt(row.host, target.dnsName)
      : false;
    const polled = {
      certificateLastPolledAt: now.toISOString(),
      pointsAtLoadBalancer,
    };

    const pending =
      row.cloudCertificateStatus !== null &&
      (PENDING as readonly string[]).includes(row.cloudCertificateStatus);
    if (!pending || !row.acmCertificateArn || row.certificateIssuedAt) {
      await this.db
        .update(domain)
        .set(polled)
        .where(eq(domain.domainId, row.domainId));
      if (
        pending &&
        row.certificateIssuedAt &&
        target?.kind === 'cloudfront' &&
        !row.pointsAtLoadBalancer &&
        pointsAtLoadBalancer
      ) {
        await on.pointedAgain?.();
      }
      return;
    }
    const session = await this.cloudAccounts.deployRoleSession(account);
    if (!session.ok) {
      await this.db
        .update(domain)
        .set(polled)
        .where(eq(domain.domainId, row.domainId));
      return;
    }
    const acm = await this.cloud.acmDescribeCertificate(session.session, {
      // Where it was requested: a static site's is in us-east-1.
      region: regionOfArn(row.acmCertificateArn) ?? on.region,
      certificateArn: row.acmCertificateArn,
    });
    if (!acm.ok) {
      this.logger.warn(
        `ACM did not answer about the certificate of ${row.host}: ${acm.code}: ${acm.message}`,
      );
      await this.db
        .update(domain)
        .set(polled)
        .where(eq(domain.domainId, row.domainId));
      return;
    }
    const record = row.validationRecord ?? acm.value.validationRecord ?? null;
    const seen = record ? await this.validationSeen(record) : false;
    const next = nextCertificateState(row, acm.value, seen, now);
    await this.db
      .update(domain)
      .set({
        ...polled,
        validationRecord: record,
        validationRecordFound: seen || next.issued,
        cloudCertificateStatus: next.status,
        certificateFailure: next.failure,
        ...(next.issued ? { certificateIssuedAt: now.toISOString() } : {}),
      })
      .where(eq(domain.domainId, row.domainId));
    if (next.issued) {
      await on.requeue(
        `Attach the certificate of ${row.host}`,
        target?.kind === 'cloudfront'
          ? 'ACM issued it; the host goes on the CloudFront distribution with it'
          : 'ACM issued it; it goes on the load balancer',
      );
    }
  }

  /**
   * An issued certificate not yet on its distribution, whose host has just
   * come to point at it: CloudFront refuses an alias whose DNS names
   * another distribution, so the attach that met that is queued again, once
   * per change of the record, unless a run of the site is still to run.
   */
  private async attachAgain(applicationId: string, host: string) {
    const [waiting] = await this.db
      .select({ deploymentId: deployment.deploymentId })
      .from(deployment)
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          inArray(deployment.status, ['pending', 'running']),
        ),
      )
      .limit(1);
    if (waiting) return;
    await this.queue({
      applicationId,
      title: `Attach the certificate of ${host}`,
      description:
        'The host now points at the CloudFront distribution; it goes on with its certificate',
    });
  }

  private async validationSeen(record: DnsRecord): Promise<boolean> {
    const answer = await this.cloud.dnsLookup(record.name);
    return dnsNames(answer.cnames, record.value);
  }

  /** The host names the load balancer, or shares its addresses (an ALIAS). */
  private async pointsAt(host: string, albDnsName: string): Promise<boolean> {
    const answer = await this.cloud.dnsLookup(host);
    if (dnsNames(answer.cnames, albDnsName)) return true;
    if (answer.addresses.length === 0) return false;
    const balancer = await this.cloud.dnsLookup(albDnsName);
    return answer.addresses.some((address) =>
      balancer.addresses.includes(address),
    );
  }

  private async cloudDomains(applicationId: string): Promise<Domain[]> {
    return this.db
      .select()
      .from(domain)
      .where(
        and(
          eq(domain.applicationId, applicationId),
          isNotNull(domain.cloudCertificateStatus),
        ),
      )
      .orderBy(domain.createdAt);
  }

  /** The Service's variables, resolved as its deploy resolves them. */
  private async variableValues(
    applicationId: string,
  ): Promise<Record<string, string>> {
    const app = await this.applications.findDeployable(applicationId);
    return getEnvironmentVariablesObject(
      app.env,
      app.environment.project.env,
      app.environment.env,
    );
  }

  private async readyNetwork(
    app: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
  ): Promise<ReadyNetwork | null> {
    const [found] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, app.environmentId),
          eq(environmentNetwork.cloudAccountId, app.cloudAccountId ?? ''),
          eq(environmentNetwork.region, app.region ?? ''),
          eq(environmentNetwork.status, 'ready'),
        ),
      );
    if (
      !found?.vpcId ||
      !found.publicSubnetIds ||
      !found.clusterArn ||
      !found.httpsListenerArn ||
      !found.albSecurityGroupId ||
      !found.albDnsName
    ) {
      return null;
    }
    return {
      vpcId: found.vpcId,
      publicSubnetIds: found.publicSubnetIds,
      clusterArn: found.clusterArn,
      httpsListenerArn: found.httpsListenerArn,
      albSecurityGroupId: found.albSecurityGroupId,
      albDnsName: found.albDnsName,
    };
  }
}

/**
 * What a static site's Domain run sets itself: its certificate, and
 * the distribution's alternate domain names and viewer certificate. Any
 * other field of the distribution changed in AWS is a hand change.
 */
function staticDomainOwns(address: string, field: string): boolean {
  if (address.startsWith(`${DOMAIN_CERTIFICATE_BLOCK}[`)) return true;
  const top = field.split('.')[0];
  return top === 'aliases' || top === 'viewer_certificate';
}

/**
 * CloudFront's refusal of an alias whose DNS points at another
 * distribution, said as what the operator does about it; `null` for
 * any other failure.
 */
function cnameRefusal(
  message: string,
  domains: Domain[],
  distributionDomain: string | null,
): string | null {
  if (!message.includes('CNAMEAlreadyExists')) return null;
  const host = domains.find((one) => one.certificateIssuedAt)?.host;
  if (!host || !distributionDomain) return null;
  return `CloudFront refused ${host}: ${host} still points at another CloudFront distribution. Point its CNAME at ${distributionDomain}; Cloudgate attaches the certificate again once it does`;
}
