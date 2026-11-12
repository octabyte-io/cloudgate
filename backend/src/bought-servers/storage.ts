import { tidyUsd } from './pricing';

/**
 * A Bought Server's **extra storage** (ADR-0071), pure: a Volume in the
 * Server's Location, between 10 GB and 10 TB, that only ever grows. Its
 * price, the refusals of a grow, and the one script that mounts it and grows
 * its filesystem on the machine.
 */

/** Where the machine mounts the extra storage. The console says so. */
export const STORAGE_MOUNT_POINT = '/mnt/storage';

/** Extra storage's monthly price at `sizeGb`, whole US dollars, from the catalogue's marked-up price of one GB. */
export function storageMonthlyUsd(
  storage: { perGbMonthly: number },
  sizeGb: number,
): number {
  return tidyUsd(sizeGb * storage.perGbMonthly);
}

/** Where the machine sees the Volume: the provider names it by its id. */
export function storageDeviceOf(volumeId: number): string {
  return `/dev/disk/by-id/scsi-0HC_Volume_${volumeId}`;
}

/** Why a grow to `sizeGb` is refused, said to the customer; null when it may go ahead. */
export function storageGrowRefusal(
  currentGb: number | null,
  sizeGb: number,
  limits: { minGb: number; maxGb: number },
): string | null {
  if (currentGb === null) {
    return 'This Server has no extra storage. Extra storage is chosen when buying a Server';
  }
  if (sizeGb <= currentGb) {
    return `Extra storage can only grow. Choose more than ${currentGb} GB`;
  }
  if (sizeGb > limits.maxGb) {
    return `Extra storage is at most ${limits.maxGb.toLocaleString('en-US')} GB`;
  }
  return null;
}

/** How long the script waits for the Volume to show, and to show its new size. */
const WAIT_TRIES = 60;
const WAIT_SECONDS = 2;

/**
 * Mounts the extra storage at {@link STORAGE_MOUNT_POINT} (once, kept in
 * `/etc/fstab` so a reboot mounts it again) and grows its filesystem to fill
 * the Volume. Safe to run any number of times: run after every Setup run, and
 * after a grow, so a Setup run also finishes a grow that could not reach the
 * machine. The Volume is made formatted (ext4), so nothing is formatted here.
 * Says nothing of the provider: the setup log is the customer's.
 */
export function storageCommand(volumeId: number, sizeGb: number): string {
  const wantBytes = sizeGb * 1024 ** 3;
  return `set -e
SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi
DEVICE='${storageDeviceOf(volumeId)}'
MOUNT_POINT='${STORAGE_MOUNT_POINT}'
tries=0
while [ ! -b "$DEVICE" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt ${WAIT_TRIES} ]; then
    echo "The extra storage is not attached to this Server yet. Run setup again in a few minutes." >&2
    exit 1
  fi
  sleep ${WAIT_SECONDS}
done
REAL=$(readlink -f "$DEVICE")
$SUDO mkdir -p "$MOUNT_POINT"
if ! grep -qs " $MOUNT_POINT " /etc/fstab; then
  echo "$DEVICE $MOUNT_POINT ext4 discard,nofail,defaults 0 0" | $SUDO tee -a /etc/fstab >/dev/null
fi
if ! mountpoint -q "$MOUNT_POINT"; then $SUDO mount "$MOUNT_POINT"; fi
tries=0
while [ "$($SUDO blockdev --getsize64 "$REAL")" -lt ${wantBytes} ]; do
  echo 1 | $SUDO tee "/sys/class/block/$(basename "$REAL")/device/rescan" >/dev/null 2>&1 || true
  tries=$((tries + 1))
  if [ "$tries" -gt ${WAIT_TRIES} ]; then
    echo "The extra storage has not reached ${sizeGb} GB yet. Run setup again in a few minutes." >&2
    exit 1
  fi
  sleep ${WAIT_SECONDS}
done
if ! OUT=$($SUDO resize2fs "$REAL" 2>&1); then
  echo "$OUT" >&2
  exit 1
fi
echo "Extra storage of ${sizeGb} GB is mounted at $MOUNT_POINT ✅"
`;
}
