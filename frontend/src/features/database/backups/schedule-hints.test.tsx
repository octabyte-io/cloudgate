import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";

import type { BackupDatabaseType } from "@/lib/api/endpoints/backups";

import { DumpPath } from "./schedule-hints";

afterEach(cleanup);

function Form({ children }: { children: ReactNode }) {
  const form = useForm({
    defaultValues: { destinationId: "", prefix: "nightly/" },
  });
  return <FormProvider {...form}>{children}</FormProvider>;
}

function preview(databaseType: BackupDatabaseType) {
  render(
    <Form>
      <DumpPath appName="app-x1" databaseType={databaseType} destinations={[]} />
    </Form>,
  );
  return document.body.textContent ?? "";
}

/**
 * The path preview names the object the run writes, extension included
 * `BACKUP_COMMANDS[engine].extension` on the backend.
 */
describe("DumpPath", () => {
  it.each<[BackupDatabaseType, string]>([
    ["postgres", "sql.gz"],
    ["mysql", "sql.gz"],
    ["mariadb", "sql.gz"],
    ["mongo", "bson.gz"],
    ["libsql", "tar.gz"],
  ])("%s writes a .%s", (type, extension) => {
    expect(preview(type)).toContain(
      `<bucket>/app-x1/nightly/2026-08-11T02-00-00-000Z.${extension}`,
    );
  });
});
