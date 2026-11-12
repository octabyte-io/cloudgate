import type { ConfigService } from '@nestjs/config';
import {
  ElastiCacheClient,
  SnapshotNotFoundFault,
} from '@aws-sdk/client-elasticache';
import {
  DBInstanceNotFoundFault,
  DBSnapshotNotFoundFault,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  InvalidDBInstanceStateFault,
  ModifyDBInstanceCommand,
  RDSClient,
} from '@aws-sdk/client-rds';

import {
  AwsCloudAdapter,
  cacheSizeGib,
} from '../../../src/cloud-accounts/aws/aws-cloud.adapter';
import type { Env } from '../../../src/common/config/env.schema';

const SESSION = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'token',
};
const REGION = 'eu-central-1';
const meta = { $metadata: { httpStatusCode: 400 } };

/**
 * The database side of the cloud port's direct calls, each against
 * the shape AWS answers it with — what `ModifyDBInstance`,
 * `DescribeDBSnapshots` and ElastiCache's `DescribeSnapshots` return, and
 * the faults they throw — with the SDK client's `send` stubbed, so nothing
 * reaches AWS.
 */
describe('AwsCloudAdapter database calls', () => {
  const adapter = new AwsCloudAdapter({
    get: () => 'unused',
  } as unknown as ConfigService<Env, true>);
  let rdsSend: jest.SpyInstance;
  let cacheSend: jest.SpyInstance;

  beforeEach(() => {
    rdsSend = jest.spyOn(RDSClient.prototype, 'send');
    cacheSend = jest.spyOn(ElastiCacheClient.prototype, 'send');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('rdsLiftDeletionProtection', () => {
    const found = (deletionProtection: boolean) => ({
      DBInstances: [
        {
          DBInstanceIdentifier: 'cloudgate-pg1',
          DBInstanceStatus: 'available',
          DeletionProtection: deletionProtection,
        },
      ],
      $metadata: { httpStatusCode: 200 },
    });
    const notFound = () =>
      new DBInstanceNotFoundFault({
        message: 'DBInstance cloudgate-pg1 not found.',
        ...meta,
      });

    it('modifies the instance with DeletionProtection off, at once', async () => {
      rdsSend.mockResolvedValueOnce(found(true)).mockResolvedValueOnce({
        DBInstance: {
          DBInstanceIdentifier: 'cloudgate-pg1',
          DBInstanceStatus: 'available',
          DeletionProtection: false,
          PendingModifiedValues: {},
        },
        $metadata: { httpStatusCode: 200 },
      });

      const answer = await adapter.rdsLiftDeletionProtection(SESSION, {
        region: REGION,
        identifier: 'cloudgate-pg1',
      });

      expect(answer).toEqual({ ok: true, value: 'lifted' });
      const [describe] = rdsSend.mock.calls[0] as [DescribeDBInstancesCommand];
      expect(describe).toBeInstanceOf(DescribeDBInstancesCommand);
      expect(describe.input).toEqual({ DBInstanceIdentifier: 'cloudgate-pg1' });
      const [command] = rdsSend.mock.calls[1] as [ModifyDBInstanceCommand];
      expect(command).toBeInstanceOf(ModifyDBInstanceCommand);
      expect(command.input).toEqual({
        DBInstanceIdentifier: 'cloudgate-pg1',
        DeletionProtection: false,
        ApplyImmediately: true,
      });
    });

    // A Retry after a destroy that went through: the deploy role may
    // modify only an instance carrying its tag, so RDS answers ModifyDBInstance
    // on a gone instance with AccessDenied, never DBInstanceNotFound. The
    // describe, granted on every instance, is what tells them apart.
    it('answers no-instance from the describe, never modifying a gone instance', async () => {
      rdsSend.mockRejectedValueOnce(notFound());

      expect(
        await adapter.rdsLiftDeletionProtection(SESSION, {
          region: REGION,
          identifier: 'cloudgate-pg1',
        }),
      ).toEqual({ ok: true, value: 'no-instance' });
      expect(rdsSend).toHaveBeenCalledTimes(1);
    });

    it('answers no-instance when the instance goes between the describe and the change', async () => {
      rdsSend
        .mockResolvedValueOnce(found(true))
        .mockRejectedValueOnce(notFound());

      expect(
        await adapter.rdsLiftDeletionProtection(SESSION, {
          region: REGION,
          identifier: 'cloudgate-pg1',
        }),
      ).toEqual({ ok: true, value: 'no-instance' });
    });

    it('answers lifted without a change when protection is already off', async () => {
      rdsSend.mockResolvedValueOnce(found(false));

      expect(
        await adapter.rdsLiftDeletionProtection(SESSION, {
          region: REGION,
          identifier: 'cloudgate-pg1',
        }),
      ).toEqual({ ok: true, value: 'lifted' });
      expect(rdsSend).toHaveBeenCalledTimes(1);
    });

    it("passes RDS's refusal on in its own words", async () => {
      rdsSend.mockResolvedValueOnce(found(true)).mockRejectedValueOnce(
        new InvalidDBInstanceStateFault({
          message: 'Instance cloudgate-pg1 is not in available state.',
          ...meta,
        }),
      );

      expect(
        await adapter.rdsLiftDeletionProtection(SESSION, {
          region: REGION,
          identifier: 'cloudgate-pg1',
        }),
      ).toEqual({
        ok: false,
        code: 'InvalidDBInstanceStateFault',
        message: 'Instance cloudgate-pg1 is not in available state.',
      });
    });
  });

  describe('rdsSnapshot', () => {
    it('answers the snapshot ARN and its allocated storage', async () => {
      rdsSend.mockResolvedValue({
        DBSnapshots: [
          {
            DBSnapshotIdentifier: 'shop-production-pg-1-final-2026-10-17',
            DBInstanceIdentifier: 'cloudgate-pg1',
            SnapshotType: 'manual',
            Status: 'available',
            AllocatedStorage: 20,
            DBSnapshotArn: `arn:aws:rds:${REGION}:123456789012:snapshot:shop-production-pg-1-final-2026-10-17`,
          },
        ],
        $metadata: { httpStatusCode: 200 },
      });

      expect(
        await adapter.rdsSnapshot(SESSION, {
          region: REGION,
          name: 'shop-production-pg-1-final-2026-10-17',
        }),
      ).toEqual({
        ok: true,
        value: {
          arn: `arn:aws:rds:${REGION}:123456789012:snapshot:shop-production-pg-1-final-2026-10-17`,
          sizeGb: 20,
        },
      });
      const [command] = rdsSend.mock.calls[0] as [DescribeDBSnapshotsCommand];
      expect(command.input).toEqual({
        DBSnapshotIdentifier: 'shop-production-pg-1-final-2026-10-17',
      });
    });

    it('answers null for a snapshot RDS does not have', async () => {
      rdsSend.mockRejectedValue(
        new DBSnapshotNotFoundFault({
          message: 'DBSnapshot shop-x not found.',
          ...meta,
        }),
      );

      expect(
        await adapter.rdsSnapshot(SESSION, { region: REGION, name: 'shop-x' }),
      ).toEqual({ ok: true, value: null });
    });
  });

  describe('elastiCacheSnapshot', () => {
    it("answers the snapshot ARN and its nodes' cache size in GiB", async () => {
      cacheSend.mockResolvedValue({
        Snapshots: [
          {
            SnapshotName: 'shop-production-cache-final-2026-10-17',
            ReplicationGroupId: 'cloudgate-cache1',
            SnapshotStatus: 'available',
            SnapshotSource: 'manual',
            NodeSnapshots: [{ CacheNodeId: '0001', CacheSize: '512 MB' }],
            ARN: `arn:aws:elasticache:${REGION}:123456789012:snapshot:shop-production-cache-final-2026-10-17`,
          },
        ],
        $metadata: { httpStatusCode: 200 },
      });

      expect(
        await adapter.elastiCacheSnapshot(SESSION, {
          region: REGION,
          name: 'shop-production-cache-final-2026-10-17',
        }),
      ).toEqual({
        ok: true,
        value: {
          arn: `arn:aws:elasticache:${REGION}:123456789012:snapshot:shop-production-cache-final-2026-10-17`,
          sizeGb: 0.5,
        },
      });
    });

    it('answers null for a snapshot ElastiCache does not have', async () => {
      cacheSend.mockRejectedValue(
        new SnapshotNotFoundFault({
          message: 'Snapshot shop-x not found.',
          ...meta,
        }),
      );

      expect(
        await adapter.elastiCacheSnapshot(SESSION, {
          region: REGION,
          name: 'shop-x',
        }),
      ).toEqual({ ok: true, value: null });
    });
  });

  it.each([
    ['6 MB', 6 / 1024],
    ['1.5 GB', 1.5],
    ['2048 KB', 2 / 1024],
    [undefined, 0],
    ['unknown', 0],
  ])('reads ElastiCache cache size %s as %d GiB', (said, gib) => {
    expect(cacheSizeGib(said)).toBeCloseTo(gib, 6);
  });
});
