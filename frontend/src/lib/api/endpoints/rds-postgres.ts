import { api } from "../client";
import type { Database } from "./databases";
import { isRdsKind, type RdsKind } from "./existing-postgres";

/**
 * Cloudgate's own settings of a postgres or a mysql on RDS, kept per Service
 * and never in the Project config. The next plan shows each one moving, and its Apply makes it on AWS.
 *
 * `instanceClass` is set only for an entry with no `size`: the class is then
 * Cloudgate's and editable here. With a size, it is `null` and the size in
 * the config decides the class.
 */
export interface RdsPostgresSettings {
  instanceClass: string | null;
  storageGb: number;
  maxStorageGb: number;
  multiAz: boolean;
  backupRetentionDays: number;
}

/** What `PATCH /postgres/:id/rds-settings` takes: any of them. */
export type SaveRdsPostgresSettings = Partial<
  Omit<RdsPostgresSettings, "instanceClass"> & { instanceClass: string }
>;

/**
 * The classes Cloudgate chooses for an RDS postgres, smallest first, with
 * AWS's published CPU and memory: the backend's `RDS_CLASSES`. The API
 * refuses any other.
 */
export const RDS_CLASS_OPTIONS = [
  { value: "db.t4g.micro", label: "db.t4g.micro", detail: "2 vCPU, 1 GB" },
  { value: "db.t4g.small", label: "db.t4g.small", detail: "2 vCPU, 2 GB" },
  {
    value: "db.t4g.medium",
    label: "db.t4g.medium",
    detail: "2 vCPU, 4 GB",
  },
  { value: "db.t4g.large", label: "db.t4g.large", detail: "2 vCPU, 8 GB" },
  {
    value: "db.t4g.xlarge",
    label: "db.t4g.xlarge",
    detail: "4 vCPU, 16 GB",
  },
  {
    value: "db.t4g.2xlarge",
    label: "db.t4g.2xlarge",
    detail: "8 vCPU, 32 GB",
  },
  { value: "db.m7g.large", label: "db.m7g.large", detail: "2 vCPU, 8 GB" },
  {
    value: "db.m7g.xlarge",
    label: "db.m7g.xlarge",
    detail: "4 vCPU, 16 GB",
  },
  {
    value: "db.m7g.2xlarge",
    label: "db.m7g.2xlarge",
    detail: "8 vCPU, 32 GB",
  },
] as const;

/**
 * A postgres's or a mysql's RDS settings, or `null` for one that does not
 * run on RDS: its row in a Cloud account carries them beside its place.
 */
export function rdsSettingsOf(row: Database): RdsPostgresSettings | null {
  if (!isRdsKind(row.kind)) return null;
  const cloud = row as Database &
    Partial<RdsPostgresSettings> & {
      cloudAccountId?: string | null;
    };
  if (
    !cloud.cloudAccountId ||
    typeof cloud.storageGb !== "number" ||
    typeof cloud.maxStorageGb !== "number" ||
    typeof cloud.multiAz !== "boolean" ||
    typeof cloud.backupRetentionDays !== "number"
  ) {
    return null;
  }
  return {
    instanceClass: cloud.instanceClass ?? null,
    storageGb: cloud.storageGb,
    maxStorageGb: cloud.maxStorageGb,
    multiAz: cloud.multiAz,
    backupRetentionDays: cloud.backupRetentionDays,
  };
}

export const rdsPostgresApi = {
  /**
   * Saves any of the settings. Refused (400, naming why) for a retention
   * outside 1–35, storage under 20 GB or below what the instance has, a
   * ceiling under the storage, or a class when the config's size decides it.
   */
  saveSettings: (
    kind: RdsKind,
    databaseId: string,
    input: SaveRdsPostgresSettings,
  ) => api.patch<unknown>(`/${kind}/${databaseId}/rds-settings`, input),
};
