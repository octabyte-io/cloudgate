import type {
  AwsCloudPort,
  AwsCredential,
  Ec2NetworkAction,
} from '../cloud.port';
import { VPCS_PER_REGION } from './regions';
import { SHIPPED_AWS_POLICY } from './aws-policy';
import type { AwsPolicy } from './aws-policy';
import { CLOUD_ACCOUNT_TAG_KEY } from './setup-template';
import { STACK_VM_GAP, stackVmGapFix } from '../stack-vm-permissions';

/** What the connect check is given: the form's values plus the Cloud account's own ids. */
export interface ConnectCheckInput {
  /** The AWS account id the operator typed. */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  deployRoleArn: string;
  taskExecutionRoleArn: string;
  externalId: string;
  /** The Cloud account's tag value — its id. */
  tagValue: string;
}

/** The step a refusal came from, in the order they run. */
export type ConnectCheckStep =
  'sign-in' | 'assume-role' | 'account-id' | 'external-id' | 'permissions';

export type ConnectCheckResult =
  | { ok: true; policyVersion: number }
  | {
      ok: false;
      step: ConnectCheckStep;
      /** One sentence for the operator, saying what to fix. */
      message: string;
      /** Every action the simulation denied, each once; empty for other steps. */
      deniedActions: string[];
    };

/**
 * The connect check (the AWS spec, "Connecting (AWS)"), which creates
 * nothing:
 *
 * 1. sign in with the key;
 * 2. take on the deploy role with the external id;
 * 3. check that `GetCallerIdentity` answers the account id the operator typed;
 * 4. take on the role **without** the external id, and refuse if that works —
 *    AWS's own advice for a role a third party assumes;
 * 5. simulate every action of the current policy version on the role, with
 *    this Cloud account's tag as context, naming every denied one.
 *
 * It stops at the first failing step, since each depends on the one before.
 * Pure over the port: no database, no secret in any answer — AWS's messages
 * name ARNs, never the key.
 */
export async function runConnectCheck(
  port: AwsCloudPort,
  input: ConnectCheckInput,
  policy: AwsPolicy = SHIPPED_AWS_POLICY,
): Promise<ConnectCheckResult> {
  const key: AwsCredential = {
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
  };
  const sessionName = `cloudgate-${input.tagValue}`.slice(0, 64);

  const signedIn = await port.callerIdentity(key);
  if (!signedIn.ok) {
    return refuse(
      'sign-in',
      `AWS refused the access key ${input.accessKeyId}: ${signedIn.message}`,
    );
  }

  const assumed = await port.assumeRole(key, {
    roleArn: input.deployRoleArn,
    externalId: input.externalId,
    sessionName,
  });
  if (!assumed.ok) {
    return refuse(
      'assume-role',
      `The access key cannot take on the deploy role ${input.deployRoleArn} with this Cloud account's external id: ${assumed.message}`,
    );
  }
  const session = assumed.value;

  const identity = await port.callerIdentity(session);
  if (!identity.ok) {
    return refuse(
      'assume-role',
      `AWS refused the deploy role's session: ${identity.message}`,
    );
  }
  if (identity.value.account !== input.accountId) {
    return refuse(
      'account-id',
      `The deploy role is in AWS account ${identity.value.account}, not ${input.accountId}`,
    );
  }

  const withoutExternalId = await port.assumeRole(key, {
    roleArn: input.deployRoleArn,
    externalId: null,
    sessionName,
  });
  if (withoutExternalId.ok) {
    return refuse(
      'external-id',
      `The deploy role ${input.deployRoleArn} can be taken on without the external id. Add the sts:ExternalId condition from the setup template to its trust policy`,
    );
  }

  const denied = new Set<string>();
  // Denied only on a Stack VM statement's checks: the Stack VM gap
  // (#1366). An action denied elsewhere too (`iam:PassRole`) is not the
  // gap's alone.
  const deniedForStackVms = new Set<string>();
  const deniedElsewhere = new Set<string>();
  for (const check of policy.simulationChecks({
    accountId: input.accountId,
    tagValue: input.tagValue,
    deployRoleArn: input.deployRoleArn,
    taskExecutionRoleArn: input.taskExecutionRoleArn,
  })) {
    const simulated = await port.simulatePrincipalPolicy(session, {
      policySourceArn: input.deployRoleArn,
      actions: check.actions,
      resourceArn: check.resourceArn,
      context: check.context,
    });
    if (!simulated.ok) {
      // Most often the role lacks iam:SimulatePrincipalPolicy on itself,
      // which leaves every other action unknown rather than denied.
      return refuse(
        'permissions',
        `AWS refused to simulate the deploy role's permissions: ${simulated.message}`,
        ['iam:SimulatePrincipalPolicy'],
      );
    }
    for (const { action, decision } of simulated.value) {
      if (decision === 'allowed') continue;
      denied.add(action);
      (check.stackVm ? deniedForStackVms : deniedElsewhere).add(action);
    }
  }
  for (const action of deniedElsewhere) deniedForStackVms.delete(action);
  if (denied.size > 0) {
    const deniedActions = [...denied];
    const missing = `The deploy role is missing ${deniedActions.length} ${deniedActions.length === 1 ? 'action' : 'actions'} of policy version ${policy.version}: ${deniedActions.join(', ')}.`;
    if (deniedForStackVms.size === 0) {
      return refuse(
        'permissions',
        `${missing} Update it from the setup template`,
        deniedActions,
      );
    }
    const which =
      deniedForStackVms.size === denied.size
        ? 'They are'
        : `${[...deniedForStackVms].join(', ')} ${deniedForStackVms.size === 1 ? 'is a part of' : 'are'}`;
    return refuse(
      'permissions',
      `${missing} ${which} ${STACK_VM_GAP.aws}, which version ${policy.version} adds. ${stackVmGapFix('aws', input.tagValue)}`,
      deniedActions,
    );
  }

  return { ok: true, policyVersion: policy.version };
}

