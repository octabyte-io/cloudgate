import { policyStanding } from '../../src/cloud-accounts/aws/policy-standing';
import {
  holdsStackVms,
  stackVmGapFix,
  stackVmPermissionsLacking,
} from '../../src/cloud-accounts/stack-vm-permissions';
import {
  AWS_POLICY_VERSION,
  requiredActions,
} from '../../src/cloud-accounts/aws/setup-template';

/** A version table with a second version that adds one action and drops one. */
const TABLE: Record<number, string[]> = {
  1: ['ec2:CreateVpc', 'ecs:CreateService', 'ec2:Old'],
  2: ['ec2:CreateVpc', 'ecs:CreateService', 'acm:RequestCertificate'],
};
const actionsOf = (version: number) => TABLE[version];

describe('policyStanding', () => {
  it('is up to date at the current version, with nothing missing', () => {
    expect(policyStanding(AWS_POLICY_VERSION)).toEqual({
      currentPolicyVersion: AWS_POLICY_VERSION,
      permissionsOutOfDate: false,
      missingActions: [],
    });
  });

  it('is out of date below the current version, listing only the added actions', () => {
    expect(policyStanding(1, 2, actionsOf)).toEqual({
      currentPolicyVersion: 2,
      permissionsOutOfDate: true,
      missingActions: ['acm:RequestCertificate'],
    });
  });

  it('is not out of date when the checked version is newer than this Cloudgate (a rollback)', () => {
    expect(policyStanding(3, 2, actionsOf).permissionsOutOfDate).toBe(false);
  });

  it("names what a role checked at version 1 lacks for a Private web service's private DNS", () => {
    const standing = policyStanding(1);
    expect(standing.permissionsOutOfDate).toBe(true);
    expect(standing.missingActions).toEqual(
      expect.arrayContaining([
        'servicediscovery:CreatePrivateDnsNamespace',
        'servicediscovery:CreateService',
        'route53:CreateHostedZone',
      ]),
    );
    expect(standing.missingActions).not.toContain('ecs:CreateService');
    // Cloud Map removes the zone itself; the role never holds its delete.
    expect(standing.missingActions).not.toContain('route53:DeleteHostedZone');
  });

  it("names RunTask, which a Cron service's runs need, on a role checked at version 1", () => {
    const standing = policyStanding(1);
    expect(standing.permissionsOutOfDate).toBe(true);
    expect(standing.missingActions).toContain('ecs:RunTask');
    // StopTask was version 1's already.
    expect(standing.missingActions).not.toContain('ecs:StopTask');
  });

  it('reads the shipped version table by default', () => {
    expect(requiredActions(AWS_POLICY_VERSION).length).toBeGreaterThan(0);
    expect(policyStanding(AWS_POLICY_VERSION).missingActions).toEqual([]);
  });

  it('asks a Self-hosted role at version 2 for the Stack VM actions and never for CodeBuild', () => {
    const standing = policyStanding(2, 4);
    expect(standing.missingActions).toContain('ssm:StartSession');
    expect(standing.missingActions.join(' ')).not.toContain('codebuild');
  });
});

/**
 * The Stack VM gap (#1366): what a Cloud account last checked at an older
 * version lacks for a Stack VM, read from the version tables alone. The
 * versions fork by instance mode (ADR-0047), so the Hosted and the
 * Self-hosted version before Stack VMs both have the gap, and neither
 * Stack VM version does.
 */
describe('stackVmPermissionsLacking', () => {
  it.each([
    ['aws', 2],
    ['aws', 3],
    ['gcp', 5],
    ['gcp', 6],
  ] as const)('names what a %s role at version %i lacks', (cloud, version) => {
    expect(holdsStackVms(cloud, version)).toBe(false);
    const lacking = stackVmPermissionsLacking(cloud, version);
    expect(lacking).toEqual(
      expect.arrayContaining(
        cloud === 'aws'
          ? [
              'ssm:StartSession',
              'ec2:RunInstances',
              'iam:CreateInstanceProfile',
            ]
          : [
              'iap.tunnelInstances.accessViaIAP',
              'compute.instances.create',
              'iap.googleapis.com',
            ],
      ),
    );
    // Nothing for a build: a Self-hosted account is never asked for one.
    expect(lacking.join(' ')).not.toMatch(/codebuild|cloudbuild/);
  });

  it.each([
    ['aws', 4],
    ['aws', 5],
    ['gcp', 7],
    ['gcp', 8],
  ] as const)('names nothing for a %s role at version %i', (cloud, version) => {
    expect(holdsStackVms(cloud, version)).toBe(true);
    expect(stackVmPermissionsLacking(cloud, version)).toEqual([]);
  });

  it("says how to close it on each cloud, naming the AWS Cloud account's Stack VM policy", () => {
    expect(stackVmGapFix('aws', 'acct-1')).toBe(
      "Update the role from the Cloud account's new setup template, which adds them as the managed policy cloudgate-deploy-stack-vm-acct-1, then Check now",
    );
    expect(stackVmGapFix('gcp', 'acct-1')).toContain('setup script');
  });
});
