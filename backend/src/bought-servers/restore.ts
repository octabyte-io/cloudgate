/**
 * The pure rules of a **Restore** (#180, ADR-0093) that are not a step:
 * whether its safety copy can be taken, and what it is called.
 */

/** The provider keeps this many Server backups; one more pushes out the oldest. */
export const BACKUP_SLOTS = 7;

/**
 * Whether the safety copy would push out the very backup chosen: it is the
 * oldest, and every slot is full. Then the Restore goes without one, and only
 * once that is confirmed. A backup still being made holds a slot too.
 */
export function safetyCopyPushesOut(
  backups: ReadonlyArray<{ id: number; created: string }>,
  chosenId: number,
): boolean {
  if (backups.length < BACKUP_SLOTS) return false;
  const oldest = [...backups].sort(
    (a, b) => Date.parse(a.created) - Date.parse(b.created),
  )[0];
  return oldest?.id === chosenId;
}

/**
 * The safety copy's description, "Before restore, 2026-11-27 14:05 UTC":
 * the minute the Restore was asked for, so a restart finds the copy it cut
 * off by it.
 */
export function safetyCopyDescription(at: Date): string {
  return `Before restore, ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const BACKUP_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: '2-digit',
  year: 'numeric',
});
const BACKUP_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * When a Server backup was taken, as an email names it: "Nov 02, 2026 at
 * 03:00 UTC", the day and the minute, since two backups can share a day.
 */
export function backupDateOf(iso: string): string {
  const at = new Date(iso);
  return `${BACKUP_DAY.format(at)} at ${BACKUP_TIME.format(at)} UTC`;
}