/** What the region check is given: a saved Cloud account's ids and the region chosen. */
export type RegionCheckInput = ConnectCheckInput & { region: string };

export type RegionCheckResult =
  | {
      ok: true;
      /** Sentences to show beside the saved choice; it is kept either way. */
      warnings: string[];
    }
  | {
      ok: false;
      /** One sentence naming the region and what to fix. */
      message: string;
      /** Every action the simulation or a dry run refused, each once. */
      deniedActions: string[];
    };

/**
 * The parts of an Environment network the region check dry-runs: the two that
 * name no VPC. A subnet, route table or security group names the VPC it goes
 * in, and none exists yet when the region is chosen; real EC2 checks IAM
 * before it looks the VPC up, and the policy's tag condition on the VPC
 * cannot hold for a VPC that is not there, so their dry runs were refused in
 * every real account. Nothing is lost by leaving them out: that the
 * role may make them in the region is the simulation's to show (step 2
 * simulates every action with `aws:RequestedRegion`), and an SCP or a region
 * not enabled refuses these two dry runs as well.
 */
export const NETWORK_DRY_RUNS: readonly Ec2NetworkAction[] = [
  'CreateVpc',
  'CreateInternetGateway',
];

/** The VPC id the dry-run port takes, naming no VPC anyone has. */
export const STAND_IN_VPC_ID = 'vpc-00000000000000000';

/**
 * The answers to a dry run that mean "this role may not": IAM's refusal, an
 * SCP's (also `UnauthorizedOperation`), and a region the account has not
 * enabled.
 */
const DRY_RUN_REFUSALS = new Set([
  'UnauthorizedOperation',
  'AccessDenied',
  'AccessDeniedException',
  'OptInRequired',
  'AuthFailure',
  'UnrecognizedClientException',
]);

