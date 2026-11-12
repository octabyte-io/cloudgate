import { panel, type TabEntry } from "../tab-registry";

/**
 * Server scope — the reference's `SERVER_NAV` (e-console.html:2014-2022),
 * minus nothing: every row in it has a backend.
 *
 * **Panels belong to F13.** `src/features/server/panels/`.
 *
 * **F13 added one row: Terminal** (contract rule 2, and this is the reasoning it
 * asks for). The reference has "Open a shell" as a header action, and a dialog is
 * the wrong container for a terminal in a way that is not a matter of taste:
 * Escape closes a dialog and Escape is a key people press inside a shell
 * constantly, so every `vim`, `less` or mistyped command would end the session. A
 * tab also gives a shell an **address**, so it can be opened beside the screen
 * that sent somebody looking for one — every other Server tab's header links to
 * it — and it gets a page header, which is where a privileged surface should say
 * which host it is attached to.
 */
/**
 * The Request logging card's `id` on a Server's Settings tab, so another
 * feature can link straight to it — the Requests page does, as
 * `/servers/<id>/settings#request-logging`. Here rather than in the card's
 * feature because two features use it and neither may import the other.
 */
export const REQUEST_LOGGING_ANCHOR = "request-logging";

export const SERVER_TABS: readonly TabEntry[] = [
  {
    slug: "",
    label: "Overview",
    icon: "gauge",
    panel: panel(() => import("@/features/server/panels/overview")),
  },
  {
    slug: "infrastructure",
    label: "Infrastructure",
    icon: "layers",
    panel: panel(() => import("@/features/server/panels/infrastructure")),
  },
  {
    slug: "telemetry",
    label: "Telemetry",
    icon: "activity",
    panel: panel(() => import("@/features/server/panels/telemetry")),
  },
  {
    // Docker's own words for its own features, which the vocabulary rule keeps.
    slug: "docker",
    label: "Docker & Swarm",
    icon: "box",
    panel: panel(() => import("@/features/server/panels/docker")),
  },
  {
    slug: "access",
    label: "Access",
    icon: "key",
    panel: panel(() => import("@/features/server/panels/access")),
  },
  {
    slug: "terminal",
    label: "Terminal",
    icon: "term",
    panel: panel(() => import("@/features/server/panels/terminal")),
  },
  {
    slug: "settings",
    label: "Settings",
    icon: "cog",
    ruleAbove: true,
    panel: panel(() => import("@/features/server/panels/settings")),
  },
];
