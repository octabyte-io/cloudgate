import { panel, type TabEntry } from "../tab-registry";

/**
 * Environment scope — the reference's `ENV_NAV` (e-console.html:2030-2038),
 * minus **Runtime**: it read `environment.runtime`, a column the prototype
 * itself marked as proposed and the schema does not have.
 *
 * The first tab is **Services**, and that word is deliberate. An Environment
 * "owns the actual services — applications, databases, compose stacks"
 * (`CONTEXT.md`), so this one list holds all three kinds and the collective noun
 * is the domain model's own. The vocabulary rule bans *service* as a synonym for
 * **Application** — one Application is never "a service" — and that is a
 * different sentence from naming the mixed set. `ServiceRow` is the row shape it
 * renders.
 *
 * **Panels belong to F08.** `src/features/environment/panels/`.
 */
export const ENVIRONMENT_TABS: readonly TabEntry[] = [
  {
    slug: "",
    label: "Services",
    icon: "box",
    panel: panel(() => import("@/features/environment/panels/services")),
  },
  {
    slug: "deployments",
    label: "Deployments",
    icon: "rocket",
    panel: panel(() => import("@/features/environment/panels/deployments")),
  },
  {
    slug: "variables",
    label: "Variables",
    icon: "hash",
    panel: panel(() => import("@/features/environment/panels/variables")),
  },
  {
    slug: "domains",
    label: "Domains",
    icon: "globe",
    panel: panel(() => import("@/features/environment/panels/domains")),
  },
  {
    slug: "settings",
    label: "Settings",
    icon: "cog",
    ruleAbove: true,
    panel: panel(() => import("@/features/environment/panels/settings")),
  },
];
