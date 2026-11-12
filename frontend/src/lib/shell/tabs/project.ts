import { panel, type TabEntry } from "../tab-registry";

/**
 * Project scope — the reference's `PROJ_NAV` (e-console.html:2024-2028).
 *
 * A Project contains Environments and nothing else (`CONTEXT.md`), which is why
 * this is the shortest table in the app. Its Project config is one page
 * here: the YAML, and each Environment's Plan.
 *
 * **Panels belong to F08.** `src/features/project/panels/`.
 */
export const PROJECT_TABS: readonly TabEntry[] = [
  {
    slug: "",
    label: "Environments",
    icon: "list",
    panel: panel(() => import("@/features/project/panels/environments")),
  },
  {
    slug: "config",
    label: "Config",
    icon: "layers",
    panel: panel(() => import("@/features/project/panels/config")),
  },
  {
    slug: "settings",
    label: "Settings",
    icon: "cog",
    ruleAbove: true,
    panel: panel(() => import("@/features/project/panels/settings")),
  },
];
