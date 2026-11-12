import { api } from "../client";
import type { Database } from "./databases";

/**
 * Cloudgate's own settings of a redis on ElastiCache, kept per
 * Service and never in the Project config. The
 * next plan shows each one moving, and its Apply makes it on AWS.
 *
 * `nodeType` is set only for an entry with no `size`: the node type is then
 * Cloudgate's and editable here. With a size, it is `null` and the size in
 * the config decides the node type.
 */
export interface ElastiCacheRedisSettings {
  nodeType: string | null;
  replica: boolean;
  snapshotRetentionDays: number;
}

/** What `PATCH /redis/:id/elasticache-settings` takes: any of them. */
export type SaveElastiCacheRedisSettings = Partial<
  Omit<ElastiCacheRedisSettings, "nodeType"> & { nodeType: string }
>;

/**
 * The node types Cloudgate chooses for a redis on ElastiCache, smallest
 * first, with AWS's published CPU and memory: the backend's
 * `ELASTICACHE_NODE_TYPES`. The API refuses any other.
 */
export const ELASTICACHE_NODE_TYPE_OPTIONS = [
  {
    value: "cache.t4g.micro",
    label: "cache.t4g.micro",
    detail: "2 vCPU, 512 MB",
  },
  {
    value: "cache.t4g.small",
    label: "cache.t4g.small",
    detail: "2 vCPU, 1.37 GB",
  },
  {
    value: "cache.t4g.medium",
    label: "cache.t4g.medium",
    detail: "2 vCPU, 3.09 GB",
  },
  {
    value: "cache.m7g.large",
    label: "cache.m7g.large",
    detail: "2 vCPU, 6.38 GB",
  },
  {
    value: "cache.m7g.xlarge",
    label: "cache.m7g.xlarge",
    detail: "4 vCPU, 12.7 GB",
  },
  {
    value: "cache.m7g.2xlarge",
    label: "cache.m7g.2xlarge",
    detail: "8 vCPU, 25.01 GB",
  },
] as const;

/**
 * A redis's ElastiCache settings, or `null` for one that does not run on
 * ElastiCache: a redis row in a Cloud account carries them beside its place.
 */
export function elastiCacheSettingsOf(
  row: Database,
): ElastiCacheRedisSettings | null {
  if (row.kind !== "redis") return null;
  const cloud = row as Database &
    Partial<ElastiCacheRedisSettings> & {
      cloudAccountId?: string | null;
    };
  if (
    !cloud.cloudAccountId ||
    typeof cloud.replica !== "boolean" ||
    typeof cloud.snapshotRetentionDays !== "number"
  ) {
    return null;
  }
  return {
    nodeType: cloud.nodeType ?? null,
    replica: cloud.replica,
    snapshotRetentionDays: cloud.snapshotRetentionDays,
  };
}

export const elastiCacheRedisApi = {
  /**
   * Saves any of the settings. Refused (400, naming why) for a snapshot
   * retention outside 0–35, or a node type when the config's size decides
   * it or one Cloudgate does not choose.
   */
  saveSettings: (redisId: string, input: SaveElastiCacheRedisSettings) =>
    api.patch<unknown>(`/redis/${redisId}/elasticache-settings`, input),
};
