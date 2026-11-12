import { describe, expect, it } from "vitest";

import {
  DATABASE_DESCRIPTORS,
  DATABASE_KIND,
  blankValues,
  databaseSchema,
} from "./kinds";

/**
 * The Database field's hint on the two screens that ask for it. A
 * schedule's dump comes **out of** the database; a restore puts it back
 * **into** one. One sentence shared by both read backwards on one of them for
 * every engine, so each engine carries one of each and this pins the
 * direction of both.
 */
describe("backupDatabaseHint", () => {
  const backedUp = DATABASE_DESCRIPTORS.filter((d) => d.backup !== null);

  it("covers every engine with a backup", () => {
    expect(backedUp.map((d) => d.kind)).toEqual([
      "postgres",
      "mysql",
      "mariadb",
      "mongo",
      "libsql",
    ]);
  });

  it.each(backedUp.map((d) => [d.kind, d] as const))(
    "%s: the schedule hint describes the database dumped, the restore hint the one restored into",
    (_kind, descriptor) => {
      const hint = descriptor.backupDatabaseHint;
      expect(hint).toBeDefined();
      expect(hint!.schedule).not.toMatch(/goes into|restored? into/i);
      expect(hint!.restore).not.toMatch(/to dump\b|gets dumped|dumped from/i);
    },
  );

  it("an engine with no backup has no hint", () => {
    for (const d of DATABASE_DESCRIPTORS.filter((x) => x.backup === null)) {
      expect(d.backupDatabaseHint).toBeUndefined();
    }
  });
});

/**
 * The copied connection string left the database name raw, so
 * `bad name!` produced an invalid URI, unlike the backend's own output.
 */
describe("uri", () => {
  it.each(["postgres", "mysql", "mariadb", "mongo"] as const)(
    "%s percent-encodes the database name as well as the credentials",
    (kind) => {
      const build = DATABASE_KIND[kind].uri;
      if (!build) throw new Error(`${kind} has no URI form`);
      const uri = build({
        user: "Bad User",
        password: "p@ss",
        host: "db-x",
        port: 5432,
        database: "bad name!",
      });
      expect(uri).toContain("/bad%20name!");
      expect(uri).not.toContain("bad name");
      expect(() => new URL(uri)).not.toThrow();
    },
  );
});

/**
 * A create takes the database and user as the backend's
 * `databaseIdentifierSchema` does, so the refusal is on the field and not a
 * 400 after submit. An edit is not checked: an existing row keeps its names.
 */
describe("databaseSchema", () => {
  const values = (kind: "postgres" | "mysql" | "mariadb", over = {}) => ({
    ...blankValues(kind),
    name: "db",
    databaseName: "app",
    databaseUser: "app",
    ...over,
  });

  it.each(["postgres", "mysql", "mariadb"] as const)(
    "%s refuses a name with spaces or punctuation on create",
    (kind) => {
      const schema = databaseSchema(kind, "create");
      expect(schema.safeParse(values(kind)).success).toBe(true);
      const refused = schema.safeParse(
        values(kind, { databaseName: "bad name!" }),
      );
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.path).toEqual(["databaseName"]);
      expect(
        schema.safeParse(values(kind, { databaseUser: "my-user" })).success,
      ).toBe(false);
    },
  );

  it("holds each engine's user length limit", () => {
    expect(
      databaseSchema("mysql", "create").safeParse(
        values("mysql", { databaseUser: "a".repeat(33) }),
      ).success,
    ).toBe(false);
    expect(
      databaseSchema("mariadb", "create").safeParse(
        values("mariadb", { databaseUser: "a".repeat(33) }),
      ).success,
    ).toBe(true);
  });

  it("refuses a Postgres user starting pg_", () => {
    expect(
      databaseSchema("postgres", "create").safeParse(
        values("postgres", { databaseUser: "pg_app" }),
      ).success,
    ).toBe(false);
  });

  it("leaves an edit's names alone", () => {
    expect(
      databaseSchema("postgres", "update").safeParse(
        values("postgres", { databaseName: "bad name!" }),
      ).success,
    ).toBe(true);
  });
});
