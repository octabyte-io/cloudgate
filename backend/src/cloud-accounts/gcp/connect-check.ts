import type { GoogleCloudPort } from '../google-cloud.port';
import { SHIPPED_GOOGLE_ROLE, stackVmAdditions } from './deploy-role';
import { STACK_VM_GAP, stackVmGapFix } from '../stack-vm-permissions';
import type { GoogleRole } from './deploy-role';
import {
  CHECK_TOKEN_SECONDS,
  signIdToken,
  tokenAudience,
  tokenSubject,
} from './id-token';
import type { SigningKey } from './id-token';

/** What the Google connect check is given: the form's values plus the Cloud account's own key and ids. */
export interface GoogleConnectCheckInput {
  /** The project id the operator typed. */
  projectId: string;
  cloudAccountId: string;
  /** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  workloadIdentityProvider: string;
  /** The deploy service account's email. */
  deployServiceAccount: string;
  /** The key the check's token is signed with. */
  signingKey: Pick<SigningKey, 'privateKey' | 'keyId'>;
  /** The issuer the token names (S16). */
  issuer: string;
}

/** The step a refusal came from, in the order they run. */
export type GoogleConnectCheckStep =
  | 'service-account'
  | 'sign-in'
  | 'impersonate'
  | 'project-id'
  | 'permissions'
  | 'apis';

export type GoogleConnectCheckResult =
  | { ok: true; policyVersion: number; projectNumber: string }
  | {
      ok: false;
      step: GoogleConnectCheckStep;
      /** One sentence for the operator, saying what to fix. */
      message: string;
      /** Every permission the role is missing, or every API that is off; empty for other steps. */
      missing: string[];
    };

/**
 * The Google connect check (the Google Cloud spec, "Connecting"), which
 * creates nothing:
 *
 * 1. the service account must be one of the typed project's — a pure check,
 *    before Google is called, since one in another project would make every
 *    Service's place name a project Cloudgate does not deploy into;
 * 2. sign an ID token (5 minutes) and trade it at STS;
 * 3. step into the deploy service account;
 * 4. `projects.get` answers the typed id, and its number is recorded;
 * 5. `testIamPermissions` with the role version's full list, naming every
 *    missing permission;
 * 6. Service Usage, naming every API the version needs that is off.
 *
 * It stops at the first failing step, since each depends on the one before.
 * There is no AWS-style "without the external id" step: the Cloud account's
 * own key does that job. Pure over the port: no database, and no token in
 * any refusal — Google's words name resources, never a token.
 */