/**
 * The region check (spec "The region check"), run when an
 * Environment's Deploy target is set to this Cloud account and a region.
 * Creates nothing:
 *
 * 1. take on the deploy role with the external id;
 * 2. simulate every action of the current policy version in the region
 *    (`aws:RequestedRegion` and regional ARNs);
 * 3. dry-run each EC2 create an Environment network needs, in the region —
 *    what an SCP or a region not enabled refuses, which the simulator cannot
 *    see;
 * 4. count the region's VPCs, warning when one more would reach AWS's
 *    default quota of {@link VPCS_PER_REGION}.
 *
 * Steps 2 and 3 both run, so one refusal names every denied action at once.
 */
export async function runRegionCheck(
  port: AwsCloudPort,
  input: RegionCheckInput,
  policy: AwsPolicy = SHIPPED_AWS_POLICY,
): Promise<RegionCheckResult> {
  const { region } = input;
  const assumed = await port.assumeRole(
    { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    {
      roleArn: input.deployRoleArn,
      externalId: input.externalId,
      sessionName: `cloudgate-${input.tagValue}`.slice(0, 64),
    },
  );
  if (!assumed.ok) {
    return {
      ok: false,
      message: `The Cloud account cannot take on its deploy role ${input.deployRoleArn} to check ${region}: ${assumed.message}`,
      deniedActions: [],
    };
  }
  const session = assumed.value;

  const denied = new Set<string>();
  for (const check of policy.simulationChecks({
    accountId: input.accountId,
    tagValue: input.tagValue,
    deployRoleArn: input.deployRoleArn,
    taskExecutionRoleArn: input.taskExecutionRoleArn,
    region,
  })) {
    const simulated = await port.simulatePrincipalPolicy(session, {
      policySourceArn: input.deployRoleArn,
      actions: check.actions,
      resourceArn: check.resourceArn,
      context: check.context,
    });
    if (!simulated.ok) {
      return {
        ok: false,
        message: `AWS refused to simulate the deploy role's permissions in ${region}: ${simulated.message}`,
        deniedActions: ['iam:SimulatePrincipalPolicy'],
      };
    }
    for (const { action, decision } of simulated.value) {
      if (decision !== 'allowed') denied.add(action);
    }
  }

  const unexpected: string[] = [];
  for (const action of NETWORK_DRY_RUNS) {
    const tried = await port.ec2DryRun(session, {
      region,
      action,
      tags: { [CLOUD_ACCOUNT_TAG_KEY]: input.tagValue },
      vpcId: STAND_IN_VPC_ID,
    });
    if (tried.ok) continue;
    denied.add(`ec2:${action}`);
    if (!DRY_RUN_REFUSALS.has(tried.code)) {
      unexpected.push(`ec2:${action}: ${tried.message}`);
    }
  }

  if (denied.size > 0) {
    const deniedActions = [...denied];
    return {
      ok: false,
      message:
        `The deploy role cannot work in ${region}: AWS denies ${deniedActions.join(', ')}. ` +
        (unexpected.length > 0
          ? `AWS answered ${unexpected.join('; ')}. `
          : '') +
        'Update the role from the setup template, or allow the region in the AWS account',
      deniedActions,
    };
  }

  const warnings: string[] = [];
  const vpcs = await port.countVpcs(session, region);
  if (!vpcs.ok) {
    warnings.push(
      `Cloudgate could not count the VPCs in ${region} (${vpcs.message}), so it cannot say whether the AWS account has room for the Environment network's`,
    );
  } else if (vpcs.value >= VPCS_PER_REGION - 1) {
    warnings.push(
      `The AWS account has ${vpcs.value} VPCs in ${region}, and AWS allows ${VPCS_PER_REGION} per region unless the quota is raised. ` +
        (vpcs.value >= VPCS_PER_REGION
          ? "The Environment network's VPC will not fit: raise the quota or remove a VPC before the first deploy here"
          : "The Environment network's VPC takes the last one"),
    );
  }
  return { ok: true, warnings };
}

function refuse(
  step: ConnectCheckStep,
  message: string,
  deniedActions: string[] = [],
): ConnectCheckResult {
  return { ok: false, step, message, deniedActions };
}
