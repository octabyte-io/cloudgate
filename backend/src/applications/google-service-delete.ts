import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

import type { GcpCloudAccount } from '../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { CHANGED_NOTHING } from '../cloud-accounts/cloud.port';
import type { TofuFailure } from '../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import {
  findGoogleLeftovers,
  GOOGLE_STORAGE_BUCKET_TYPE,
  googleDeleteReportLines,
  hostRulesLeft,
} from '../cloud-accounts/gcp/delete-check';
import type {
  GoogleLeftover,
  GoogleLeftoverCheck,
  SearchedDomain,
} from '../cloud-accounts/gcp/delete-check';
import {
  GOOGLE_LEFTOVER_RECHECK,
  LEFTOVER_RECHECK_MS,
} from './google-leftover-recheck';
import type { LeftoverRecheckTimer } from './google-leftover-recheck';
import { destroyDefinition } from '../cloud-accounts/gcp/definitions/destroy-definition';
import { LABEL_KEYS } from '../cloud-accounts/gcp/definitions/mark';
import { idKey } from '../cloud-accounts/gcp/definitions/names';
import {
  GCP_STATIC_BACKEND_ADDRESS,
  GCP_STATIC_GRANT_ADDRESS,
} from '../cloud-accounts/gcp/definitions/static-definition';
import { GOOGLE_CLOUD_PORT } from '../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import { describeError } from '../common/describe-error';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain } from '../db/schema';
import type { CloudRunControl } from '../deployment-queue/cloud-run-job.types';
import { GoogleDomainRuns } from '../project-config/applier/google-domain-runs.service';

/** What a Google Service's Delete is run on, read off its row. */
export interface GoogleDeleteTarget {
  readonly applicationId: string;
  readonly name: string;
  readonly environmentId: string;
  readonly cloudAccountId: string;
  readonly region: string;
  /**
   * Its Environment's Delete took every Domain off the network first
   * so the network step is skipped.
   */
  readonly networkStepDone?: boolean;
  /**
   * A `static` site's own Cloud Storage bucket, which its Delete
   * empties before the destroy; absent or `null` for any other Service.
   */
  readonly siteBucket?: string | null;
}

/**
 * How the steps ended, for `CloudServiceDeletes` to write: nothing removed
 * (the Service is as it was), clean (the state may go), or incomplete.
 */
export type GoogleDeleteOutcome =
  | { readonly kind: 'nothing-removed'; readonly message: string }
  | { readonly kind: 'clean'; readonly stateId: string | null }
  | {
      readonly kind: 'incomplete';
      readonly left: GoogleLeftover[];
      readonly unfinished: string | null;
      /** The summary's last sentence: what Retry does. */
      readonly summary: string;
    };

const RETRY = 'Retry starts again from the network step';

/**
 * **A Cloud Run Service's Delete on Google Cloud** (spec "Delete";
 * ADR-0038), the steps `CloudServiceDeletes`
 * runs in its destroy-only Cloud run, which waits as a run that touches
 * the network:
 *
 * 1. **The network step.** The network's Domain run, applied with the
 *    Service's Domains left out, removes its host rules and its Domains'
 *    DNS authorizations, certificates and map entries. A Service with no
 *    Domain, or whose network is not made, has nothing on it, and the
 *    step is skipped. If it fails, the Delete stops before touching the
 *    Service, which is Delete incomplete, its host rules, certificates and
 *    own resources listed as *Left* (S18). Within an Environment's Delete,
 *    whose own network run took every Domain off first, it is
 *    skipped.
 * 2. **The destroy** of everything in the Service's state, from a
 *    definition with no resource: backend service, NEG, Cloud Run service,
 *    repository, secrets, service account, in the order their references
 *    give.
 * 3. **The search** by name for each kind it made, and for each of its
 *    Domains' pieces (`gcp/delete-check.ts`).
 *
 * **A `static` site** (spec "Static site", story 53) has its
 * host rules, and under `spa` its error policy, taken off by the same
 * network step, and the Delete stops there if that fails, its bucket
 * untouched. Then its bucket is always emptied through the Google client
 * port before the destroy: its files are Cloudgate's copies of its build,
 * so no Delete asks about them. The destroy takes the bucket, the Cloud
 * CDN backend bucket and the load balancer's grant. An emptying that stops
 * partway destroys only the backend bucket and the grant, and the bucket,
 * with what is left of its files, is *Left*, "partly emptied".
 *
 * Retry runs all three again, always from the network step, which then
 * plans nothing. The Service's logs stay in the project's own log store,
 * which Cloudgate never owned, and expire there; they are not *Kept*.
 * A project that cannot be reached fails before anything is removed, and
 * an API turned off names the API and the setup step.
 */
