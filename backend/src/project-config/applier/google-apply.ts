import type { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import type {
  GoogleCredential,
  TofuApplyRequest,
} from '../../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import type { GoogleAccessToken } from '../../cloud-accounts/google-cloud.port';
import type { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { beforeApplyingApprovedOnGoogle } from './approved-run';
import type { ApprovedRun } from './approved-run';

// The tail every Cloud run on Google Cloud shares: the run's own proof (S16),
// and a `tofu` apply in it whose
// refusal is thrown in Google's words, read for an API that is off
// (`googleRefusalReason`). A database's create or change
// (`google-database-apply.ts`), a bucket's, a static site's and a bucket
// key's run each go through it.

/** A Cloud run's proof on Google Cloud: its credential, and its access token. */
export interface GoogleRunProof {
  readonly credential: GoogleCredential;
  readonly token: GoogleAccessToken;
}

/** The run's own proof, or its refusal thrown, naming the Cloud account. */
export async function googleRunProof(
  cloudAccounts: Pick<CloudAccountsService, 'googleRunSession'>,
  account: GcpCloudAccount,
): Promise<GoogleRunProof> {
  const session = await cloudAccounts.googleRunSession(account);
  if (!session.ok) throw new Error(session.refusal);
  return { credential: session.credential, token: session.token };
}

/**
 * One apply in the run's proof; Google's refusal thrown in its own words.
 * Answers the state's outputs.
 */
export async function applyOnGoogle(
  states: Pick<InfrastructureStatesService, 'apply'>,
  account: GcpCloudAccount,
  proof: GoogleRunProof,
  request: Omit<TofuApplyRequest<GoogleCredential>, 'credential'>,
): Promise<Record<string, unknown>> {
  const applied = await states.apply({
    ...request,
    credential: proof.credential,
  });
  if (!applied.ok) {
    throw new Error(googleRefusalReason(applied.message, account.cloudId));
  }
  return applied.outputs;
}

/**
 * {@link applyOnGoogle} for a run an Apply approved: read again first, and
 * applied only if Google read again makes what was approved
 * (`beforeApplyingApprovedOnGoogle`).
 */
export async function applyApprovedOnGoogle(
  states: Pick<InfrastructureStatesService, 'apply'>,
  account: GcpCloudAccount,
  proof: GoogleRunProof,
  run: {
    readonly approved: ApprovedRun;
    readonly control: CloudRunControl;
    readonly log: (line: string) => Promise<void>;
  },
  request: Omit<
    TofuApplyRequest<GoogleCredential>,
    'credential' | 'beforeApply' | 'onLine' | 'signal'
  >,
): Promise<Record<string, unknown>> {
  const { approved, control, log } = run;
  await log('Reading Google Cloud again before applying');
  return applyOnGoogle(states, account, proof, {
    ...request,
    onLine: (line) => void log(line),
    signal: control.signal,
    beforeApply: beforeApplyingApprovedOnGoogle(approved, log, control),
  });
}

/** An output's text, `null` when Google answered none. */
export function outputText(
  outputs: Record<string, unknown>,
  name: string,
): string | null {
  const value = outputs[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
