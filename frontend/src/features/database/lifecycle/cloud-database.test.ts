import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/api/endpoints/databases";

import { cloudDatabaseOf } from "./cloud-database";

const onCloud = (fields: Partial<Database>) =>
  ({ databaseId: "db-id", cloudAccountId: "ca-1", ...fields }) as Database;

/**
 * A mysql on Cloud SQL gets the Cloud SQL pages a postgres there
 * has — its settings note, Stop's warning, its Backups tab and its Delete —
 * all chosen by this one reading of the row.
 */
describe("cloudDatabaseOf", () => {
  it.each(["postgres", "mysql"] as const)(
    "reads a %s answered with cloudSqlStop as one on Cloud SQL, and one without as on RDS",
    (kind) => {
      expect(cloudDatabaseOf(onCloud({ cloudSqlStop: null }), kind)).toBe(
        "cloud-sql",
      );
      expect(cloudDatabaseOf(onCloud({ rdsStop: null }), kind)).toBe("rds");
    },
  );

  it("reads a database off a Cloud account as on a Server", () => {
    expect(
      cloudDatabaseOf(onCloud({ cloudAccountId: null }), "mysql"),
    ).toBeNull();
  });
});
