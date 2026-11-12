import type { ConfigService } from '@nestjs/config';
import {
  DBInstanceNotFoundFault,
  DescribeDBInstanceAutomatedBackupsCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  DescribeReplicationGroupsCommand,
  DescribeSnapshotsCommand,
  ElastiCacheClient,
  ReplicationGroupNotFoundFault,
} from '@aws-sdk/client-elasticache';

import { AwsCloudAdapter } from '../../../src/cloud-accounts/aws/aws-cloud.adapter';
import type { Env } from '../../../src/common/config/env.schema';

/**
 * The two reads of a cloud database's Backups tab against what the
 * SDK hands back for AWS's own answers: the shapes below are recorded from
 * `aws rds describe-*` and `aws elasticache describe-*` (timestamps as the
 * SDK parses them, `Date`s), trimmed to the fields around the ones read.
 */

const session = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'token',
};
const ref = { region: 'eu-central-1', identifier: 'cloudgate-pg1' };

const adapter = new AwsCloudAdapter({
  get: () => '',
} as unknown as ConfigService<Env, true>);

/** Answers each command by its class, page by page, and records what was asked. */
function scripted<C extends { send: unknown }>(
  client: { prototype: C },
  answers: Map<new (input: never) => unknown, unknown[]>,
) {
  const asked: { command: string; input: Record<string, unknown> }[] = [];
  const spy = jest
    .spyOn(client.prototype, 'send' as never)
    .mockImplementation(((command: {
      constructor: new (input: never) => unknown;
      input: Record<string, unknown>;
    }) => {
      asked.push({ command: command.constructor.name, input: command.input });
      const pages = answers.get(command.constructor);
      if (!pages?.length)
        throw new Error(`unscripted ${command.constructor.name}`);
      const next = pages.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    }) as never);
  return { asked, spy };
}

afterEach(() => jest.restoreAllMocks());

const DB_INSTANCE = {
  DBInstanceIdentifier: 'cloudgate-pg1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  DBInstanceStatus: 'available',
  AllocatedStorage: 20,
  InstanceCreateTime: new Date('2026-10-01T09:12:44.512Z'),
  PreferredBackupWindow: '02:41-03:11',
  BackupRetentionPeriod: 7,
  LatestRestorableTime: new Date('2026-10-16T11:05:00.000Z'),
  DbiResourceId: 'db-LIVEINSTANCE7XQ',
  DBInstanceArn: 'arn:aws:rds:eu-central-1:123456789012:db:cloudgate-pg1',
  StorageType: 'gp3',
  MultiAZ: false,
};

const AUTOMATED_BACKUPS = [
  {
    // A retained one, left by an earlier instance of the same identifier.
    DBInstanceArn: 'arn:aws:rds:eu-central-1:123456789012:db:cloudgate-pg1',
    DbiResourceId: 'db-EARLIERINSTANCE',
    Region: 'eu-central-1',
    DBInstanceIdentifier: 'cloudgate-pg1',
    RestoreWindow: {
      EarliestTime: new Date('2026-09-01T00:00:00.000Z'),
      LatestTime: new Date('2026-09-10T00:00:00.000Z'),
    },
    AllocatedStorage: 20,
    Status: 'retained',
    Engine: 'postgres',
    BackupRetentionPeriod: 7,
  },
  {
    DBInstanceArn: 'arn:aws:rds:eu-central-1:123456789012:db:cloudgate-pg1',
    DbiResourceId: 'db-LIVEINSTANCE7XQ',
    Region: 'eu-central-1',
    DBInstanceIdentifier: 'cloudgate-pg1',
    RestoreWindow: {
      EarliestTime: new Date('2026-10-09T02:45:31.000Z'),
      LatestTime: new Date('2026-10-16T11:05:00.000Z'),
    },
    AllocatedStorage: 20,
    Status: 'active',
    Engine: 'postgres',
    BackupRetentionPeriod: 7,
  },
];

const SNAPSHOT_PAGE_1 = {
  DBSnapshots: [
    {
      DBSnapshotIdentifier: 'rds:cloudgate-pg1-2026-10-15-02-45',
      DBInstanceIdentifier: 'cloudgate-pg1',
      SnapshotCreateTime: new Date('2026-10-15T02:45:51.000Z'),
      Engine: 'postgres',
      AllocatedStorage: 20,
      Status: 'available',
      SnapshotType: 'automated',
      Encrypted: true,
    },
  ],
  Marker: 'page-2',
};

