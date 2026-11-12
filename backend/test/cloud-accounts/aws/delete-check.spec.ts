import { findLeftovers } from '../../../src/cloud-accounts/aws/delete-check';
import { FakeCloudPort } from '../../utils/fake-cloud-port';

const REGION = 'us-east-1';
const STATE = 'state-1';
const TAGS = { 'cloudgate:state': STATE };
const SESSION = {
  accessKeyId: 'ASIA',
  secretAccessKey: 's',
  sessionToken: 'fake-session-token',
};
const subnet = (id: string) =>
  `arn:aws:ec2:${REGION}:123456789012:subnet/subnet-${id}`;
const SEARCH = {
  region: REGION,
  stateId: STATE,
  iamRoleNames: [],
  securityGroupIds: [],
};

/**
 * The check after a destroy against what AWS's tag index keeps: an
 * Environment network's removal on the live walk found its two subnets
 * still listed minutes after EC2 had deleted them.
 */
describe('findLeftovers', () => {
  let cloud: FakeCloudPort;

  beforeEach(() => {
    cloud = new FakeCloudPort();
  });

  it('counts as gone the EC2 resources the tag index lists and EC2 says are deleted', async () => {
    cloud.leaveEc2Ghost(REGION, subnet('0dd6ce384f2683b9f'), TAGS);
    cloud.leaveEc2Ghost(REGION, subnet('0f3e40b8c7bc11ea5'), TAGS);

    const check = await findLeftovers(cloud, SESSION, SEARCH);

    expect(check).toEqual({ ok: true, left: [] });
    expect(cloud.calls).toContainEqual({
      method: 'ec2Standing',
      region: REGION,
      arns: [subnet('0dd6ce384f2683b9f'), subnet('0f3e40b8c7bc11ea5')],
    });
  });

  it('lists an EC2 resource EC2 still describes', async () => {
    cloud.leaveEc2Ghost(REGION, subnet('0dd6ce384f2683b9f'), TAGS);
    cloud.leaveTagged(REGION, subnet('0f3e40b8c7bc11ea5'), TAGS);

    const check = await findLeftovers(cloud, SESSION, SEARCH);

    expect(check).toEqual({
      ok: true,
      left: [
        {
          type: 'ec2:subnet',
          awsId: subnet('0f3e40b8c7bc11ea5'),
          region: REGION,
          tag: `cloudgate:state=${STATE}`,
        },
      ],
    });
  });

  it('asks EC2 nothing when the tag search found no EC2 resource', async () => {
    const check = await findLeftovers(cloud, SESSION, SEARCH);

    expect(check).toEqual({ ok: true, left: [] });
    expect(cloud.calls.map((call) => call.method)).not.toContain('ec2Standing');
  });

  it('is a check that did not happen when EC2 refuses to say', async () => {
    cloud.leaveEc2Ghost(REGION, subnet('0dd6ce384f2683b9f'), TAGS);
    cloud.refuseEc2Standing(
      'UnauthorizedOperation',
      'You are not authorized to perform this operation.',
    );

    const check = await findLeftovers(cloud, SESSION, SEARCH);

    expect(check).toEqual({
      ok: false,
      message:
        'The check of EC2 resources was refused: AWS answered UnauthorizedOperation: You are not authorized to perform this operation.',
    });
  });
});
