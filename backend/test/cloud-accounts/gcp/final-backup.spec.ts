import {
  backupMonthlyUsd,
  backupSizeGb,
  finalBackupName,
  keepsBackupSentence,
  keptBackup,
} from '../../../src/cloud-accounts/gcp/final-backup';

/**
 * A Google database's final backup: its name, its size as each
 * product bills it, and the report's and the dialog's words for it.
 */
describe('finalBackupName', () => {
  it('is named as a final snapshot is, cut to a Valkey id’s 63 characters without losing -final-<date>', () => {
    expect(finalBackupName('shop-production-pg-1-final-2026-10-26')).toBe(
      'shop-production-pg-1-final-2026-10-26',
    );
    const long = finalBackupName(
      `${'a'.repeat(30)}-${'b'.repeat(30)}-cache-final-2026-10-26`,
    );
    expect(long).toHaveLength(63);
    expect(long.endsWith('-final-2026-10-26')).toBe(true);
    expect(long).not.toContain('--');
  });
});

describe('backupSizeGb', () => {
  it('is sized in GiB on Cloud SQL and GB on Valkey, as each bills it', () => {
    expect(backupSizeGb('cloud-sql', 2 * 1024 ** 3)).toBe(2);
    expect(backupSizeGb('memorystore', 1024 ** 3)).toBe(1.07);
    expect(backupMonthlyUsd('cloud-sql', 10)).toBe(0.8);
    expect(backupMonthlyUsd('memorystore', 10)).toBe(0.81);
  });
});

describe('keptBackup', () => {
  it('is named once as kept, with where it is, its size and what it costs until deleted in Google Cloud', () => {
    expect(
      keptBackup({
        product: 'cloud-sql',
        name: 'shop-production-pg-1-final-2026-10-26',
        region: 'us',
        sizeGb: 2,
      }),
    ).toEqual({
      type: 'cloud-sql:backup',
      awsId: 'shop-production-pg-1-final-2026-10-26',
      region: 'us',
      size: '2 GiB',
      cost: 'about $0.16 a month until you delete it in Google Cloud',
    });
    expect(keepsBackupSentence('x-final-2026-10-26', 0.001)).toBe(
      'keeps backup x-final-2026-10-26, about $0.01 a month, until you delete it in Google Cloud',
    );
  });
});
