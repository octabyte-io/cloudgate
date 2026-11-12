import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  olderValkey,
  runningValkeyVersion,
} from '../../src/cloud-accounts/aws/plan-reader/cache-lines';
import { readPlan } from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * A stored `tofu show -json` of an ElastiCache for Valkey create
 * (`redis-create.json`), re-saved by the moto lane from the real
 * pinned OpenTofu and `hashicorp/aws`. The change plans below stay
 * hand-shaped: moto cannot make a replication group's parameter group
 * (`MOTO_MISSING` in `moto/moto-gaps.ts`).
 */
function plan(): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'redis-create.json'),
      'utf8',
    ),
  ) as TofuShowJson;
}

describe('readPlan, a redis on ElastiCache', () => {
  it('shows the size beside Valkey and the node type, then snapshots and version on create', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'redis', sizeName: 'small' },
    });

    expect(reading.summary).toEqual([
      'redis small → Valkey on cache.t4g.small (2 vCPU, 1.37 GB)',
      'redis snapshots: daily, kept 1 day',
      'redis version: Valkey 7.2',
    ]);
    expect(reading.counts.create).toBe(4);
    expect(reading.outages).toBeUndefined();
  });

  it('says a redis with no size is on the smallest node type', () => {
    const show = plan();
    const reading = readPlan({
      show: {
        ...show,
        resource_changes: (show.resource_changes ?? []).map((change) =>
          change.type === 'aws_elasticache_replication_group'
            ? {
                ...change,
                change: {
                  ...change.change,
                  after: {
                    ...(change.change.after as Record<string, unknown>),
                    node_type: 'cache.t4g.micro',
                  },
                },
              }
            : change,
        ),
      },
      tagSearch: [],
      context: { serviceName: 'redis', noSize: true },
    });

    expect(reading.summary[0]).toBe(
      'redis no size → Valkey on cache.t4g.micro (2 vCPU, 512 MB) (smallest)',
    );
  });

  it('never prints the AUTH token', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'redis' },
    });

    expect(JSON.stringify(reading)).not.toContain('"auth_token":"x"');
  });
});

/** A stored change plan of a made replication group. */
function changePlan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'plans', `${name}.json`), 'utf8'),
  ) as TofuShowJson;
}

describe('readPlan, a node type native.aws sets on ElastiCache', () => {
  it('names the size beside the native node type, and carries the resize warning', () => {
    const show = changePlan('redis-resize');
    const reading = readPlan({
      show: {
        ...show,
        resource_changes: (show.resource_changes ?? []).map((change) =>
          change.type === 'aws_elasticache_replication_group'
            ? {
                ...change,
                change: {
                  ...change.change,
                  after: {
                    ...(change.change.after as Record<string, unknown>),
                    node_type: 'cache.r7g.large',
                  },
                },
              }
            : change,
        ),
      },
      tagSearch: [],
      context: {
        serviceName: 'redis',
        sizeName: 'medium',
        nativeMachine: true,
      },
    });

    expect(reading.summary).toEqual([
      'redis medium → Valkey on cache.r7g.large (2 vCPU, 13.07 GB), set by native, from cache.t4g.small',
      'redis: may drop connections briefly while it resizes',
    ]);
  });
});

describe('readPlan, a change to a redis on ElastiCache', () => {
  it('marks a new node type as dropping connections while it resizes', () => {
    const reading = readPlan({
      show: changePlan('redis-resize'),
      tagSearch: [],
      context: { serviceName: 'redis', sizeName: 'medium' },
    });

    expect(reading.summary).toEqual([
      'redis medium → Valkey on cache.t4g.medium (2 vCPU, 3.09 GB), from cache.t4g.small',
      'redis: may drop connections briefly while it resizes',
    ]);
    expect(reading.outages).toEqual([
      {
        kind: 'restart',
        serviceName: 'redis',
        line: 'redis: may drop connections briefly while it resizes',
      },
    ]);
  });

  it('shows a new major apart, from the Valkey AWS reports it runs', () => {
    const reading = readPlan({
      show: changePlan('redis-major-upgrade'),
      tagSearch: [],
      context: { serviceName: 'redis' },
    });

    const line =
      'redis major upgrade: Valkey 7.2.4 → 8.1, may drop connections briefly, cannot be undone';
    expect(reading.outages).toEqual([
      { kind: 'major-upgrade', serviceName: 'redis', line },
    ]);
    expect(reading.summary).toContain(line);
    expect(runningValkeyVersion(changePlan('redis-major-upgrade'))).toBe(
      '7.2.4',
    );
  });

  it('plans the replica and snapshot retention with no mark', () => {
    const reading = readPlan({
      show: changePlan('redis-replica-on'),
      tagSearch: [],
      context: { serviceName: 'redis' },
    });

    expect(reading.summary).toEqual([
      'redis replica: off → on, one replica in another zone with automatic failover',
      'redis snapshots: daily, kept 1 day → daily, kept 7 days',
    ]);
    expect(reading.outages).toBeUndefined();
  });

  it('reads no running version on a create', () => {
    expect(runningValkeyVersion(plan())).toBeNull();
  });
});

describe('olderValkey', () => {
  it.each([
    ['7.2', '8.1', true],
    ['8.0', '8.1.4', true],
    ['8.1', '8.1.4', false],
    ['8.1', '7.2.4', false],
  ])('%s is older than %s: %s', (a, b, older) => {
    expect(olderValkey(a, b)).toBe(older);
  });
});
