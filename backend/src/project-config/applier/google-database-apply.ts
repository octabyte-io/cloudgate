import type { TofuDefinition } from '../../cloud-accounts/definitions/tofu-json';
import type { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import type { GcpNetworkNames } from '../../cloud-accounts/gcp/definitions/stand-ins';
import type { GoogleAccessToken } from '../../cloud-accounts/google-cloud.port';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import type { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { googleNetworkNames } from '../cloud-sql-places';
import type { ApprovedRun } from './approved-run';
import {
  applyApprovedOnGoogle,
  googleRunProof,
  outputText,
} from './google-apply';

// What a postgres on Cloud SQL's and a redis on Memorystore's create or
// change share: the place, its Infrastructure state and made
// Environment network, the approved read, the run's own proof (S16), and the
// apply that holds to that read. Each run then saves its own outputs.

/** A database row on Google Cloud, as far as its run reads it. */
interface GoogleDatabaseRow {
  readonly name: string;
  readonly configName: string | null;
  readonly environmentId: string;
  readonly region: string | null;
}

/** What one database's definition writes, or why it cannot. */
type Written =
  | {
      readonly ok: true;
      readonly definition: TofuDefinition;
      readonly variables: Record<string, string>;
    }
  | { readonly ok: false; readonly message: string };

/** An applied database run: what its caller reads its outputs and token from. */
export interface GoogleDatabaseApplied<A extends ApprovedRun> {
  readonly name: string;
  readonly region: string;
  readonly approved: A;
  readonly token: GoogleAccessToken;
  readonly outputs: Record<string, unknown>;
  /** An output's text, `null` when Google answered none. */
  readonly text: (output: string) => string | null;
  readonly verb: 'changed' | 'made';
}

/**
 * Applies a database's definition in its Google Cloud project, only if
 * Google read again makes what the Apply approved. Each refusal throws,
 * naming the database: no region, no Infrastructure state, no made
 * Environment network, no applied plan, no proof, or Google's own words.
 */
export async function applyGoogleDatabase<A extends ApprovedRun>(
  deps: {
    readonly db: DrizzleDB;
    readonly states: InfrastructureStatesService;
    readonly cloudAccounts: CloudAccountsService;
  },
  input: {
    readonly found: GoogleDatabaseRow;
    readonly account: GcpCloudAccount;
    /** The Google product it is made on, as the run's line names it. */
    readonly product: string;
    readonly state: (name: string) => Promise<InfrastructureState | null>;
    readonly approved: (name: string) => Promise<A | null>;
    readonly write: (place: {
      readonly stateId: string;
      readonly network: GcpNetworkNames;
    }) => Written;
    readonly control: CloudRunControl;
    readonly log: (line: string) => Promise<void>;
    /**
     * Google's refusal of the apply in other words: a value only
     * Google can judge names the `native.gcp` path it refused. Absent, its
     * own words.
     */
    readonly blame?: (message: string) => string;
  },
): Promise<GoogleDatabaseApplied<A>> {
  const { found, account, control, log } = input;
  const name = found.configName ?? found.name;
  if (!found.region) {
    throw new Error(`${name} does not run in a Cloud account region`);
  }
  const region = found.region;
  const state = await input.state(name);
  if (!state) throw new Error(`${name} has no Infrastructure state`);
  const network = await googleNetworkNames(deps.db, {
    environmentId: found.environmentId,
    cloudAccountId: account.cloudAccountId,
    region,
  });
  if (network.standIns) {
    throw new Error(
      `The Environment network in ${region} is not made, so ${name} has no private link to take its address from`,
    );
  }
  const approved = await input.approved(name);
  if (!approved) {
    throw new Error(
      'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
    );
  }
  const proof = await googleRunProof(deps.cloudAccounts, account);

  const written = input.write({
    stateId: state.infrastructureStateId,
    network: network.names,
  });
  if (!written.ok) throw new Error(written.message);
  await log(
    `☁️ [Cloud run] ${approved.change ? 'Changing' : 'Creating'} ${name} on ${input.product} in Cloud account ${account.name} in ${region}, Infrastructure state ${state.infrastructureStateId}`,
  );
  const outputs = await applyApprovedOnGoogle(
    deps.states,
    account,
    proof,
    { approved, control, log },
    {
      stateId: state.infrastructureStateId,
      definition: written.definition,
      variables: written.variables,
    },
  ).catch((error: unknown) => {
    if (!input.blame || !(error instanceof Error)) throw error;
    throw new Error(input.blame(error.message));
  });
  return {
    name,
    region,
    approved,
    token: proof.token,
    outputs,
    text: (output) => outputText(outputs, output),
    verb: approved.change ? 'changed' : 'made',
  };
}