@Injectable()
export class GoogleServiceDeleteSteps {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly moduleRef: ModuleRef,
    @Inject(GOOGLE_LEFTOVER_RECHECK)
    private readonly recheck: LeftoverRecheckTimer,
  ) {}

  /** The Domain runs live in the project-config module, which imports this one. */
  private get domainRuns(): GoogleDomainRuns {
    return this.moduleRef.get(GoogleDomainRuns, { strict: false });
  }

  async run(
    app: GoogleDeleteTarget,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<GoogleDeleteOutcome> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) {
      return {
        kind: 'nothing-removed',
        message: `${session.refusal}. Nothing was removed`,
      };
    }
    const projectId = account.cloudId;
    const domains = await this.domainsOf(app.applicationId);
    const maps = await this.domainRuns.networkMapsOf(app);
    const search = () =>
      this.search(account, {
        projectId,
        region: app.region,
        serviceId: app.applicationId,
        domains,
        certificateMap: maps?.certificateMapName ?? null,
        siteBucket: app.siteBucket ?? null,
      });

    // A control that remembers whether anything was applied, so a failure
    // before that removes nothing and puts the Service back as it was.
    let began = false;
    const watched: CloudRunControl = {
      signal: control.signal,
      beginApply: () => {
        const may = control.beginApply();
        if (may) began = true;
        return may;
      },
      holdTimeLimit: () => control.holdTimeLimit(),
    };

    // 1. The network step.
    if (app.networkStepDone) {
      await log(
        `🌐 [Cloud run] Network step: skipped, as the Environment's Delete took every Domain off the Environment network first`,
      );
    } else if (domains.length > 0 && maps) {
      await log(
        `🌐 [Cloud run] Network step: removing ${app.name}'s ${domains.length === 1 ? 'Domain' : `${domains.length} Domains`} from the Environment network's load balancer`,
      );
      try {
        await this.domainRuns.removeServiceDomains(app, watched, log);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (!began && control.signal.interrupted) {
          return {
            kind: 'nothing-removed',
            message: `${why} Nothing was removed`,
          };
        }
        await log(
          `❌ [Cloud run] The network step failed, so ${app.name} itself was not touched: ${why}`,
        );
        const found = await search();
        const left = [
          ...hostRulesLeft(maps.urlMapName, domains),
          ...(found.ok ? found.left : []),
        ];
        for (const line of googleDeleteReportLines(left)) await log(line);
        return {
          kind: 'incomplete',
          left,
          unfinished: `The network step failed before ${app.name} was touched: ${googleRefusalReason(why, projectId)}${found.ok ? '' : `. ${found.message}`}`,
          summary: RETRY,
        };
      }
    } else {
      await log(
        `🌐 [Cloud run] Network step: ${app.name} has no Domain on the Environment network, so there is nothing to remove from it`,
      );
    }

    const state = await this.states.findForApplication(app.applicationId);
    let unfinished: string | null = null;

    // A static site's own bucket, emptied before the destroy: Cloud Storage
    // deletes only an empty bucket.
    const siteBucket = state ? (app.siteBucket ?? null) : null;
    let partlyEmptied = false;
    let destroying = state !== null;
    if (siteBucket) {
      if (!watched.beginApply()) {
        if (!began) {
          return {
            kind: 'nothing-removed',
            message: `The run was ended before it emptied ${siteBucket}. Nothing was removed`,
          };
        }
        unfinished = `The run was ended before it emptied ${siteBucket}`;
        destroying = false;
      } else {
        await log(
          `🧹 [Cloud run] Emptying ${siteBucket}, the site's own bucket: every object`,
        );
        const emptied = await this.empty(session.token, siteBucket);
        if (emptied.ok) {
          await log(`${siteBucket} is empty`);
        } else {
          partlyEmptied = true;
          await log(
            `⚠️ [Cloud run] Emptying ${siteBucket} stopped partway: ${googleRefusalReason(emptied.message, projectId)}. The bucket is kept as it is; its backend bucket is destroyed`,
          );
        }
      }
    }

    // 2. The destroy.
    if (state && destroying) {
      await log(
        `🗑️ [Cloud run] Deleting ${app.name} from Cloud account ${account.name} in ${app.region}: destroying ${partlyEmptied ? 'everything but its bucket' : 'everything'} in Infrastructure state ${state.infrastructureStateId}`,
      );
      const outcome = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: session.credential,
        definition: destroyDefinition(projectId, app.region),
        ...(partlyEmptied
          ? { targets: [GCP_STATIC_BACKEND_ADDRESS, GCP_STATIC_GRANT_ADDRESS] }
          : {}),
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () =>
          watched.beginApply() ? null : ENDED_BEFORE_DESTROYING,
      });
      if (!outcome.ok) {
        if (!began && CHANGED_NOTHING.has(outcome.reason)) {
          return {
            kind: 'nothing-removed',
            message: `${outcome.message} Nothing was removed`,
          };
        }
        unfinished = googleRefusalReason(outcome.message, projectId);
      }
    } else if (!state) {
      await log(
        `🗑️ [Cloud run] ${app.name} has no Infrastructure state: nothing was made for it in Google Cloud`,
      );
    }

    // 3. The search.
    let left: GoogleLeftover[] = [];
    let searched = false;
    if (control.signal.killed) {
      unfinished ??= 'The run was killed before it could check what is left';
    } else {
      await log('🔎 [Cloud run] Searching Google Cloud for anything left');
      const found = await search();
      if (found.ok) {
        left = found.left;
        searched = true;
      } else {
        unfinished ??= `What is left could not be checked: ${found.message}`;
      }
    }
    // Left on purpose, whatever the search found: it still holds files.
    if (siteBucket && partlyEmptied && state) {
      left = [
        ...left.filter(
          (one) =>
            one.type !== GOOGLE_STORAGE_BUCKET_TYPE ||
            one.googleName !== siteBucket,
        ),
        {
          type: GOOGLE_STORAGE_BUCKET_TYPE,
          googleName: siteBucket,
          region: app.region,
          label: `${LABEL_KEYS.state}=${idKey(state.infrastructureStateId)}`,
          because: 'partly-emptied',
        },
      ];
    }
    // Only a search that happened says what is left, but a bucket
    // left partly emptied is named whatever the search did.
    if (searched || partlyEmptied) {
      for (const line of googleDeleteReportLines(left)) await log(line);
    }
    if (unfinished === null && left.length === 0) {
      return { kind: 'clean', stateId: state?.infrastructureStateId ?? null };
    }
    return {
      kind: 'incomplete',
      left,
      unfinished,
      summary: partlyEmptied
        ? `Retry starts again from the network step, empties ${siteBucket} again, then destroys it`
        : RETRY,
    };
  }

  /** A static site's bucket emptied through the Google client port. Never throws. */
  private async empty(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const answer = await this.google.emptyBucket(token, bucket);
      return answer.ok ? { ok: true } : { ok: false, message: answer.message };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  /**
   * The search, with a fresh session: a destroy may outlast one. A search
   * that finds anything looks again after {@link LEFTOVER_RECHECK_MS}, and
   * the second look is the answer: Google's lists trail a delete.
   */
  private async search(
    account: GcpCloudAccount,
    search: Parameters<typeof findGoogleLeftovers>[2],
  ): Promise<GoogleLeftoverCheck> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return { ok: false, message: session.refusal };
    const first = await findGoogleLeftovers(this.google, session.token, search);
    if (!first.ok || first.left.length === 0) return first;
    await this.recheck.wait(LEFTOVER_RECHECK_MS);
    return findGoogleLeftovers(this.google, session.token, search);
  }

  /** The Service's Domains on the load balancer: those a certificate was asked for. */
  private async domainsOf(applicationId: string): Promise<SearchedDomain[]> {
    return this.db
      .select({
        domainId: domain.domainId,
        host: domain.host,
        path: domain.path,
      })
      .from(domain)
      .where(
        and(
          eq(domain.applicationId, applicationId),
          isNotNull(domain.cloudCertificateStatus),
        ),
      )
      .orderBy(asc(domain.createdAt), asc(domain.domainId));
  }
}

const ENDED_BEFORE_DESTROYING: TofuFailure = {
  ok: false,
  reason: 'interrupted',
  message: 'The run was ended before it destroyed anything.',
};
