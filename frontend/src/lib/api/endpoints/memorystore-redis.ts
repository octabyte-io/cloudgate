import { api } from "../client";
import type { Database } from "./databases";

/**
 * Cloudgate's own setting of a redis on Memorystore, kept per
 * Service and never in the Project config: high
 * availability, one replica in another zone, which doubles the node cost.
 * Off by default. The next plan shows the replica added or removed, and its
 * Apply makes it on Google Cloud in place.
 */
export interface MemorystoreRedisSettings {
  highAvailability: boolean;
}

/**
 * A redis's Memorystore setting, or `null` for one that does not run on
 * Memorystore: the API answers `memorystore` beside a redis on Google Cloud,
 * and `null` on every other one.
 */
export function memorystoreSettingsOf(
  row: Database,
): MemorystoreRedisSettings | null {
  if (row.kind !== "redis") return null;
  const memorystore = (
    row as Database & { memorystore?: MemorystoreRedisSettings | null }
  ).memorystore;
  return memorystore && typeof memorystore.highAvailability === "boolean"
    ? { highAvailability: memorystore.highAvailability }
    : null;
}

/**
 * What one save of a redis's Memorystore settings names: high availability,
 * or its Backups tab's backup retention
 * 0 (off)
 * to 365 days.
 */
export type SaveMemorystoreRedisSettings =
  | MemorystoreRedisSettings
  | { backupRetentionDays: number };

export const memorystoreRedisApi = {
  /**
   * Saves high availability or the backup retention. Refused (400, naming
   * why) for a redis that does not run on Memorystore, or a retention
   * outside 0–365.
   */
  saveSettings: (redisId: string, input: SaveMemorystoreRedisSettings) =>
    api.patch<unknown>(`/redis/${redisId}/memorystore-settings`, input),
};