const SNAPSHOT_PAGE_2 = {
  DBSnapshots: [
    {
      DBSnapshotIdentifier: 'shop-production-pg-1-final-2026-10-02',
      DBInstanceIdentifier: 'cloudgate-pg1',
      SnapshotCreateTime: new Date('2026-10-02T08:00:00.000Z'),
      Engine: 'postgres',
      AllocatedStorage: 50,
      Status: 'available',
      SnapshotType: 'manual',
      Encrypted: true,
    },
    {
      DBSnapshotIdentifier: 'rds:cloudgate-pg1-2026-10-16-02-45',
      DBInstanceIdentifier: 'cloudgate-pg1',
      Engine: 'postgres',
      AllocatedStorage: 20,
      Status: 'creating',
      SnapshotType: 'automated',
      Encrypted: true,
    },
  ],
};

describe('AwsCloudAdapter.rdsBackups', () => {
  it('reads retention, the restorable window of the live instance and every page of snapshots', async () => {
    const { asked } = scripted(
      RDSClient,
      new Map<new (input: never) => unknown, unknown[]>([
        [DescribeDBInstancesCommand, [{ DBInstances: [DB_INSTANCE] }]],
        [
          DescribeDBInstanceAutomatedBackupsCommand,
          [{ DBInstanceAutomatedBackups: AUTOMATED_BACKUPS }],
        ],
        [DescribeDBSnapshotsCommand, [SNAPSHOT_PAGE_1, SNAPSHOT_PAGE_2]],
      ]),
    );

    const answer = await adapter.rdsBackups(session, ref);

    expect(answer).toEqual({
      ok: true,
      value: {
        retentionDays: 7,
        earliestRestorableTime: '2026-10-09T02:45:31.000Z',
        latestRestorableTime: '2026-10-16T11:05:00.000Z',
        snapshots: [
          {
            id: 'rds:cloudgate-pg1-2026-10-16-02-45',
            type: 'automated',
            createdAt: null,
            status: 'creating',
            size: '20 GB',
          },
          {
            id: 'rds:cloudgate-pg1-2026-10-15-02-45',
            type: 'automated',
            createdAt: '2026-10-15T02:45:51.000Z',
            status: 'available',
            size: '20 GB',
          },
          {
            id: 'shop-production-pg-1-final-2026-10-02',
            type: 'manual',
            createdAt: '2026-10-02T08:00:00.000Z',
            status: 'available',
            size: '50 GB',
          },
        ],
      },
    });
    expect(asked).toEqual([
      {
        command: 'DescribeDBInstancesCommand',
        input: { DBInstanceIdentifier: 'cloudgate-pg1' },
      },
      {
        command: 'DescribeDBInstanceAutomatedBackupsCommand',
        input: { DBInstanceIdentifier: 'cloudgate-pg1' },
      },
      {
        command: 'DescribeDBSnapshotsCommand',
        input: { DBInstanceIdentifier: 'cloudgate-pg1', Marker: undefined },
      },
      {
        command: 'DescribeDBSnapshotsCommand',
        input: { DBInstanceIdentifier: 'cloudgate-pg1', Marker: 'page-2' },
      },
    ]);
  });

  it('has no restorable window while RDS has taken no automated backup yet', async () => {
    scripted(
      RDSClient,
      new Map<new (input: never) => unknown, unknown[]>([
        [
          DescribeDBInstancesCommand,
          [
            {
              DBInstances: [
                { ...DB_INSTANCE, LatestRestorableTime: undefined },
              ],
            },
          ],
        ],
        [
          DescribeDBInstanceAutomatedBackupsCommand,
          [{ DBInstanceAutomatedBackups: [] }],
        ],
        [DescribeDBSnapshotsCommand, [{ DBSnapshots: [] }]],
      ]),
    );

    const answer = await adapter.rdsBackups(session, ref);

    expect(answer).toEqual({
      ok: true,
      value: {
        retentionDays: 7,
        earliestRestorableTime: null,
        latestRestorableTime: null,
        snapshots: [],
      },
    });
  });

  it("answers RDS's refusal for an instance it does not have", async () => {
    scripted(
      RDSClient,
      new Map<new (input: never) => unknown, unknown[]>([
        [
          DescribeDBInstancesCommand,
          [
            new DBInstanceNotFoundFault({
              $metadata: { httpStatusCode: 404 },
              message: 'DBInstance cloudgate-pg1 not found.',
            }),
          ],
        ],
      ]),
    );

    expect(await adapter.rdsBackups(session, ref)).toEqual({
      ok: false,
      code: 'DBInstanceNotFoundFault',
      message: 'DBInstance cloudgate-pg1 not found.',
    });
  });
});

const REPLICATION_GROUP = {
  ReplicationGroupId: 'cloudgate-redis1',
  Description: 'Cloudgate: redis',
  Status: 'available',
  MemberClusters: ['cloudgate-redis1-001'],
  SnapshotRetentionLimit: 3,
  SnapshotWindow: '05:00-06:00',
  SnapshottingClusterId: 'cloudgate-redis1-001',
  ClusterEnabled: false,
  CacheNodeType: 'cache.t4g.small',
  Engine: 'valkey',
};

