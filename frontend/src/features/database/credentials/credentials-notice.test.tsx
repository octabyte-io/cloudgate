import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

import { connectionFields } from "../kinds";
import { CredentialsNotice } from "./credentials-notice";

afterEach(cleanup);

/**
 * When a credential saved on the Credentials card reaches the engine, per
 * engine. Measured, not re-read: Redis's password is applied on every
 * start by `RedisService.containerCommand`'s `--requirepass` wrapper, and
 * LibSQL's `SQLD_HTTP_AUTH` was restarted against an existing `iku.db` with a
 * new value — the new credential answered 200, the old one 401, and the data
 * was still there. The four entrypoint-driven images read theirs only against
 * an empty data directory.
 */
function mount(kind: DatabaseKind) {
  const row = { replicaSets: false, command: null, args: null } as unknown as Database;
  render(<CredentialsNotice row={row} kind={kind} />);
  return document.body.textContent ?? "";
}

describe("CredentialsNotice", () => {
  it.each(["postgres", "mysql", "mariadb", "mongo"] as const)(
    "warns that %s reads its credentials only on first start",
    (kind) => {
      const text = mount(kind);

      expect(text).toContain("only on first start");
      expect(text).toContain("change it in the engine as well");
    },
  );

  it.each(["redis", "libsql"] as const)(
    "says a %s credential applies at the next deploy, with no first-start warning",
    (kind) => {
      const text = mount(kind);

      expect(text).not.toContain("only on first start");
      expect(text).not.toContain("change it in the engine as well");
      expect(text).toContain("applies at the next deploy");
    },
  );

  it("says a Redis password is only enforced while its Run command is empty", () => {
    expect(mount("redis")).toContain("Run command");
  });
});

describe("connectionFields", () => {
  const userHint = (kind: DatabaseKind) =>
    String(
      connectionFields(kind).find((field) => field.name === "databaseUser")
        ?.hint,
    );

  it("says a LibSQL user is read on every start, not created on the first", () => {
    expect(userHint("libsql")).not.toContain("Created on first start");
    expect(userHint("libsql")).toContain("next deploy");
  });

  it("still says a Postgres user is created on first start", () => {
    expect(userHint("postgres")).toContain("Created on first start");
  });
});
