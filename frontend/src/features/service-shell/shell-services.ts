import { tabHref } from "@/components/shell/scope";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Database } from "@/lib/api/endpoints/databases";

import type { ShellService } from "./service-shell";

/**
 * Each Service scope's row → what its shell is, built once so the
 * Shell tab and the Dock's `+` offer name the same target — the same
 * `terminalKey` — and an open tab is listed once.
 */
export function applicationShellService(row: ApplicationDetail): ShellService {
  const scope = {
    kind: "application",
    id: row.applicationId,
    variant: null,
    tab: "",
  } as const;
  return {
    serviceType: "application",
    serviceId: row.applicationId,
    name: row.name,
    environment: row.environment.name,
    project: row.environment.project.name,
    serverId: row.serverId,
    serverName: row.server?.name ?? null,
    noun: "Application",
    overviewHref: tabHref(scope, ""),
    deploymentsHref: tabHref(scope, "deployments"),
  };
}

/** A database has no Deployments tab, so its empty state points at Overview. */
export function databaseShellService(row: Database): ShellService {
  const scope = {
    kind: "database",
    id: row.databaseId,
    variant: row.kind,
    tab: "",
  } as const;
  return {
    serviceType: row.kind,
    serviceId: row.databaseId,
    name: row.name,
    environment: row.environment.name,
    project: row.environment.project.name,
    serverId: row.serverId,
    serverName: row.server?.name ?? null,
    noun: "database",
    overviewHref: tabHref(scope, ""),
  };
}

export function composeShellService(row: ComposeDetail): ShellService {
  const scope = {
    kind: "compose",
    id: row.composeId,
    variant: null,
    tab: "",
  } as const;
  return {
    serviceType: "compose",
    serviceId: row.composeId,
    name: row.name,
    environment: row.environment.name,
    project: row.environment.project.name,
    serverId: row.serverId,
    serverName: row.server?.name ?? null,
    // On its own Stack VM, the shell is reached by the stack (ADR-0070).
    ...(runsOnStackVm(row) ? { composeId: row.composeId } : {}),
    noun: "Compose stack",
    overviewHref: tabHref(scope, ""),
    deploymentsHref: tabHref(scope, "deployments"),
  };
}
