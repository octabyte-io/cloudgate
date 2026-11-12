import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runningPostgresVersion } from '../../src/cloud-accounts/aws/plan-reader/database-lines';
import { readPlan } from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * A stored `tofu show -json` of an RDS postgres create (`postgres-create.json`),
 * re-saved by the moto lane from the real pinned OpenTofu and
 * `hashicorp/aws`, as are the change plans below.
 */
function plan(): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'postgres-create.json'),
      'utf8',
    ),
  ) as TofuShowJson;
}

/** The same plan with its instance's values changed. */
function withInstance(values: Record<string, unknown>): TofuShowJson {
  const show = plan();
  return {
    ...show,
    resource_changes: (show.resource_changes ?? []).map((change) =>
      change.type === 'aws_db_instance'
        ? {
            ...change,
            change: {
              ...change.change,
              after: {
                ...(change.change.after as Record<string, unknown>),
                ...values,
              },
            },
          }
        : change,
    ),
  };
}

describe('readPlan, a postgres on RDS', () => {
  it('shows the size beside the class, then storage, backups and version on create', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'small' },
    });

    expect(reading.summary).toEqual([
      'pg-1 small → db.t4g.micro (2 vCPU, 1 GB)',
      'pg-1 storage: 20 GB gp3, grows to 200 GB',
      'pg-1 backups: kept 7 days',
      "pg-1 version: PostgreSQL 17, RDS's default minor, minor upgrades automatic",
    ]);
    expect(reading.counts.create).toBe(3);
  });

  it('says the class is the smallest when the entry has no size', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'pg-1', noSize: true },
    });

    expect(reading.summary[0]).toBe(
      'pg-1 no size → db.t4g.micro (2 vCPU, 1 GB) (smallest)',
    );
  });

  it('says a pinned minor gets no automatic upgrades', () => {
    const reading = readPlan({
      show: withInstance({
        engine_version: '17.2',
        auto_minor_version_upgrade: false,
      }),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'small' },
    });

    expect(reading.summary).toContain(
      'pg-1 version: PostgreSQL 17.2, pinned, no automatic minor upgrades',
    );
  });

  it('never shows the master password', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'small' },
    });

    expect(JSON.stringify(reading)).not.toMatch(/"password"\s*:\s*"/);
  });
});

/** A stored change plan of an RDS postgres already made. */
function stored(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'plans', `${name}.json`), 'utf8'),
  ) as TofuShowJson;
}

describe('readPlan, a change to a postgres on RDS', () => {
  it('marks a class change as a restart, beside the class line', () => {
    const reading = readPlan({
      show: stored('postgres-class-change'),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'large' },
    });

    expect(reading.summary).toEqual([
      'pg-1 large → db.t4g.medium (2 vCPU, 4 GB), from db.t4g.micro',
      'restarts pg-1: a few minutes offline',
    ]);
    expect(reading.outages).toEqual([
      {
        kind: 'restart',
        serviceName: 'pg-1',
        line: 'restarts pg-1: a few minutes offline',
      },
    ]);
    expect(reading.counts.change).toBe(1);
  });

  it('shows storage, Multi-AZ and retention changes with no outage mark', () => {
    const reading = readPlan({
      show: stored('postgres-settings-change'),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'small' },
    });

    expect(reading.summary).toEqual([
      'pg-1 storage: 20 GB → 50 GB',
      'pg-1 storage grows to: 200 GB → 400 GB',
      'pg-1 Multi-AZ: off → on, a standby in a second zone',
      'pg-1 backups: kept 7 days → 14 days',
    ]);
    expect(reading.outages).toBeUndefined();
  });

  it('shows a major upgrade apart, from the version it runs', () => {
    const reading = readPlan({
      show: stored('postgres-major-upgrade'),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'small' },
    });

    expect(reading.summary).toEqual([
      'pg-1 major upgrade: PostgreSQL 17 → 18, offline during the upgrade, cannot be undone',
    ]);
    expect(reading.outages).toEqual([
      {
        kind: 'major-upgrade',
        serviceName: 'pg-1',
        line: 'pg-1 major upgrade: PostgreSQL 17 → 18, offline during the upgrade, cannot be undone',
      },
    ]);
  });

  it('reads the version an instance runs from the state', () => {
    // moto reports the version it was asked for (moto-gaps.ts); AWS
    // reports the minor it runs, which is the one read.
    const show = stored('postgres-major-upgrade');
    expect(runningPostgresVersion(show)).toBe('17');
    const instance = (show.resource_changes ?? []).find(
      (change) => change.type === 'aws_db_instance',
    )!;
    (instance.change.before as Record<string, unknown>).engine_version_actual =
      '17.4';
    expect(runningPostgresVersion(show)).toBe('17.4');
    expect(runningPostgresVersion(plan())).toBeNull();
  });
});

describe('readPlan, a class native.aws sets on RDS', () => {
  /** A stored plan with its instance's `after` values changed. */
  const changed = (
    show: TofuShowJson,
    values: Record<string, unknown>,
  ): TofuShowJson => ({
    ...show,
    resource_changes: (show.resource_changes ?? []).map((change) =>
      change.type === 'aws_db_instance'
        ? {
            ...change,
            change: {
              ...change.change,
              after: {
                ...(change.change.after as Record<string, unknown>),
                ...values,
              },
            },
          }
        : change,
    ),
  });

  it('names the size beside the native class it gives way to, with its CPU and memory', () => {
    const reading = readPlan({
      show: withInstance({ instance_class: 'db.r7g.xlarge' }),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'medium', nativeMachine: true },
    });

    expect(reading.summary[0]).toBe(
      'pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native',
    );
  });

  it('names a class the committed table does not know alone, and with no size beside nothing', () => {
    const reading = readPlan({
      show: withInstance({ instance_class: 'db.x2iedn.xlarge' }),
      tagSearch: [],
      context: { serviceName: 'pg-1', nativeMachine: true },
    });

    expect(reading.summary[0]).toBe('pg-1 → db.x2iedn.xlarge, set by native');
  });

  it('carries the class move warning on a native move', () => {
    const reading = readPlan({
      show: changed(stored('postgres-class-change'), {
        instance_class: 'db.r7g.xlarge',
      }),
      tagSearch: [],
      context: { serviceName: 'pg-1', sizeName: 'medium', nativeMachine: true },
    });

    expect(reading.summary).toEqual([
      'pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native, from db.t4g.micro',
      'restarts pg-1: a few minutes offline',
    ]);
    expect(reading.outages?.map((outage) => outage.kind)).toEqual(['restart']);
  });
});
