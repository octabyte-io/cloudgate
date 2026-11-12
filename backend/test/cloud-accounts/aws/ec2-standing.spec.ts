import type { ConfigService } from '@nestjs/config';
import {
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  EC2ServiceException,
} from '@aws-sdk/client-ec2';

import { AwsCloudAdapter } from '../../../src/cloud-accounts/aws/aws-cloud.adapter';
import type { Env } from '../../../src/common/config/env.schema';

const SESSION = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'token',
};
const REGION = 'us-east-1';
const arn = (resource: string) =>
  `arn:aws:ec2:${REGION}:123456789012:${resource}`;
const ok = { $metadata: { httpStatusCode: 200 } };

/** What EC2 throws for an id it does not have, in its own code. */
function notFound(code: string, id: string): EC2ServiceException {
  return new EC2ServiceException({
    name: code,
    $fault: 'client',
    message: `The ID '${id}' does not exist`,
    $metadata: { httpStatusCode: 400 },
  });
}

/**
 * `ec2Standing` against the shapes EC2's Describe calls answer with and the
 * `Invalid…ID.NotFound` they throw for an id that is gone, with the
 * SDK client's `send` stubbed, so nothing reaches AWS.
 */
describe('AwsCloudAdapter ec2Standing', () => {
  const adapter = new AwsCloudAdapter({
    get: () => 'unused',
  } as unknown as ConfigService<Env, true>);
  let send: jest.SpyInstance;

  beforeEach(() => {
    send = jest.spyOn(EC2Client.prototype, 'send');
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts as gone each subnet EC2 answers InvalidSubnetID.NotFound for', async () => {
    send.mockImplementation((command: DescribeSubnetsCommand) =>
      Promise.reject(
        notFound(
          'InvalidSubnetID.NotFound',
          (command.input.SubnetIds ?? []).join(', '),
        ),
      ),
    );

    const answer = await adapter.ec2Standing(SESSION, {
      region: REGION,
      arns: [arn('subnet/subnet-0dd6'), arn('subnet/subnet-0f3e')],
    });

    expect(answer).toEqual({ ok: true, value: { live: [] } });
    const asked = send.mock.calls.map(
      ([command]: [DescribeSubnetsCommand]) => command.input.SubnetIds,
    );
    // One batch, then each id alone, since a batch's NotFound does not say
    // which of them EC2 has.
    expect(asked).toEqual([
      ['subnet-0dd6', 'subnet-0f3e'],
      ['subnet-0dd6'],
      ['subnet-0f3e'],
    ]);
  });

  it('keeps live each resource EC2 still describes, by type, and drops the one it does not have', async () => {
    send.mockImplementation((command: unknown) => {
      if (command instanceof DescribeVpcsCommand) {
        return Promise.resolve({ Vpcs: [{ VpcId: 'vpc-1' }], ...ok });
      }
      if (command instanceof DescribeSubnetsCommand) {
        const ids = command.input.SubnetIds ?? [];
        if (ids.includes('subnet-gone')) {
          return Promise.reject(
            notFound('InvalidSubnetID.NotFound', 'subnet-gone'),
          );
        }
        return Promise.resolve({
          Subnets: ids.map((SubnetId) => ({ SubnetId })),
          ...ok,
        });
      }
      if (command instanceof DescribeSecurityGroupsCommand) {
        return Promise.reject(notFound('InvalidGroup.NotFound', 'sg-1'));
      }
      if (command instanceof DescribeRouteTablesCommand) {
        return Promise.resolve({
          RouteTables: [{ RouteTableId: 'rtb-1' }],
          ...ok,
        });
      }
      if (command instanceof DescribeInternetGatewaysCommand) {
        return Promise.reject(
          notFound('InvalidInternetGatewayID.NotFound', 'igw-1'),
        );
      }
      return Promise.reject(new Error('not an EC2 call this spec answers'));
    });

    const answer = await adapter.ec2Standing(SESSION, {
      region: REGION,
      arns: [
        arn('vpc/vpc-1'),
        arn('subnet/subnet-live'),
        arn('subnet/subnet-gone'),
        arn('security-group/sg-1'),
        arn('route-table/rtb-1'),
        arn('internet-gateway/igw-1'),
      ],
    });

    expect(answer).toEqual({
      ok: true,
      value: {
        live: [
          arn('vpc/vpc-1'),
          arn('subnet/subnet-live'),
          arn('route-table/rtb-1'),
        ],
      },
    });
  });

  it('keeps live, unasked, an EC2 type it has no Describe for', async () => {
    const answer = await adapter.ec2Standing(SESSION, {
      region: REGION,
      arns: [arn('natgateway/nat-1')],
    });

    expect(answer).toEqual({
      ok: true,
      value: { live: [arn('natgateway/nat-1')] },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("answers a refusal in EC2's own words", async () => {
    send.mockRejectedValue(
      new EC2ServiceException({
        name: 'UnauthorizedOperation',
        $fault: 'client',
        message: 'You are not authorized to perform this operation.',
        $metadata: { httpStatusCode: 403 },
      }),
    );

    const answer = await adapter.ec2Standing(SESSION, {
      region: REGION,
      arns: [arn('vpc/vpc-1')],
    });

    expect(answer).toEqual({
      ok: false,
      code: 'UnauthorizedOperation',
      message: 'You are not authorized to perform this operation.',
    });
  });
});
