import {
  STORAGE_MOUNT_POINT,
  storageCommand,
  storageDeviceOf,
  storageGrowRefusal,
  storageMonthlyUsd,
} from '../../src/bought-servers/storage';

const LIMITS = { minGb: 10, maxGb: 10240 };

describe('storageMonthlyUsd: extra storage priced as the page prices it', () => {
  it('rounds the marked-up per-GB price times the size up to a whole dollar', () => {
    // 0.0767 × 1.2 = 0.09204 a GB: 100 GB is 9.204, so $10.
    expect(storageMonthlyUsd({ perGbMonthly: 0.09204 }, 100)).toBe(10);
    expect(storageMonthlyUsd({ perGbMonthly: 0.09204 }, 10)).toBe(1);
  });

  it('rounds up to a multiple of $5 above $100', () => {
    // 2000 GB is 184.08, so $185.
    expect(storageMonthlyUsd({ perGbMonthly: 0.09204 }, 2000)).toBe(185);
  });
});

describe('storageGrowRefusal: storage only grows', () => {
  it('lets a bigger size through', () => {
    expect(storageGrowRefusal(50, 51, LIMITS)).toBeNull();
    expect(storageGrowRefusal(50, 10240, LIMITS)).toBeNull();
  });

  it('refuses a smaller size, or the same, saying it never shrinks', () => {
    expect(storageGrowRefusal(50, 40, LIMITS)).toBe(
      'Extra storage can only grow. Choose more than 50 GB',
    );
    expect(storageGrowRefusal(50, 50, LIMITS)).toBe(
      'Extra storage can only grow. Choose more than 50 GB',
    );
  });

  it('refuses more than the most there is', () => {
    expect(storageGrowRefusal(50, 10241, LIMITS)).toBe(
      'Extra storage is at most 10,240 GB',
    );
  });

  it('refuses a Server bought without extra storage', () => {
    expect(storageGrowRefusal(null, 20, LIMITS)).toBe(
      'This Server has no extra storage. Extra storage is chosen when buying a Server',
    );
  });
});

describe('storageCommand: mounted once, grown to fill the Volume', () => {
  const command = storageCommand(123, 50);

  it('mounts the Volume by its stable device path, kept in fstab for a reboot', () => {
    expect(storageDeviceOf(123)).toBe('/dev/disk/by-id/scsi-0HC_Volume_123');
    expect(command).toContain(`DEVICE='${storageDeviceOf(123)}'`);
    expect(command).toContain(`MOUNT_POINT='${STORAGE_MOUNT_POINT}'`);
    expect(command).toContain('ext4 discard,nofail,defaults 0 0');
    // Written only when it is not there yet, and mounted only when it is not.
    expect(command).toContain('if ! grep -qs " $MOUNT_POINT " /etc/fstab');
    expect(command).toContain('if ! mountpoint -q "$MOUNT_POINT"');
  });

  it('waits for the Volume to show its size, then grows the filesystem, never formatting it', () => {
    expect(command).toContain(`-lt ${50 * 1024 ** 3} ]`);
    expect(command).toContain('resize2fs "$REAL"');
    expect(command).not.toMatch(/mkfs/);
  });

  it('never names the provider in what the setup log prints', () => {
    const printed = command
      .split('\n')
      .filter((line) => /^\s*echo "/.test(line) && !line.includes('fstab'));
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) expect(line).not.toMatch(/hetzner|HC_/i);
  });
});