const CACHE_SNAPSHOT_PAGE_1 = {
  Snapshots: [
    {
      SnapshotName: 'automatic.cloudgate-redis1-2026-10-15-05-00',
      ReplicationGroupId: 'cloudgate-redis1',
      SnapshotStatus: 'available',
      SnapshotSource: 'automated',
      CacheNodeType: 'cache.t4g.small',
      Engine: 'valkey',
      EngineVersion: '7.2',
      NodeSnapshots: [
        {
          CacheClusterId: 'cloudgate-redis1-001',
          NodeGroupId: '0001',
          CacheNodeId: '0001',
          CacheSize: '5 MB',
          CacheNodeCreateTime: new Date('2026-10-01T10:00:00.000Z'),
          SnapshotCreateTime: new Date('2026-10-15T05:03:12.000Z'),
        },
      ],
    },
  ],
  Marker: 'next',
};

const CACHE_SNAPSHOT_PAGE_2 = {
  Snapshots: [
    {
      SnapshotName: 'before-the-migration',
      ReplicationGroupId: 'cloudgate-redis1',
      SnapshotStatus: 'creating',
      SnapshotSource: 'manual',
      CacheNodeType: 'cache.t4g.small',
      Engine: 'valkey',
      NodeSnapshots: [
        {
          CacheClusterId: 'cloudgate-redis1-001',
          NodeGroupId: '0001',
          CacheNodeId: '0001',
          CacheNodeCreateTime: new Date('2026-10-01T10:00:00.000Z'),
        },
      ],
    },
  ],
};

describe('AwsCloudAdapter.cacheBackups', () => {
  const cacheRef = { region: 'eu-central-1', identifier: 'cloudgate-redis1' };

  it("reads the group's snapshot retention and every page of its snapshots", async () => {
    const { asked } = scripted(
      ElastiCacheClient,
      new Map<new (input: never) => unknown, unknown[]>([
        [
          DescribeReplicationGroupsCommand,
          [{ ReplicationGroups: [REPLICATION_GROUP] }],
        ],
        [
          DescribeSnapshotsCommand,
          [CACHE_SNAPSHOT_PAGE_1, CACHE_SNAPSHOT_PAGE_2],
        ],
      ]),
    );

    const answer = await adapter.cacheBackups(session, cacheRef);

    expect(answer).toEqual({
      ok: true,
      value: {
        retentionDays: 3,
        snapshots: [
          {
            id: 'before-the-migration',
            type: 'manual',
            createdAt: null,
            status: 'creating',
            size: null,
          },
          {
            id: 'automatic.cloudgate-redis1-2026-10-15-05-00',
            type: 'automated',
            createdAt: '2026-10-15T05:03:12.000Z',
            status: 'available',
            size: '5 MB',
          },
        ],
      },
    });
    expect(asked).toEqual([
      {
        command: 'DescribeReplicationGroupsCommand',
        input: { ReplicationGroupId: 'cloudgate-redis1' },
      },
      {
        command: 'DescribeSnapshotsCommand',
        input: { ReplicationGroupId: 'cloudgate-redis1', Marker: undefined },
      },
      {
        command: 'DescribeSnapshotsCommand',
        input: { ReplicationGroupId: 'cloudgate-redis1', Marker: 'next' },
      },
    ]);
  });

  it('reads a group with snapshots off as retention 0', async () => {
    scripted(
      ElastiCacheClient,
      new Map<new (input: never) => unknown, unknown[]>([
        [
          DescribeReplicationGroupsCommand,
          [
            {
              ReplicationGroups: [
                { ...REPLICATION_GROUP, SnapshotRetentionLimit: 0 },
              ],
            },
          ],
        ],
        [DescribeSnapshotsCommand, [{ Snapshots: [] }]],
      ]),
    );

    expect(await adapter.cacheBackups(session, cacheRef)).toEqual({
      ok: true,
      value: { retentionDays: 0, snapshots: [] },
    });
  });

  it("answers ElastiCache's refusal for a group it does not have", async () => {
    scripted(
      ElastiCacheClient,
      new Map<new (input: never) => unknown, unknown[]>([
        [
          DescribeReplicationGroupsCommand,
          [
            new ReplicationGroupNotFoundFault({
              $metadata: { httpStatusCode: 404 },
              message: 'ReplicationGroup cloudgate-redis1 not found.',
            }),
          ],
        ],
      ]),
    );

    expect(await adapter.cacheBackups(session, cacheRef)).toEqual({
      ok: false,
      code: 'ReplicationGroupNotFoundFault',
      message: 'ReplicationGroup cloudgate-redis1 not found.',
    });
  });
});
