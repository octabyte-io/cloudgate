import { panel, type TabEntry, type TabSubject } from "../tab-registry";
import { noShell } from "./shell";

/**
 * Compose scope — `SVC_NAV` as it stands, because a Compose stack is the one
 * other thing the backend treats like an Application: it has deployments
 * (`GET /compose/:id/deployments`), its own env (`PATCH /:id/environment`) and
 * domains (`GET /compose/:id/domains`).
 *
 * A separate table from `APPLICATION_TABS` even though the two currently read
 * the same, because they are two resources whose tabs are free to diverge — and
 * because merging them would put F09's and F12's panels in one list.
 *
 * **Panels belong to F12.** `src/features/compose/panels/`.
 *
 * **F12 added three rows here** — contract rule 2, and the reason for each. All
 * three are things a Compose stack has and an Application does not, which is why
 * `SVC_NAV` (written for one shared service scope) has no room for them:
 *
 * - **Converted.** A stack is deployed from a file the platform *rewrites* on the
 *   way past — Traefik labels per domain, and a join to the shared network unless
 *   the stack is isolated. What is applied is therefore not what is in the
 *   editor, and the difference is the single most consequential thing an operator
 *   can be shown here. It is its own tab rather than a dialog off Overview
 *   because it is a *reading* of the stack,
 *   not an action on it — and because what it currently has to say is that the
 *   route which would answer it does not exist
 * which is not a
 *   thing to hide behind a click.
 * - **Containers.** One Application is one service; one stack is *n* of them,
 *   each with its own state and its own lifecycle. There is nowhere on an
 *   Application's Overview this would go, because for an Application it would be
 *   a table of one row.
 * - **Logs.** Follows from Containers: with several containers, "the logs" is a
 *   choice before it is a stream. An Application's own output has no such
 *   choice, which is why F09 needed no tab for it.
 */
export const COMPOSE_TABS: readonly TabEntry[] = [
  {
    slug: "",
    label: "Overview",
    icon: "gauge",
    panel: panel(() => import("@/features/compose/panels/overview")),
  },
  {
    slug: "converted",
    label: "Converted",
    icon: "layers",
    panel: panel(() => import("@/features/compose/panels/converted")),
  },
  {
    slug: "containers",
    label: "Containers",
    icon: "box",
    panel: panel(() => import("@/features/compose/panels/containers")),
  },
  {
    slug: "logs",
    label: "Logs",
    icon: "term",
    panel: panel(() => import("@/features/compose/panels/logs")),
  },
  // `sh` in one of the stack's running containers, picked by its
  // compose service. Absent for a role without service:update.
  {
    slug: "shell",
    label: "Shell",
    icon: "term",
    absentBecause: noShell("Compose stack"),
    panel: panel(() => import("@/features/compose/panels/shell")),
  },
  // The files a Template shipped with the stack (#135), after Shell.
  // Absent for a stack with none, or a role that cannot read volumes.
  {
    slug: "config-files",
    label: "Config files",
    icon: "lines",
    absentBecause: noConfigFiles,
    panel: panel(() => import("@/features/compose/panels/config-files")),
  },
  {
    slug: "deployments",
    label: "Deployments",
    icon: "rocket",
    panel: panel(() => import("@/features/compose/panels/deployments")),
  },
  {
    slug: "domains",
    label: "Domains",
    icon: "globe",
    panel: panel(() => import("@/features/compose/panels/domains")),
  },
  // After Domains on every Service kind.
  {
    slug: "health",
    label: "Health",
    icon: "activity",
    panel: panel(() => import("@/features/compose/panels/health")),
  },
  // After Health, as on an Application — every inner service's spans,
  // read from the Compose's one Trace store.
  {
    slug: "traces",
    label: "Traces",
    icon: "route",
    panel: panel(() => import("@/features/compose/panels/traces")),
  },
  // After Traces, as on an Application — the requests its Server's
  // Traefik logged for the stack's Domains.
  {
    slug: "requests",
    label: "Requests",
    icon: "globe",
    panel: panel(() => import("@/features/compose/panels/requests")),
  },
  {
    slug: "variables",
    label: "Variables",
    icon: "hash",
    panel: panel(() => import("@/features/compose/panels/variables")),
  },
  // The stack's named volumes copied off its Server (#163). Absent in a
  // Cloud account, where there is no Server to tar on (ADR-0092).
  {
    slug: "volume-backups",
    label: "Volume backups",
    icon: "db",
    absentBecause: noVolumeBackups,
    panel: panel(() => import("@/features/compose/panels/volume-backups")),
  },
  {
    slug: "advanced",
    label: "Advanced",
    icon: "sliders",
    ruleAbove: true,
    panel: panel(() => import("@/features/compose/panels/advanced")),
  },
];

/** Why a Compose stack has no Volume backups tab: it runs in a Cloud account. */
function noVolumeBackups(subject: TabSubject): string | null {
  if (subject.stackVm !== true) return null;
  return "Only a stack on a Server or on this host has Volume backups. This Compose stack runs in a Cloud account, so there is no Server to copy its volumes on.";
}

/**
 * Why a Compose stack has no Config files tab (#135). Its config files are
 * its `file` mounts, which only a Template makes, read through
 * `GET /mounts` (`volume: ['read']`).
 */
function noConfigFiles(subject: TabSubject): string | null {
  if (subject.configFiles === true) return null;
  if (subject.configFiles === "refused") {
    return "Your role in this Organization cannot read this Compose stack's config files, which takes the read action on volumes. Ask an owner or an admin to do it, or to change your role.";
  }
  return "Only a stack set up from a Template that ships config files has this tab, and this one has none.";
}
