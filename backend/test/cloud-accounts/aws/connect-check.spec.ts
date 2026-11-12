import { runConnectCheck } from '../../../src/cloud-accounts/aws/connect-check';
import { instanceAwsPolicy } from '../../../src/cloud-accounts/aws/aws-policy';
import { FakeCloudPort } from '../../utils/fake-cloud-port';

const ACCOUNT = '123456789012';
const TAG = 'cloud-account-id-1';
const INPUT = {
  accountId: ACCOUNT,
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${TAG}`,
  taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution-${TAG}`,
  externalId: 'external-id-abc',
  tagValue: TAG,
};

/**
 * The connect check on a Cloud account whose role predates Stack VMs
 * (#1366): "Check now" names the missing session and instance actions as
 * the Stack VM gap, and says how to close it.
 */
describe('runConnectCheck: the Stack VM gap', () => {
  it.each([
    ['Self-hosted', false, 4],
    ['Hosted', true, 5],
  ])(
    'on a %s instance, names the Stack VM permissions a role lacks, and the fix',
    async (_, isHosted, version) => {
      const port = new FakeCloudPort();
      port.denyActions(['ssm:StartSession', 'ec2:RunInstances']);

      const result = await runConnectCheck(
        port,
        INPUT,
        instanceAwsPolicy({ isHosted }),
      );

      expect(result).toEqual({
        ok: false,
        step: 'permissions',
        deniedActions: ['ssm:StartSession', 'ec2:RunInstances'],
        message: `The deploy role is missing 2 actions of policy version ${version}: ssm:StartSession, ec2:RunInstances. They are the Stack VM permissions (Session Manager sessions to the Stack VMs Cloudgate marks, and making and removing a Stack VM with its volumes, daily snapshot policy, role and instance profile), which version ${version} adds. Update the role from the Cloud account's new setup template, which adds them as the managed policy cloudgate-deploy-stack-vm-${TAG}, then Check now`,
      });
    },
  );

  it('names no gap when what is missing is not a Stack VM permission', async () => {
    const port = new FakeCloudPort();
    port.denyActions(['ecs:CreateService']);

    const result = await runConnectCheck(
      port,
      INPUT,
      instanceAwsPolicy({ isHosted: false }),
    );

    expect(result).toMatchObject({
      ok: false,
      message:
        'The deploy role is missing 1 action of policy version 4: ecs:CreateService. Update it from the setup template',
    });
  });

  it('passes a role made from the new template, at the instance mode’s version', async () => {
    const port = new FakeCloudPort();
    expect(
      await runConnectCheck(
        port,
        INPUT,
        instanceAwsPolicy({ isHosted: false }),
      ),
    ).toEqual({ ok: true, policyVersion: 4 });
  });
});
