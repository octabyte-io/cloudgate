import { Inject, Injectable } from '@nestjs/common';

import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { CHANGED_NOTHING } from '../../cloud-accounts/cloud.port';
import type { TofuFailure } from '../../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import {
  findGoogleNetworkLeftovers,
  GOOGLE_CLEAN_NETWORK_REMOVAL_LINE,
  googleDeleteReportLines,
  subnetHeld,
} from '../../cloud-accounts/gcp/delete-check';
import type {
  GoogleLeftover,
  GoogleLeftoverCheck,
} from '../../cloud-accounts/gcp/delete-check';
import { destroyDefinition } from '../../cloud-accounts/gcp/definitions/destroy-definition';
import { RUN_APP_ZONE_PART } from '../../cloud-accounts/gcp/definitions/run-app-zone';
import { GOOGLE_CLOUD_PORT } from '../../cloud-accounts/google-cloud.port';
import type { GoogleCloudPort } from '../../cloud-accounts/google-cloud.port';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { NetworkLinkKind } from '../../cloud-accounts/definitions/network-links';
import type { EnvironmentNetwork } from '../../db/schema';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { environmentNetworkName } from '../../deployments/service-scope';

/**
 * How a Google network's removal ended, for `EnvironmentNetworkRemovals`
 * to write: nothing removed (the network is as it was), clean (the state
 * and row may go), or incomplete — `held` when what is left is Google's
 * subnet hold, which Cloudgate tries again by itself.
 */
export type GoogleNetworkRemovalOutcome =
  | { readonly kind: 'nothing-removed'; readonly message: string }
  | { readonly kind: 'clean'; readonly stateId: string | null }
  | {
      readonly kind: 'incomplete';
      readonly left: GoogleLeftover[];
      /** Why the run did not finish; `null` when it did and found something left. */
      readonly unfinished: string | null;
      readonly held: boolean;
    };

/**
 * **Removing a Google Environment network** (the Google Cloud spec, "Delete" and "The
 * subnet hold"; ADR-0038): the steps
 * `EnvironmentNetworkRemovals` runs in its destroy-only Cloud run once no
 * Service runs in the network.
 *
 * 1. **The destroy** of everything in the network's state, from a
 *    definition with no resource: the load balancer's pieces, the
 *    certificate map, the fixed IP, the private link's subnet and service
 *    connection policies, the subnet and the VPC network, in the
 *    order their references give.
 * 2. **The search** by the network's name prefix for each of its kinds,
 *    and for every entry left in its certificate map
 *    (`gcp/delete-check.ts`).
 *
 * Google keeps a subnet its services used for 1–2 hours after they are
 * gone, so the first removal after an Environment's Services usually ends
 * with the subnet and the VPC network left: that is **held**, and the
 * caller keeps the network `delete-incomplete` with Cloudgate's own next
 * try. A project that cannot be reached fails before anything is removed,
 * and an API turned off names the API and the setup step.
 */
@Injectable()
export class GoogleNetworkRemovalSteps {
  constructor(
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  async run(
    network: EnvironmentNetwork,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<GoogleNetworkRemovalOutcome> {
    const name = environmentNetworkName(network.region);
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) {
      return {
        kind: 'nothing-removed',
        message: `${session.refusal}. Nothing was removed`,
      };
    }
    const projectId = account.cloudId;
    const state = await this.states.findForNetwork(
      network.environmentNetworkId,
    );

    // 1. The destroy.
    let refusal: string | null = null;
    if (state) {
      await log(
        `🗑️ [Cloud run] Removing the ${name} from Cloud account ${account.name}: destroying everything in Infrastructure state ${state.infrastructureStateId}${heldParts(network.privateLinks)}`,
      );
      let began = false;
      const outcome = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: session.credential,
        definition: destroyDefinition(projectId, network.region),
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () => {
          if (control.beginApply()) {
            began = true;
            return null;
          }
          return ENDED_BEFORE_DESTROYING;
        },
      });
      if (!outcome.ok) {
        if (!began && CHANGED_NOTHING.has(outcome.reason)) {
          return {
            kind: 'nothing-removed',
            message: `${outcome.message} Nothing was removed`,
          };
        }
        refusal = googleRefusalReason(outcome.message, projectId);
        if (!began) {
          refusal = `${refusal} The run ended before it destroyed anything`;
        }
      }
    } else {
      await log(
        `🗑️ [Cloud run] The ${name} has no Infrastructure state: nothing was made for it in Google Cloud`,
      );
    }

    // 2. The search.
    let left: GoogleLeftover[] = [];
    let unchecked: string | null = null;
    if (control.signal.killed) {
      unchecked = 'The run was killed before it could check what is left';
    } else if (state) {
      await log('🔎 [Cloud run] Searching Google Cloud for anything left');
      const found = await this.search(account, network);
      if (found.ok) left = found.left;
      else unchecked = `What is left could not be checked: ${found.message}`;
    }
    // A search that did not happen says nothing about what is left (the live
    // walk, logged "Nothing was left" over a held subnet).
    if (unchecked === null) {
      for (const line of googleDeleteReportLines(
        left,
        GOOGLE_CLEAN_NETWORK_REMOVAL_LINE,
      )) {
        await log(line);
      }
    }
    if (refusal === null && unchecked === null && left.length === 0) {
      return { kind: 'clean', stateId: state?.infrastructureStateId ?? null };
    }
    const held = unchecked === null && subnetHeld(left, refusal);
    return {
      kind: 'incomplete',
      left,
      unfinished: held ? null : (refusal ?? unchecked),
      held,
    };
  }

  /** The search, with a fresh session: a destroy may outlast one. */
  private async search(
    account: GcpCloudAccount,
    network: EnvironmentNetwork,
  ): Promise<GoogleLeftoverCheck> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return { ok: false, message: session.refusal };
    return findGoogleNetworkLeftovers(this.google, session.token, {
      projectId: account.cloudId,
      region: network.region,
      environmentId: network.environmentId,
      certificateMap: network.certificateMapName,
    });
  }
}

/**
 * What the removal's first line names among what it destroys, beside the
 * network: its databases' private link and its Private web
 * services' `run.app` zone, each when the network holds it.
 */
function heldParts(links: readonly NetworkLinkKind[]): string {
  const parts = [
    ...(links.some((kind) => kind === 'cloud-sql' || kind === 'memorystore')
      ? ['its private link']
      : []),
    ...(links.includes('run-app-zone') ? [`its ${RUN_APP_ZONE_PART}`] : []),
  ];
  return parts.length > 0 ? `, ${parts.join(' and ')} among it` : '';
}

const ENDED_BEFORE_DESTROYING: TofuFailure = {
  ok: false,
  reason: 'interrupted',
  message: 'The run was ended before it destroyed anything.',
};
