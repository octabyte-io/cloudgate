import { panel, type TabEntry } from "../tab-registry";
import { noShell } from "./shell";

/**
 * Database scope — `SVC_NAV` minus the two tabs a managed database has no
 * backend for, and the omissions are the interesting part:
 *
 * - **No Deployments.** `deployments.controller.ts` lists a Deployment by
 *   Application or by Compose stack and by nothing else, so a database has runs
 *   nobody can enumerate. `POST /:kind/:id/deploy` exists and belongs on
 *   Overview beside start / stop / rebuild.
 * - **No Domains.** `domains.controller.ts` offers
 *   `applications/:id/domains` and `compose/:id/domains`. A managed database is
 *   reached on a port, not a hostname.
 *
 * One table for all six engines. They are one controller shape
 * (`databases/common/database-service.ts`) and one navigation; the engine is a
 * prop (`PanelProps.kind`), not a sixth of the rail.
 *
 * **Panels belong to F11.** `src/features/database/panels/`.
 *
 * **F11 added two rows here** — contract rule 2, and the reason for each:
 *
 * - **Credentials.** A managed database has a concern an Application does not:
 *   a connection identity other services need, half of it secret, and a switch
 *   that decides whether anything outside the Server can reach it. On Overview
 *   it would put a masked password and an exposure warning under a name field;
 *   on Advanced it would file the most-visited screen in this scope under the
 *   tab marked "you probably do not need this".
 * - **Backups.** Half of it is a stated absence (no list route for schedules)
 *   and half of it is a restore that destroys data. Neither belongs on a tab
 *   with anything else.
 */
export const DATABASE_TABS: readonly TabEntry[] = [
  {
    slug: "",
    label: "Overview",
    icon: "gauge",
    panel: panel(() => import("@/features/database/panels/overview")),
  },
  {
    slug: "credentials",
    label: "Credentials",
    icon: "key",
    panel: panel(() => import("@/features/database/panels/credentials")),
  },
  {
    slug: "variables",
    label: "Variables",
    icon: "hash",
    panel: panel(() => import("@/features/database/panels/variables")),
  },
  // `sh` in the engine's running container. Absent for a database in
  // a Cloud account, which runs none, and for a role without service:update.
  {
    slug: "shell",
    label: "Shell",
    icon: "term",
    absentBecause: noShell("database"),
    panel: panel(() => import("@/features/database/panels/shell")),
  },
  {
    slug: "backups",
    label: "Backups",
    icon: "hdd",
    panel: panel(() => import("@/features/database/panels/backups")),
  },
  // "after Domains" on every Service kind, and a database
  // has no Domains tab, so it is the last row above the rule — where it sits
  // on an Application too. Its checks section is empty until a TCP check exists.
  {
    slug: "health",
    label: "Health",
    icon: "activity",
    panel: panel(() => import("@/features/database/panels/health")),
  },
  {
    slug: "advanced",
    label: "Advanced",
    icon: "sliders",
    ruleAbove: true,
    panel: panel(() => import("@/features/database/panels/advanced")),
  },
];
