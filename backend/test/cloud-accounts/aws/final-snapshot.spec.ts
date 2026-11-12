import { deleteReportLines } from '../../../src/cloud-accounts/aws/delete-check';
import {
  formatUsd,
  isAutomatedSnapshotArn,
  isSnapshotArn,
  keptSnapshot,
  snapshotMonthlyUsd,
} from '../../../src/cloud-accounts/aws/final-snapshot';

/**
 * A cloud database's final snapshot in a Delete's report: named
 * once, with its region, size and what it costs a month at RDS's
 * $0.095/GB-month or ElastiCache's $0.085/GiB-month.
 */
describe('keptSnapshot, snapshotMonthlyUsd and formatUsd', () => {
  it.each([
    ['rds', 20, 1.9],
    ['rds', 100, 9.5],
    ['elasticache', 0.5, 0.04],
    ['elasticache', 10, 0.85],
  ] as const)(
    'a %s snapshot of %d GB costs about $%d a month',
    (service, size, usd) => {
      expect(snapshotMonthlyUsd(service, size)).toBe(usd);
    },
  );

  it('never says a snapshot that costs something costs nothing', () => {
    expect(formatUsd(0.001)).toBe('$0.01');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('is one kept line with its region, size and monthly cost', () => {
    const kept = keptSnapshot({
      service: 'rds',
      name: 'shop-production-pg-1-final-2026-10-17',
      region: 'eu-central-1',
      sizeGb: 20,
    });

    expect(deleteReportLines({ kept: [kept], left: [] })).toEqual([
      'Kept on purpose:',
      '  rds:snapshot shop-production-pg-1-final-2026-10-17 (eu-central-1, 20 GB): about $1.90 a month until you delete it in AWS',
    ]);
  });

  it('tells its own ARN from another', () => {
    expect(
      isSnapshotArn(
        'arn:aws:rds:eu-central-1:1:snapshot:shop-production-pg-1-final-2026-10-17',
        'shop-production-pg-1-final-2026-10-17',
      ),
    ).toBe(true);
    expect(
      isSnapshotArn(
        'arn:aws:rds:eu-central-1:1:db:cloudgate-pg1',
        'shop-production-pg-1-final-2026-10-17',
      ),
    ).toBe(false);
  });
});

/**
 * An instance's automated backup snapshot, which RDS deletes with it but
 * the tag index still lists for a while: its own instance's only.
 */
describe('isAutomatedSnapshotArn', () => {
  const arn = (id: string) => `arn:aws:rds:us-east-1:1:snapshot:${id}`;

  it("matches the instance's own automated snapshot", () => {
    expect(
      isAutomatedSnapshotArn(
        arn('rds:cloudgate-pg1-2026-10-25-08-50'),
        'cloudgate-pg1',
      ),
    ).toBe(true);
  });

  it("does not match another instance's, a manual snapshot or the final snapshot", () => {
    for (const id of [
      'rds:cloudgate-pg2-2026-10-25-08-50',
      'rds:cloudgate-pg1x-2026-10-25-08-50',
      'rds:cloudgate-pg1-other-2026-10-25-08-50',
      'cloudgate-pg1-2026-10-25-08-50',
      'shop-production-pg-1-final-2026-10-17',
    ]) {
      expect(isAutomatedSnapshotArn(arn(id), 'cloudgate-pg1')).toBe(false);
    }
    expect(
      isAutomatedSnapshotArn(
        'arn:aws:rds:us-east-1:1:db:cloudgate-pg1',
        'cloudgate-pg1',
      ),
    ).toBe(false);
  });
});
