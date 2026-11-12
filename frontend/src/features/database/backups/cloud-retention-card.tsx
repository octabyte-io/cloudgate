import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import type {
  CloudBackups,
  CloudDatabaseKind,
} from "@/lib/api/endpoints/cloud-backups";
import { cloudSqlPostgresApi } from "@/lib/api/endpoints/cloud-sql-postgres";
import { elastiCacheRedisApi } from "@/lib/api/endpoints/elasticache-redis";
import { memorystoreRedisApi } from "@/lib/api/endpoints/memorystore-redis";
import { rdsPostgresApi } from "@/lib/api/endpoints/rds-postgres";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";

/** One engine's retention: its bounds, its words and where it is saved. */
interface Retention {
  readonly title: string;
  readonly lede: string;
  readonly min: number;
  readonly max: number;
  readonly hint: string;
  readonly belowMin: string;
  readonly aboveMax: string;
  readonly cloud: string;
  save(
    kind: CloudDatabaseKind,
    databaseId: string,
    days: number,
  ): Promise<unknown>;
}

const RETENTION: Record<CloudBackups["engine"], Retention> = {
  /** RDS keeps automated backups 1 to 35 days; 0 would turn them off. */
  rds: {
    title: "Backup retention",
    lede: "How long RDS keeps automated backups, and so how far back point-in-time restore reaches.",
    min: 1,
    max: 35,
    hint: "1 to 35 days.",
    belowMin:
      "At least 1 day: 0 turns off RDS automated backups and point-in-time restore.",
    aboveMax: "RDS keeps automated backups 35 days at most.",
    cloud: "AWS",
    save: (kind, databaseId, days) =>
      rdsPostgresApi.saveSettings(
        kind === "mysql" ? "mysql" : "postgres",
        databaseId,
        {
          backupRetentionDays: days,
        },
      ),
  },
  /** ElastiCache keeps daily snapshots 0 to 35 days; 0 is off. */
  elasticache: {
    title: "Snapshot retention",
    lede: "How long ElastiCache keeps its daily snapshots. 0 turns them off.",
    min: 0,
    max: 35,
    hint: "0 to 35 days; 0 is off.",
    belowMin: "0 turns snapshots off; it cannot go below.",
    aboveMax: "ElastiCache keeps snapshots 35 days at most.",
    cloud: "AWS",
    save: (_kind, databaseId, days) =>
      elastiCacheRedisApi.saveSettings(databaseId, {
        snapshotRetentionDays: days,
      }),
  },
  /**
   * Cloud SQL keeps 1 to 365 daily automated backups
   * 0
   * would turn them and point-in-time recovery off.
   */
  "cloud-sql": {
    title: "Backup retention",
    lede: "How many daily automated backups Cloud SQL keeps. Point-in-time recovery is on beside them.",
    min: 1,
    max: 365,
    hint: "1 to 365 days.",
    belowMin:
      "At least 1 day: 0 turns off Cloud SQL automated backups and point-in-time recovery.",
    aboveMax: "Cloud SQL keeps 365 automated backups at most.",
    cloud: "Google Cloud",
    save: (kind, databaseId, days) =>
      cloudSqlPostgresApi.saveSettings(
        kind === "mysql" ? "mysql" : "postgres",
        databaseId,
        { backupRetentionDays: days },
      ),
  },
  /** Memorystore keeps each daily backup 0 to 365 days; 0 is off. */
  memorystore: {
    title: "Backup retention",
    lede: "How long Memorystore keeps each daily backup. 0 turns them off.",
    min: 0,
    max: 365,
    hint: "0 to 365 days; 0 is off.",
    belowMin: "0 turns backups off; it cannot go below.",
    aboveMax: "Memorystore keeps a backup 365 days at most.",
    cloud: "Google Cloud",
    save: (_kind, databaseId, days) =>
      memorystoreRedisApi.saveSettings(databaseId, {
        backupRetentionDays: days,
      }),
  },
};

function schemaOf(retention: Retention) {
  return z.object({
    retentionDays: z.coerce
      .number()
      .int("Retention has to be a whole number of days.")
      .min(retention.min, retention.belowMin)
      .max(retention.max, retention.aboveMax),
  });
}

type RetentionValues = z.infer<ReturnType<typeof schemaOf>>;

/**
 * A cloud database's retention, edited on its Backups tab
 * a postgres
 * or mysql on RDS's backup retention (one of its RDS settings, 1–35 days), a
 * redis on ElastiCache's snapshot retention (0–35, 0 off), and on Google
 * Cloud a
 * postgres on Cloud SQL's (1–365) or a redis on Memorystore's (0–365, 0
 * off). It is Cloudgate's, kept per Service and never in the Project config;
 * the Save stores it, and the next Cloud run makes it in the cloud.
 */
export function CloudRetentionCard({
  row,
  kind,
  engine,
  retentionDays,
}: {
  row: Database;
  kind: CloudDatabaseKind;
  engine: CloudBackups["engine"];
  retentionDays: number;
}) {
  // Each engine's settings route is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const retention = RETENTION[engine];
  const save = useMutation({
    mutationFn: (days: number) => retention.save(kind, row.databaseId, days),
    onSuccess: () =>
      // The database's key holds its cloud backups too.
      invalidate.database({
        kind,
        databaseId: row.databaseId,
        environmentId: row.environmentId,
      }),
  });

  return (
    <SettingsCard
      title={retention.title}
      gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
      lede={retention.lede}
      schema={schemaOf(retention)}
      fields={[
        {
          kind: "number",
          name: "retentionDays",
          label: "Days",
          min: retention.min,
          max: retention.max,
          hint: retention.hint,
        },
      ]}
      savedMessage={`Saved. The next Cloud run makes it on ${retention.cloud}; Check for changes to see it in the plan.`}
      defaultValues={{ retentionDays } satisfies RetentionValues}
      submit={({ retentionDays: days }) => save.mutateAsync(days)}
      footer={`Nothing changes on ${retention.cloud} until a Cloud run applies it.`}
    />
  );
}
