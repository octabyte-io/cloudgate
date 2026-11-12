import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, isNotNull } from 'drizzle-orm';

import { makeDefaultCertificate } from '../../cloud-accounts/definitions/default-certificate';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../../cloud-accounts/definitions/default-certificate';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { googleAccountOf } from '../../cloud-accounts/cloud-provider';
import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import type { CloudAccount } from '../../cloud-accounts/cloud-account.schema';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import {
  GCP_DOMAIN_CERTIFICATES_OUTPUT,
  GCP_DOMAIN_RUN_ADDRESSES,
  networkDefinition,
} from '../../cloud-accounts/gcp/definitions/network-definition';
import { readGooglePlan } from '../../cloud-accounts/gcp/plan-reader/read-plan';
import { GOOGLE_CLOUD_PORT } from '../../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleCloudPort,
} from '../../cloud-accounts/google-cloud.port';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../../common/describe-error';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, domain, environmentNetwork } from '../../db/schema';
import type {
  Application,
  Deployment,
  DnsRecord,
  Domain,
  EnvironmentNetwork,
} from '../../db/schema';
import type {
  CloudRunControl,
  CloudRunEnding,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { environmentNetworkName } from '../../deployments/service-scope';
import {
  dnsNames,
  googleQuotaRefusal,
  nextGoogleCertificateState,
} from '../../domains/cloud-domain';
import type { PointTarget } from '../../domains/cloud-domain';
import { checkBeforeApply } from './cloud-deploy-steps';
import { onlyBlocks } from './domain-blocks';
import { clearSiteCache } from './google-cache-clears';
import { networkDomainOf, networkDomainRows } from './google-network-domains';
import type { NetworkDomainRow } from './google-network-domains';
import { liveImageOf } from './live-image';
import { domainRunCheck, domainRunError } from './unmade-domains';

/** The statuses whose certificate the poller still asks Google about. */
const PENDING: readonly string[] = ['waiting-for-dns', 'checking'];

/** A made Google network, with what its Domains need. */
type ReadyNetwork = EnvironmentNetwork & {
  ipAddress: string;
  urlMapName: string;
  certificateMapName: string;
};

/**
 * **A Cloud Run `web`'s Domains** (the Google Cloud spec, "Domains"): the Google
 * half of `CloudDomainRuns`, which dispatches here on the Service's Cloud
 * account.
 *
 * **The run.** Google keeps every host rule in the Environment network's one
 * URL map, and each Domain's DNS authorization, certificate and map entry
 * in the network's state. So each add, edit, remove and Ask
 * again is a short Deployment with a log and no plan, recorded as a **Cloud
 * run of the Environment network** (parent `environmentNetwork`) and listed
 * on the Service through its "for Service" column (S14, ADR-0017 amended).
 * It waits in the pool on the network's state as a run that touches the
 * network, so it holds back the Environment's other Cloud runs while it
 * runs. It writes the network's definition with every Domain of the
 * Environment as the database holds them, applied with `-target` on the
 * three Domain blocks and the URL map, so a removed Domain is destroyed by
 * the same run; before it changes anything the plan may touch nothing else.
 * It saves each new certificate's name and its authorization's CNAME on
 * its Domain. Past Google's Certificate Manager quota the run fails naming
 * the quota from Google's refusal (S5), and the Domains it could not make
 * are Failed with the same words.
 *
 * **A static site's Domains** are the same runs: each host rule
 * goes to the site's Cloud CDN backend bucket, rewritten onto its `live/`
 * folder, so a Domain's run never changes which version is live. A site
 * takes a Domain once its create's Cloud run has made the backend bucket.
 * Its `spa` change is a run of the network too ({@link queueSpaChange}),
 * which ends by clearing the cache of each of the site's Domains.
 *
 * **The poller** shares AWS's job and cadence (S5): about once a minute for
 * half an hour after a request, then about every 10 minutes, Failed at 72
 * hours. It asks Certificate Manager about each pending certificate, and
 * DNS whether the CNAME and the host's `A` record to the fixed IP are
 * there. An active certificate is live at once: its map entry already
 * serves it. A deploy never waits on any of it.
 */
@Injectable()
export class GoogleDomainRuns {
  private readonly logger = new Logger(GoogleDomainRuns.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  /**
   * Why the Service cannot take a Domain yet: its host rule routes to the
   * backend service its first deploy makes, on the network's load balancer.
   */
  async refusal(app: Application): Promise<string | null> {
    if (!(await this.readyNetwork(app))) {
      return `The ${environmentNetworkName(app.region)} is not made, so there is no load balancer for a Domain. Add the Domain once ${app.name} has deployed`;
    }
    // A static site's host rule routes to the backend bucket its create's
    // Cloud run makes; it needs no deploy first.
    if (app.configKind === 'static') {
      return (await this.siteMade(app.applicationId))
        ? null
        : `${app.name}'s Cloud CDN backend bucket is not made yet. Add the Domain once its Cloud run has made it`;
    }
    if (await liveImageOf(this.db, app.applicationId)) return null;
    return `${app.name} has not finished its first deploy on Google Cloud, which makes the backend service its Domains are routed to. Add the Domain once it runs`;
  }

  /**
   * Records the network's Domain run, "for" the Service, and queues it as
   * a run that touches the network; answers with its Deployment's id.
   */
  async queue(
    app: Application,
    input: { title: string; description: string },
    options: { clearsCache?: boolean } = {},
  ): Promise<string> {
    const network = await this.readyNetwork(app);
    if (!network) {
      throw new Error(`The ${environmentNetworkName(app.region)} is gone`);
    }
    const row = await this.deployments.recordEnvironmentNetworkRun({
      environmentNetworkId: network.environmentNetworkId,
      forServiceId: app.applicationId,
      ...input,
    });
    void this.cloudRuns
      .submit(row.deploymentId, {
        kind: 'domain',
        stateKey: `network:${network.environmentNetworkId}`,
        environmentId: app.environmentId,
        touchesNetwork: true,
        ...(options.clearsCache ? { clearsCacheFor: app.applicationId } : {}),
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Domain run ${row.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return row.deploymentId;
  }

  /**
   * A static site's `spa` change, once saved (the Google Cloud buckets spec "Toggling
   * `spa`"): the network's run writing its host rules with the error policy
   * `spa` now picks, then clearing the cache of each of its Domains, so no
   * edge keeps the old answer for a missing page. Answers its Deployment's
   * id, or `null`, queuing nothing, when the site has no Domain: nothing of
   * it is on the network, and its first Domain's run writes the saved `spa`.
   */
  async queueSpaChange(app: Application): Promise<string | null> {
    const network = await this.readyNetwork(app);
    if (!network) return null;
    const domains = (await networkDomainRows(this.db, network)).filter(
      (one) => one.applicationId === app.applicationId,
    );
    if (domains.length === 0) return null;
    const on = app.isStaticSpa === true;
    return this.queue(
      app,
      {
        title: `Turn spa ${on ? 'on' : 'off'} for ${app.name}`,
        description: on
          ? "Has a missing page answer the site's /index.html on the network's load balancer, then clears the cache of its Domains"
          : "Has a missing page answer 404 again on the network's load balancer, then clears the cache of its Domains",
      },
      { clearsCache: true },
    );
  }

  /** The network's fixed IP, which every Domain's `A` record names. */
  async pointTarget(
    app: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
  ): Promise<PointTarget | null> {
    const network = await this.readyNetwork(app);
    return network ? { dnsName: network.ipAddress, kind: 'fixed-ip' } : null;
  }

  /** The network's Domain run, as the pool runs it, read off its row. */
  async run(
    row: Deployment,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const [network] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        eq(
          environmentNetwork.environmentNetworkId,
          row.environmentNetworkId ?? '',
        ),
      );
    if (!network) throw new Error('The Environment network is gone');
    const ready = readyOf(network);
    if (!ready) {
      throw new Error(
        `The ${environmentNetworkName(network.region)} is not made, so there is no load balancer for a Domain`,
      );
    }
    const applied = await this.applyDomains(ready, control, log);
    // A static site's `spa` change ends with its Domains' cache cleared.
    const site = row.cloudRun?.clearsCacheFor;
    if (site) {
      await clearSiteCache(
        this.google,
        () => Promise.resolve(applied.token),
        { projectId: applied.projectId, urlMap: ready.urlMapName },
        applied.domains
          .filter((one) => one.applicationId === site)
          .map((one) => one.host),
        log,
      );
    }
  }

  /**
   * A cloud Service's Delete's network step: the
   * network's Domain run, applied once the Service is marked as being
   * deleted, which leaves its Domains out ({@link networkDomainRows}), so
   * its host rules, certificates, map entries and DNS authorizations go.
   * Throws as {@link run} does. Answers `false`, having done nothing, when
   * the Service's network is not made: nothing of it is on a load balancer.
   */
  async removeServiceDomains(
    app: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<boolean> {
    return this.applyOnNetwork(app, control, log);
  }

  /**
   * The network's Domains, as the database holds them, applied on its load
   * balancer, from a run that is not the network's own: a Stack VM's
   * stack's Domain run (#1371), between the applies of its own state that
   * make and remove the backends the URL map names. Throws as {@link run}
   * does; answers `false`, doing nothing, while the network is not made.
   */
  async applyOnNetwork(
    place: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<boolean> {
    const network = await this.readyNetwork(place);
    if (!network) return false;
    await this.applyDomains(network, control, log);
    return true;
  }

  /**
   * An Environment's Delete's first step on Google Cloud: the network's Domain
   * run, queued once the Environment is marked as
   * being deleted, which leaves every Domain out ({@link networkDomainRows}),
   * so every host rule, certificate, map entry and DNS authorization goes in
   * one run before any Service is touched. Recorded as a Cloud run of the
   * network. Answers how it ended, or `null`, queuing nothing, when the
   * network is not made: nothing of it is on a load balancer.
   */
  async removeEnvironmentDomains(
    network: EnvironmentNetwork,
  ): Promise<{ deploymentId: string; ended: Promise<CloudRunEnding> } | null> {
    if (!readyOf(network)) return null;
    const row = await this.deployments.recordEnvironmentNetworkRun({
      environmentNetworkId: network.environmentNetworkId,
      title: 'Remove every Domain',
      description:
        "Takes every Domain of the Environment off the network's load balancer, before its Services are deleted",
    });
    const ended = this.cloudRuns.submit(row.deploymentId, {
      kind: 'domain',
      stateKey: `network:${network.environmentNetworkId}`,
      environmentId: network.environmentId,
      touchesNetwork: true,
    });
    return { deploymentId: row.deploymentId, ended };
  }

  /** The URL map and certificate map of the Service's made network, if it is made. */
  async networkMapsOf(
    app: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
  ): Promise<{ urlMapName: string; certificateMapName: string } | null> {
    const network = await this.readyNetwork(app);
    return network
      ? {
          urlMapName: network.urlMapName,
          certificateMapName: network.certificateMapName,
        }
      : null;
  }

  /**
   * The network's Domains, as the database holds them, applied on its load
   * balancer. Answers what it applied, with the run's sign-in and project,
   * for what a run does after it.
   */
  private async applyDomains(
    network: ReadyNetwork,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<{
    domains: NetworkDomainRow[];
    token: GoogleAccessToken;
    projectId: string;
  }> {
    const accountRow = await this.cloudAccounts.findForUse(
      network.cloudAccountId,
    );
    if (!accountRow) {
      throw new Error('The Cloud account this network uses is gone');
    }
    const account = googleAccountOf(accountRow);
    const state = await this.states.findForNetwork(
      network.environmentNetworkId,
    );
    if (!state) throw new Error('The Environment network has no state');
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) throw new Error(session.refusal);

    const domains = await networkDomainRows(this.db, network);
    await log(
      `☁️ [Cloud run] Applying the Domains of the ${environmentNetworkName(network.region)} on its load balancer in Cloud account ${account.name}, Infrastructure state ${state.infrastructureStateId}`,
    );
    for (const one of domains) {
      await log(`  ${one.host}${one.path && one.path !== '/' ? one.path : ''}`);
    }
    if (domains.length === 0) {
      await log('  (no Domains: each one left is removed)');
    }

    const certificate = makeDefaultCertificate();
    const check = domainRunCheck((show) =>
      checkBeforeApply(
        show,
        onlyBlocks(
          GCP_DOMAIN_RUN_ADDRESSES,
          'Check for changes, apply the plan, then change the Domain again',
        ),
        () => control.beginApply(),
        [],
        (fresh) => readGooglePlan({ show: fresh, nameSearch: [], context: {} }),
      ),
    );
    const applied = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential: session.credential,
      definition: networkDefinition({
        cloudAccountId: account.cloudAccountId,
        projectId: account.cloudId,
        region: network.region,
        environmentId: network.environmentId,
        stateId: state.infrastructureStateId,
        domains: domains.map(networkDomainOf),
        // The private links the network holds, so a Domain run never takes
        // one off.
        privateLinks: network.privateLinks,
      }),
      // Not applied (the default certificate is not targeted, and ignores a
      // new one), but every variable the definition declares needs a value.
      variables: {
        [DEFAULT_CERTIFICATE_VARIABLES.certificate]: certificate.certificatePem,
        [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
      },
      targets: [...GCP_DOMAIN_RUN_ADDRESSES],
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: check.beforeApply,
    });
    if (!applied.ok) {
      // Past a quota, in the quota's words; any other refusal as the
      // run words it.
      const refusal =
        googleQuotaRefusal(applied.message) ??
        googleRefusalReason(applied.message, account.cloudId);
      throw await domainRunError(this.db, {
        check,
        applied,
        domains,
        madeBy: 'googleCertificateName',
        refusal,
        log,
      });
    }
    await this.record(domains, applied.outputs, log);
    await log(
      `✅ [Cloud run] The Domains of the ${environmentNetworkName(network.region)} are applied`,
    );
    return { domains, token: session.token, projectId: account.cloudId };
  }

  /** Each new certificate's name and its authorization's CNAME. */
  private async record(
    domains: Domain[],
    outputs: Record<string, unknown>,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const answered = certificatesOf(outputs[GCP_DOMAIN_CERTIFICATES_OUTPUT]);
    const now = new Date().toISOString();
    for (const one of domains) {
      const certificate = answered.get(one.domainId);
      if (!certificate) {
        throw new Error(
          `OpenTofu did not answer the certificate of ${one.host}; run the Domain's change again`,
        );
      }
      if (certificate.name === one.googleCertificateName) continue;
      await this.db
        .update(domain)
        .set({
          cloudCertificateStatus: 'waiting-for-dns',
          googleCertificateName: certificate.name,
          validationRecord: certificate.validation,
          certificateRequestedAt: now,
          certificateLastPolledAt: null,
          certificateIssuedAt: null,
          certificateFailure: null,
          validationRecordFound: false,
        })
        .where(eq(domain.domainId, one.domainId));
      await log(
        `🔐 Requested a Google-managed certificate for ${one.host}; it waits for its authorization record at your DNS provider`,
      );
    }
  }

  /**
   * One poller tick for a Domain on Google Cloud: whether its host points
   * at the fixed IP, and, while its certificate is pending, what
   * Certificate Manager and DNS say of it. Called by `CloudDomainRuns.poll`
   * when it is due.
   */
  async pollOne(
    row: Domain,
    app: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
    accountRow: CloudAccount,
    now: Date,
  ): Promise<void> {
    const network = await this.readyNetwork(app);
    const pointsAtLoadBalancer = network
      ? (await this.google.dnsLookup(row.host)).addresses.includes(
          network.ipAddress,
        )
      : false;
    const polled = {
      certificateLastPolledAt: now.toISOString(),
      pointsAtLoadBalancer,
    };
    const pending =
      row.cloudCertificateStatus !== null &&
      PENDING.includes(row.cloudCertificateStatus);
    const onlyPolled = () =>
      this.db
        .update(domain)
        .set(polled)
        .where(eq(domain.domainId, row.domainId));
    if (!pending || !row.googleCertificateName) {
      await onlyPolled();
      return;
    }
    const account: GcpCloudAccount = googleAccountOf(accountRow);
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) {
      await onlyPolled();
      return;
    }
    const answer = await this.google.certificate(session.token, {
      projectId: account.cloudId,
      name: row.googleCertificateName,
    });
    if (!answer.ok) {
      this.logger.warn(
        `Certificate Manager did not answer about the certificate of ${row.host}: ${answer.code}: ${answer.message}`,
      );
      await onlyPolled();
      return;
    }
    const seen = row.validationRecord
      ? await this.validationSeen(row.validationRecord)
      : false;
    const next = nextGoogleCertificateState(row, answer.value, seen, now);
    await this.db
      .update(domain)
      .set({
        ...polled,
        validationRecordFound: seen || next.issued,
        cloudCertificateStatus: next.status,
        certificateFailure: next.failure,
        ...(next.issued ? { certificateIssuedAt: now.toISOString() } : {}),
      })
      .where(eq(domain.domainId, row.domainId));
  }

  private async validationSeen(record: DnsRecord): Promise<boolean> {
    const answer = await this.google.dnsLookup(record.name);
    return dnsNames(answer.cnames, record.value);
  }

  /** Whether a static site's create Cloud run has made its backend bucket. */
  private async siteMade(applicationId: string): Promise<boolean> {
    const runs = await this.db
      .select({ cloudRun: deployment.cloudRun })
      .from(deployment)
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          eq(deployment.status, 'done'),
          isNotNull(deployment.cloudRun),
        ),
      );
    return runs.some((run) => run.cloudRun?.kind === 'static');
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
        ),
      );
    return found ? readyOf(found) : null;
  }
}

/** The network, once made and holding what a Domain needs. */
function readyOf(network: EnvironmentNetwork): ReadyNetwork | null {
  if (
    network.status !== 'ready' ||
    !network.ipAddress ||
    !network.urlMapName ||
    !network.certificateMapName
  ) {
    return null;
  }
  return {
    ...network,
    ipAddress: network.ipAddress,
    urlMapName: network.urlMapName,
    certificateMapName: network.certificateMapName,
  };
}

/** The Domain certificates `tofu output` answered, by Domain id. */
function certificatesOf(
  value: unknown,
): Map<string, { name: string; validation: DnsRecord | null }> {
  const found = new Map<
    string,
    { name: string; validation: DnsRecord | null }
  >();
  if (!value || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const { id, validation } = (entry ?? {}) as {
      id?: unknown;
      validation?: unknown;
    };
    if (typeof id !== 'string' || id === '') continue;
    const first = Array.isArray(validation)
      ? (validation[0] as Partial<DnsRecord> | undefined)
      : undefined;
    found.set(key, {
      name: id,
      validation:
        first?.name && first.type && first.value
          ? { name: first.name, type: first.type, value: first.value }
          : null,
    });
  }
  return found;
}
