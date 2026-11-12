"use client";

import { ServiceShell } from "@/features/service-shell/service-shell";
import { databaseShellService } from "@/features/service-shell/shell-services";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useDatabase } from "../use-database";

/**
 * A database's **Shell** tab: `sh` in its engine's running
 * container — for `psql`, `redis-cli` and friends. Absent for a database in a
 * Cloud account, which runs none, and for a role without `service:update`
 * (`tabs/database.ts`). A database has no Deployments tab, so the empty state
 * points at Overview alone.
 */
export default function Panel({ id, kind, label, icon }: PanelProps) {
  const database = useDatabase(kind, id);
  const row = database.data;

  return (
    <ServiceShell
      label={label}
      icon={icon}
      error={database.error}
      pending={database.isPending}
      service={row ? databaseShellService(row) : null}
    />
  );
}
