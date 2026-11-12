import { panel, type TabEntry, type TabSubject } from "../tab-registry";
import { noShell } from "./shell";

/**
 * Whether a row is an AI model: it carries the model facet. Here and
 * not in `tab-registry.ts`, which imports this table — a predicate from there
 * would still be undefined when the table below is built.
 */
function isAiModel(subject: TabSubject): boolean {
  return subject.aiModel != null;
}

/**
 * Why each tab a row may lack is absent, in the words a visit to its URL
 * shows. One function per tab, because the reason is the tab's: the
 * single sentence every hidden tab used to share was the AI model's, and it
 * was what `/logs` on an Application on a Server was told.
 */
const notAModel = (subject: TabSubject) =>
  isAiModel(subject)
    ? null
    : "Only an AI model has a Model tab. This Application runs code of its own, and its runtime settings are on Advanced.";

/**
 * Every Application with a running place has a Runtime log (#1341): in a
 * Cloud account the cloud's log store, on a Server or the platform host its
 * Swarm service's output. A Cron service on a Server or the platform host has
 * no long-running service — each run is its own job — so it has none; one in a
 * Cloud account keeps the cloud's log, which holds its runs' output. And the
 * log takes `service:read`, so
 * a role known not to hold it is told so (`logsAllowed` fails open, as
 * `shellAllowed` does).
 */
const noLogs = (subject: TabSubject) => {
  if (subject.configKind === "cron" && subject.cloudPlace == null) {
    return "A Cron service has no Logs tab: nothing of it runs between runs, and each run is its own job. What a run wrote is its Deployment's output, on the Deployments tab.";
  }
  if (subject.logsAllowed === false) {
    return "Your role in this Organization cannot read this Application's Runtime log, which takes the read action on Services. Ask an owner or an admin to change your role.";
  }
  return null;
};

const noDomains = (subject: TabSubject) =>
  isAiModel(subject)
    ? "An AI model takes no Domain: it is reached through its gateway endpoint, on the Model tab."
    : null;

/** A Server's access log matches a line to a Service by its Domain. */
const noRequests = (subject: TabSubject) =>
  isAiModel(subject)
    ? "An AI model takes no Domain, so no request in a Server's access log is its: it is reached through its gateway endpoint, on the Model tab."
    : null;

/**
 * A preview builds a branch (`isBranchedSource` on the backend), so an image
 * or an upload has none to build.
 */
const noPreviews = (subject: TabSubject) =>
  isAiModel(subject)
    ? "An AI model has no previews: nothing about it is built from a branch."
    : subject.sourceType === "docker"
      ? "A preview builds a branch, and this Application runs a Docker image, which has none. Previews are offered once its source is a repository."
      : subject.sourceType === "drop"
        ? "A preview builds a branch, and this Application's source is uploaded files, which have none. Previews are offered once its source is a repository."
        : null;

/**
 * A patch changes source files before a build, so an image, which is never
 * built, has nothing for one to change. Uploaded files are
 * built, and keep the tab.
 */
const noPatches = (subject: TabSubject) =>
  isAiModel(subject)
    ? "An AI model has no Patches: nothing about it is built from source."
    : subject.sourceType === "docker"
      ? "A patch changes source files before a build, and this Application runs a Docker image, which is never built. Patches already written are kept, and apply again if the source changes back to a repository."
      : null;

/**
 * Application scope — the reference's `SVC_NAV` (e-console.html:2040-2048),
 * plus the five tabs F10 added.
 *
 * **Panels are split between two phases**, which is the whole reason the
 * registry is one line per tab: F09 owns the four on the work side, F10 owns
 * everything from Advanced down.
 *
 * **F10 added five lines here**, which is the one shared file that phase touched
 * and the registry's own rule for doing it (contract rule 2 in
 * `tab-registry.ts`). The reference's `SVC_NAV` stops at Advanced because the
 * prototype had no backend behind rollbacks, previews, schedules, volume backups
 * or patches; all five have controllers, and putting them inside Advanced would
 * have made one tab out of six screens — the longest of which holds a file
 * browser and an editor.
 *
 * They sit **below the rule** with Advanced, because that is what `ruleAbove`
 * marks: the six above it (Health and Traces
 * included) are what you do with an Application, and these six are how it is
 * set up. Only the first of the group carries the rule.
 *
 * **An AI model's tabs differ**: Model sits second, after Overview, and
 * Domains, Previews and Patches are hidden — its runtime is reached through the
 * gateway and never a Domain, and nothing about it is built from a branch.
 *
 * **Nor does an Application whose source has no branch**: a Docker
 * image has no Previews and no Patches, and uploaded files have no Previews.
 * Each `absentBecause` says why, which is what a visit to the URL reads.
 */