export async function runGoogleConnectCheck(
  port: GoogleCloudPort,
  input: GoogleConnectCheckInput,
  role: GoogleRole = SHIPPED_GOOGLE_ROLE,
): Promise<GoogleConnectCheckResult> {
  const projectDomain = `@${input.projectId}.iam.gserviceaccount.com`;
  if (!input.deployServiceAccount.endsWith(projectDomain)) {
    return refuse(
      'service-account',
      `The deploy service account ${input.deployServiceAccount} is not in project ${input.projectId}. Use the one the setup script made there`,
    );
  }

  const subjectToken = signIdToken(input.signingKey, {
    issuer: input.issuer,
    subject: tokenSubject(input.cloudAccountId),
    workloadIdentityProvider: input.workloadIdentityProvider,
    lifetimeSeconds: CHECK_TOKEN_SECONDS,
  });
  const federated = await port.exchangeToken({
    audience: tokenAudience(input.workloadIdentityProvider),
    subjectToken,
  });
  if (!federated.ok) {
    return refuse(
      'sign-in',
      `Google's STS refused this Cloud account's token at ${input.workloadIdentityProvider}: ${said(federated.message)}. Check the provider name, and that it holds this Cloud account's JWKS from the setup script`,
    );
  }

  const impersonated = await port.impersonate(federated.value, {
    serviceAccount: input.deployServiceAccount,
    lifetimeSeconds: CHECK_TOKEN_SECONDS,
  });
  if (!impersonated.ok) {
    return refuse(
      'impersonate',
      `Cloudgate cannot act as the deploy service account ${input.deployServiceAccount}: ${said(impersonated.message)}. Grant this Cloud account's principal roles/iam.workloadIdentityUser on it, as the setup script does`,
    );
  }
  const session = impersonated.value;

  const project = await port.getProject(session, input.projectId);
  if (!project.ok) {
    return refuse(
      'project-id',
      `Google Cloud project ${input.projectId} could not be read as the deploy service account: ${said(project.message)}. Check the project id`,
    );
  }
  if (project.value.projectId !== input.projectId) {
    return refuse(
      'project-id',
      `The deploy service account reached project ${project.value.projectId}, not ${input.projectId}`,
    );
  }
  const projectNumber = project.value.projectNumber;

  const required = role.requiredPermissions(role.version);
  const tested = await port.testIamPermissions(
    session,
    input.projectId,
    required,
  );
  if (!tested.ok) {
    return refuse(
      'permissions',
      `Google refused to test the deploy service account's permissions: ${said(tested.message)}`,
    );
  }
  const granted = new Set(tested.value);
  const missingPermissions = required.filter(
    (permission) => !granted.has(permission),
  );
  if (missingPermissions.length > 0) {
    const missing = `The deploy service account is missing ${count(missingPermissions.length, 'permission')} of role version ${role.version}: ${missingPermissions.join(', ')}.`;
    const gap = stackVmGap(
      missingPermissions,
      stackVmAdditions(),
      role.version,
      input.cloudAccountId,
    );
    return refuse(
      'permissions',
      `${missing} ${gap ?? 'Update the role from the setup script'}`,
      missingPermissions,
    );
  }

  const apis = await port.enabledApis(session, projectNumber);
  if (!apis.ok) {
    return refuse(
      'apis',
      `Google refused to list the project's APIs: ${said(apis.message)}`,
    );
  }
  const on = new Set(apis.value);
  const off = role.requiredApis(role.version).filter((api) => !on.has(api));
  if (off.length > 0) {
    const missing = `${count(off.length, 'API')} Cloudgate needs ${off.length === 1 ? 'is' : 'are'} off in project ${input.projectId}: ${off.join(', ')}.`;
    const gap = stackVmGap(
      off,
      stackVmAdditions(),
      role.version,
      input.cloudAccountId,
    );
    return refuse(
      'apis',
      `${missing} ${gap ?? `Turn ${off.length === 1 ? 'it' : 'them'} on, as the setup script does`}`,
      off,
    );
  }

  return { ok: true, policyVersion: role.version, projectNumber };
}

/**
 * The Stack VM gap (#1366) among what is missing, named with its fix, or
 * `null` when none of it is a Stack VM's. `ofStackVms` is everything a
 * Stack VM adds (what a role with none of it lacks).
 */
function stackVmGap(
  missing: readonly string[],
  ofStackVms: ReadonlySet<string>,
  version: number,
  cloudAccountId: string,
): string | null {
  const ours = missing.filter((one) => ofStackVms.has(one));
  if (ours.length === 0) return null;
  const which =
    ours.length === missing.length
      ? missing.length === 1
        ? 'It is a part of'
        : 'They are'
      : `${ours.join(', ')} ${ours.length === 1 ? 'is a part of' : 'are'}`;
  return `${which} ${STACK_VM_GAP.gcp}, which version ${version} adds. ${stackVmGapFix('gcp', cloudAccountId)}`;
}

/** Google's words without their closing full stop, for a sentence that goes on. */
function said(message: string): string {
  return message.trim().replace(/\.+$/, '');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function refuse(
  step: GoogleConnectCheckStep,
  message: string,
  missing: string[] = [],
): GoogleConnectCheckResult {
  return { ok: false, step, message, missing };
}
