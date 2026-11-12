import { api } from "../client";
import type { RdsKind } from "./existing-postgres";

/**
 * Cloudgate's own setting of a postgres on Cloud SQL
 * or a
 * mysql there,
 * kept per Service and never in the Project config: how many daily
 * automated backups it keeps, 1 to 365, with point-in-time recovery on
 * beside them. 7 by default. The next plan shows the change, and its Apply
 * makes it on Google Cloud with no restart.
 */
export interface SaveCloudSqlPostgresSettings {
  backupRetentionDays: number;
}

export const cloudSqlPostgresApi = {
  /**
   * `PATCH /postgres/:id/cloud-sql-settings`, or `/mysql/:id/…`
   * (`service: update`). Refused (400, naming why) for a retention outside
   * 1–365, or a database that does not run on Cloud SQL.
   */
  saveSettings: (
    kind: RdsKind,
    databaseId: string,
    input: SaveCloudSqlPostgresSettings,
  ) => api.patch<unknown>(`/${kind}/${databaseId}/cloud-sql-settings`, input),
};
