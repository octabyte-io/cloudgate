import type { PlanRefusal } from './plan.types';

/** A Google database's backup retention bounds, in days. */
export interface RetentionBounds {
  readonly min: number;
  readonly max: number;
}

/** `7 days`, `1 day`, or `off` for 0, as a plan line names a retention. */
export function backupDays(days: number): string {
  if (days === 0) return 'off';
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * A saved retention outside what Google takes, refused before the
 * plan is stored, naming the tab it is set on; `null` when Google takes it.
 * The tab's own save refuses one first, so this guards a row written
 * another way.
 */
export function retentionRefusal(
  name: string,
  days: number,
  bounds: RetentionBounds,
  product: string,
): PlanRefusal | null {
  if (Number.isInteger(days) && days >= bounds.min && days <= bounds.max) {
    return null;
  }
  return {
    at: name,
    message: `${name}: a backup retention of ${days} days is outside ${product}'s ${bounds.min} to ${bounds.max} days; set one on ${name}'s Backups tab`,
  };
}
