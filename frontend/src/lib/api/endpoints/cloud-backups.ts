import { api } from "../client";
import type { Database } from "./databases";

/**
 * One snapshot of a cloud database as AWS lists it
 * or one
 * backup as Google Cloud lists it
 * an
 * automatic one the cloud takes daily and deletes after the retention, or a
 * kept (manual, on-demand) one, a final snapshot or backup among them, that
 * stays until deleted.
 */
export interface CloudSnapshot {
  id: string;
  type: "automated" | "manual";
  /** ISO 8601, or `null` while AWS is still taking it. */
  createdAt: string | null;
  /** AWS's own word: `available`, `creating`, … */
  status: string;
  /** In AWS's own words (`20 GB`, `5 MB`), or `null` when it gives none. */
  size: string | null;
}

/**
 * `GET /postgres/:id/cloud-backups`, `GET /mysql/:id/cloud-backups` and `GET /redis/:id/cloud-backups`
 * (`backup: read`): what RDS, ElastiCache, Cloud SQL or Memorystore holds,
 * read live each time, beside the retention Cloudgate keeps for the Service.
 */
export interface CloudBackups {
  /** RDS and ElastiCache on AWS; Cloud SQL and Memorystore on Google Cloud. */
  engine: "rds" | "elasticache" | "cloud-sql" | "memorystore";
  /** The instance or replication group, by its name in its cloud. */
  identifier: string;
  region: string;
  /** False until the first Cloud run makes it: its cloud has nothing to list. */
  made: boolean;
  /** Cloudgate's setting, applied by the next Cloud run. */
  retentionDays: number;
  /** What its cloud runs with now. */
  liveRetentionDays: number | null;
  /**
   * How far back a restore reaches: point-in-time restore on RDS and Cloud
   * SQL, the oldest and newest backup on Memorystore; `null` on ElastiCache.
   */
  restorableWindow: { earliest: string | null; latest: string | null } | null;
  snapshots: CloudSnapshot[];
  /** The instance in its cloud's console, where a restore is made; `null` on ElastiCache. */
  consoleUrl: string | null;
}

/** Which cloud an engine is in. */
export function onGoogleCloud(engine: CloudBackups["engine"]): boolean {
  return engine === "cloud-sql" || engine === "memorystore";
}

/** The kinds of database a Cloud account runs: a mysql on RDS too. */
export type CloudDatabaseKind = "postgres" | "mysql" | "redis";

/**
 * Whether the database runs in a Cloud account (RDS or ElastiCache) rather
 * than on a Server: its row carries the Cloud account it was made in.
 */
export function cloudDatabaseKind(row: Database): CloudDatabaseKind | null {
  if (row.kind !== "postgres" && row.kind !== "mysql" && row.kind !== "redis") {
    return null;
  }
  const place = row as Database & { cloudAccountId?: string | null };
  return place.cloudAccountId ? row.kind : null;
}

export const cloudBackupsApi = {
  read: (kind: CloudDatabaseKind, databaseId: string) =>
    api.get<CloudBackups>(`/${kind}/${databaseId}/cloud-backups`),
};