export const APPLICATION_TABS: readonly TabEntry[] = [
  {
    slug: "",
    label: "Overview",
    icon: "gauge",
    panel: panel(() => import("@/features/application/panels/overview")),
  },
  {
    slug: "model",
    label: "Model",
    icon: "cpu",
    absentBecause: notAModel,
    panel: panel(() => import("@/features/application/panels/model")),
  },
  {
    slug: "deployments",
    label: "Deployments",
    icon: "rocket",
    panel: panel(() => import("@/features/application/panels/deployments")),
  },
  // The Runtime log: a cloud Service's read from the cloud's log store, a
  // Server's or the platform host's followed live from its Swarm service.
  // Absent for a Cron service off a Cloud account and for a role without
  // service:read.
  {
    slug: "logs",
    label: "Logs",
    icon: "term",
    absentBecause: noLogs,
    panel: panel(() => import("@/features/application/panels/logs")),
  },
  // `sh` in one of its running containers, beside Logs and Variables.
  // Absent in a Cloud account and for a role without service:update.
  {
    slug: "shell",
    label: "Shell",
    icon: "term",
    absentBecause: noShell("Application"),
    panel: panel(() => import("@/features/application/panels/shell")),
  },
  {
    slug: "variables",
    label: "Variables",
    icon: "hash",
    panel: panel(() => import("@/features/application/panels/variables")),
  },
  {
    slug: "domains",
    absentBecause: noDomains,
    label: "Domains",
    icon: "globe",
    panel: panel(() => import("@/features/application/panels/domains")),
  },
  // After Domains on every Service kind, and above the
  // rule — it is a reading of how the Application is doing, not its set-up.
  {
    slug: "health",
    label: "Health",
    icon: "activity",
    panel: panel(() => import("@/features/application/panels/health")),
  },
  // After Health, still above the rule — what the Application did,
  // request by request, read from its own Trace store.
  {
    slug: "traces",
    label: "Traces",
    icon: "route",
    panel: panel(() => import("@/features/application/panels/traces")),
  },
  // After Traces, still above the rule — the requests its Server's
  // Traefik logged for it. A Database has no such tab, nor has an
  // AI model, which takes no Domain.
  {
    slug: "requests",
    label: "Requests",
    icon: "globe",
    absentBecause: noRequests,
    panel: panel(() => import("@/features/application/panels/requests")),
  },
  {
    slug: "advanced",
    label: "Advanced",
    icon: "sliders",
    ruleAbove: true,
    panel: panel(() => import("@/features/application/panels/advanced")),
  },
  {
    slug: "rollbacks",
    label: "Rollbacks",
    icon: "back",
    panel: panel(() => import("@/features/application/panels/rollbacks")),
  },
  {
    slug: "previews",
    absentBecause: noPreviews,
    label: "Previews",
    icon: "branch",
    panel: panel(() => import("@/features/application/panels/previews")),
  },
  {
    slug: "schedules",
    label: "Schedules",
    icon: "clock",
    panel: panel(() => import("@/features/application/panels/schedules")),
  },
  {
    slug: "volume-backups",
    label: "Volume backups",
    icon: "db",
    panel: panel(() => import("@/features/application/panels/volume-backups")),
  },
  {
    slug: "patches",
    absentBecause: noPatches,
    label: "Patches",
    icon: "pencil",
    panel: panel(() => import("@/features/application/panels/patches")),
  },
];
