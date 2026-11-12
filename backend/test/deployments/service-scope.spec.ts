import { NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type {
  DeploymentOwnerFks,
  DeploymentOwnerType,
  OwnerNames,
} from '../../src/deployments/service-scope';
import { ownedServiceId, ownerOf } from '../../src/deployments/service-scope';

// `ownerOf` was copied into the Environment feed, where it grew a
// second signature. Both feeds answer the same question — which owner does
// this record hang off, and what is it called — so it is asserted once here,
// against the one function both of them now call.

const noFks: DeploymentOwnerFks = {
  applicationId: null,
  composeId: null,
  scheduleId: null,
  volumeBackupId: null,
  backupId: null,
  environmentNetworkId: null,
  postgresId: null,
  mysqlId: null,
  bucketId: null,
  redisId: null,
};

/** The four names a feed resolves alongside the record, all distinct so a
 * branch reading the wrong one names the wrong thing. */
const names: OwnerNames = {
  serviceName: 'checkout-api',
  scheduleName: 'nightly vacuum',
  volumeBackupName: 'uploads snapshot',
  backupName: 'orders dump',
  networkRegion: 'eu-west-1',
};

describe('ownerOf', () => {
  it('titles an application build with the service name', () => {
    expect(ownerOf({ ...noFks, applicationId: 'app-1' }, names)).toEqual({
      type: 'application',
      id: 'app-1',
      name: 'checkout-api',
    });
  });

  it('titles a compose build with the service name', () => {
    expect(ownerOf({ ...noFks, composeId: 'cmp-1' }, names)).toEqual({
      type: 'compose',
      id: 'cmp-1',
      name: 'checkout-api',
    });
  });

  it('titles a scheduled run with the schedule name', () => {
    expect(ownerOf({ ...noFks, scheduleId: 'sch-1' }, names)).toEqual({
      type: 'schedule',
      id: 'sch-1',
      name: 'nightly vacuum',
    });
  });

  it('titles a volume backup run with the volume backup name', () => {
    expect(ownerOf({ ...noFks, volumeBackupId: 'vb-1' }, names)).toEqual({
      type: 'volumeBackup',
      id: 'vb-1',
      name: 'uploads snapshot',
    });
  });

  it('titles a database backup run with the backup name', () => {
    expect(ownerOf({ ...noFks, backupId: 'bk-1' }, names)).toEqual({
      type: 'backup',
      id: 'bk-1',
      name: 'orders dump',
    });
  });

  it('titles an Environment network run with the network and its region', () => {
    expect(ownerOf({ ...noFks, environmentNetworkId: 'net-1' }, names)).toEqual(
      {
        type: 'environmentNetwork',
        id: 'net-1',
        name: 'Environment network (eu-west-1)',
      },
    );
  });

  it('titles a postgres on RDS’s Cloud run with the service name', () => {
    expect(ownerOf({ ...noFks, postgresId: 'pg-1' }, names)).toEqual({
      type: 'postgres',
      id: 'pg-1',
      name: 'checkout-api',
    });
  });

  it('titles a bucket on AWS’s Cloud run with the service name', () => {
    expect(ownerOf({ ...noFks, bucketId: 'bkt-1' }, names)).toEqual({
      type: 'bucket',
      id: 'bkt-1',
      name: 'checkout-api',
    });
  });

  it('titles a redis on ElastiCache’s Cloud run with the service name', () => {
    expect(ownerOf({ ...noFks, redisId: 'redis-1' }, names)).toEqual({
      type: 'redis',
      id: 'redis-1',
      name: 'checkout-api',
    });
  });

  it('leaves the name empty rather than null when the owner row is gone', () => {
    expect(
      ownerOf(
        { ...noFks, scheduleId: 'sch-1' },
        { ...names, scheduleName: null },
      ),
    ).toEqual({ type: 'schedule', id: 'sch-1', name: '' });
  });

  it('refuses a record that hangs off no owner at all', () => {
    expect(() => ownerOf(noFks, names)).toThrow(NotFoundException);
  });
});

/**
 * `DeploymentsService.create` used to rank the same two owners the
 * other way — `input.composeId ?? input.applicationId` — so one module carried
 * two orderings of one question, which is the tell the parent change opens with. The write
 * side no longer ranks anything (it is handed a discriminated parent), so
 * `ownerOf` and `ownedServiceId()` are the only two statements of the order
 * left, and this is what holds them to the same one.
 *
 * Why *this* order rather than compose-first is on `ownerOf`'s docblock and in
 * ADR-0017; the short form is that it is the order 0064 already normalized the
 * two-parented rows by, so reversing it would relabel rows the migration has
 * shipped.
 *
 * The order is a table rather than five assertions, so a reordered branch is a
 * failed assertion rather than a reordered assertion.
 */
const PRECEDENCE = [
  ['application', 'applicationId', 'app-1'],
  ['compose', 'composeId', 'cmp-1'],
  ['schedule', 'scheduleId', 'sch-1'],
  ['volumeBackup', 'volumeBackupId', 'vb-1'],
  ['backup', 'backupId', 'bk-1'],
  ['postgres', 'postgresId', 'pg-1'],
  ['mysql', 'mysqlId', 'my-1'],
  ['bucket', 'bucketId', 'bkt-1'],
  ['redis', 'redisId', 'redis-1'],
  ['environmentNetwork', 'environmentNetworkId', 'net-1'],
] as const satisfies readonly (readonly [
  DeploymentOwnerType,
  keyof DeploymentOwnerFks,
  string,
])[];

describe('ownerOf, as the one precedence over a record’s owners', () => {
  it('titles a record carrying several owner ids by the earliest of them', () => {
    // `deployment_at_most_one_parent` makes these rows unstorable and the discriminated
    // union makes them unwritable, so every one of them is a row the *readers*
    // must still rank the same way: the constraint is a backstop, and an
    // install that predates 0064 had such rows. One case per suffix of the
    // order, so any two branches swapped in `ownerOf` reds this.
    const titled = PRECEDENCE.map((_, from) => {
      const row: DeploymentOwnerFks = { ...noFks };
      for (const [, column, id] of PRECEDENCE.slice(from)) row[column] = id;
      return ownerOf(row, names).type;
    });

    expect(titled).toEqual(PRECEDENCE.map(([type]) => type));
  });
});

describe('ownedServiceId, as the same precedence in SQL', () => {
  it('coalesces the owning service id in that same order', () => {
    // The SQL half. Both feeds join `serviceScope` on `ownedServiceId()`, so
    // its `coalesce` decides which service a multi-owner row is *listed*
    // under, while `ownerOf` decides what the row is *titled*. They disagreed
    // once already, one level up, which is why this is asserted rather than
    // read off by eye: the two must rank the owner kinds identically or a feed
    // row is titled as one service and filtered as another.
    const rendered = new PgDialect().sqlToQuery(ownedServiceId()).sql;
    const columns = [...rendered.matchAll(/"(\w+)"\."(\w+)"/g)].map(
      ([, table, column]) => `${table}.${column}`,
    );

    // The record's own two parents lead, application before compose.
    expect(columns.slice(0, 2)).toEqual([
      'deployment.application_id',
      'deployment.compose_id',
    ]);
    // Then one group per run-owning table, in the order `ownerOf` tests them.
    expect([...new Set(columns.map((column) => column.split('.')[0]))]).toEqual(
      ['deployment', 'schedule', 'volume_backup', 'backup'],
    );
  });
});
