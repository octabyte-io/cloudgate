import { z } from 'zod';

/**
 * A Backups tab's retention in days (spec "Schema changes"),
 * as a save's body takes it: a whole number within its product's range,
 * each bound refused in that product's words. One chain for a postgres on
 * Cloud SQL and a redis on Memorystore.
 */
export function backupRetentionDaysField(
  range: { readonly min: number; readonly max: number },
  refused: { readonly belowMin: string; readonly aboveMax: string },
) {
  return z
    .number()
    .int('backupRetentionDays must be a whole number of days')
    .min(range.min, refused.belowMin)
    .max(range.max, refused.aboveMax);
}
