import { describe, expect, it } from "vitest";

import { scopeNav, type NavEntry } from "@/components/shell/nav";
import type { ScopeRoute } from "@/components/shell/scope";

import {
  absentReason,
  scopeTabEntries,
  tabEntry,
  visibleTabEntries,
} from "../tab-registry";

/**
 * Which tabs an Application has depends on what it is: an **AI model**
 * has a Model tab second, after Overview, and no Domains, Previews or Patches —
 * its runtime is reached through the gateway, never a Domain, and nothing about
 * it is built from a branch. A plain Application's tabs are exactly what they
 * were before the predicate existed.
 *
 * The 404 half stays static (`undeclared-tab.test.ts`): `model` is a declared
 * slug for every Application, so the route never needs the row to decide.
 */

const AI_MODEL = {
  aiModel: {
    runtime: "ollama",
    model: "smollm2:135m",
    imageTag: "0.12.6",
    pin: "0.12.6",
    offPin: false,
  },
} as const;
const PLAIN = { aiModel: null };

const PLAIN_TABS = [
  "Overview",
  "Deployments",
  "Logs",
  "Shell",
  "Variables",
  "Domains",
  "Health",
  "Traces",
  "Requests",
  "Advanced",
  "Rollbacks",
  "Previews",
  "Schedules",
  "Volume backups",
  "Patches",
];

const labels = (subject: Parameters<typeof visibleTabEntries>[1]) =>
  visibleTabEntries("application", subject).map((entry) => entry.label);

const SCOPE: ScopeRoute = {
  kind: "application",
  id: "app_1",
  variant: null,
  tab: "",
};

const railLabels = (nav: NavEntry[]) =>
  nav.flatMap((entry) => (entry.kind === "item" ? [entry.label] : []));

describe("an Application's tabs", () => {
  it("puts Model second on an AI model, after Overview", () => {
    expect(labels(AI_MODEL).slice(0, 2)).toEqual(["Overview", "Model"]);
  });

  it("hides Domains, Requests, Previews and Patches on an AI model", () => {
    const hiddenOnModel = ["Domains", "Requests", "Previews", "Patches"];
    const shown = labels(AI_MODEL);
    for (const hidden of hiddenOnModel) {
      expect(shown).not.toContain(hidden);
    }
    expect(shown).toEqual([
      "Overview",
      "Model",
      ...PLAIN_TABS.filter(
        (label) => !["Overview", ...hiddenOnModel].includes(label),
      ),
    ]);
  });

  it("leaves a plain Application's tabs as they were", () => {
    expect(labels(PLAIN)).toEqual(PLAIN_TABS);
  });

  it("reads a row still loading as a plain Application", () => {
    expect(labels(undefined)).toEqual(PLAIN_TABS);
  });

  it("keeps model a declared slug, so the route never needs the row to answer", () => {
    expect(scopeTabEntries("application").map((entry) => entry.slug)).toContain(
      "model",
    );
  });

  // A Service in a Cloud account has a Runtime log tab after Deployments,
  // and so does one on a Server or the platform host (#1341).
  it("gives a cloud Service a Logs tab after Deployments", () => {
    const cloud = {
      aiModel: null,
      cloudPlace: {
        cloudAccountId: "ca_1",
        cloudAccountName: "Production AWS",
        region: "eu-central-1",
      },
    };
    // And no Shell: there is no container of it to open one in.
    expect(labels(cloud)).toEqual(
      PLAIN_TABS.filter((label) => label !== "Shell"),
    );
  });

  it("gives an Application on a Server or the platform host a Logs tab after Deployments", () => {
    const shown = labels({ aiModel: null, cloudPlace: null });
    expect(shown.indexOf("Logs")).toBe(shown.indexOf("Deployments") + 1);
  });

  it("gives an AI model a Logs tab too, after Deployments", () => {
    const shown = labels(AI_MODEL);
    expect(shown.indexOf("Logs")).toBe(shown.indexOf("Deployments") + 1);
  });

  it("draws the rail from the same predicate", () => {
    expect(railLabels(scopeNav(SCOPE, AI_MODEL)).slice(0, 3)).toEqual([
      "Overview",
      "Model",
      "Deployments",
    ]);
    expect(railLabels(scopeNav(SCOPE, PLAIN))).toEqual(PLAIN_TABS);
  });
});

/**
 * A source with no branch has nothing to preview, and an image that is
 * never built has nothing to patch — and a visit to a tab a row lacks is told
 * that tab's own reason, not the AI model's.
 */
describe("an Application's tabs by source", () => {
  it("hides Previews and Patches on a Docker image, and keeps the rest", () => {
    expect(labels({ aiModel: null, sourceType: "docker" })).toEqual(
      PLAIN_TABS.filter((label) => !["Previews", "Patches"].includes(label)),
    );
  });

  it("hides Previews on uploaded files and keeps Patches, which their build applies", () => {
    expect(labels({ aiModel: null, sourceType: "drop" })).toEqual(
      PLAIN_TABS.filter((label) => label !== "Previews"),
    );
  });

  it("keeps both on a repository source, the default a fresh row claims", () => {
    expect(labels({ aiModel: null, sourceType: "github" })).toEqual(PLAIN_TABS);
  });

  const reason = (slug: string, subject: Parameters<typeof absentReason>[1]) =>
    absentReason(tabEntry("application", slug)!, subject);

  it("explains a Cron service's missing Logs by its runs, which are each their own job", () => {
    const cron = { aiModel: null, cloudPlace: null, configKind: "cron" };
    expect(labels(cron)).not.toContain("Logs");
    const why = reason("logs", cron);
    expect(why).toMatch(/Cron service/);
    expect(why).toMatch(/Deployments tab/);
    expect(why).not.toMatch(/AI model/);
    // No longer says a Server Service reads its output "elsewhere".
    expect(reason("logs", { aiModel: null, cloudPlace: null })).toBeNull();
  });

  // A cron in a Cloud account runs as the cloud's scheduled job, whose output
  // the cloud's log store keeps, so it keeps the Runtime log it always had.
  it("keeps a Cloud account cron's Logs tab, read from the cloud's log store", () => {
    const cloudCron = {
      aiModel: null,
      configKind: "cron",
      cloudPlace: {
        cloudAccountId: "ca_1",
        cloudAccountName: "Production AWS",
        region: "eu-central-1",
      },
    };
    expect(labels(cloudCron)).toContain("Logs");
    expect(reason("logs", cloudCron)).toBeNull();
  });

  it("hides Logs from a role without service:read, saying it is the role", () => {
    const refused = { aiModel: null, cloudPlace: null, logsAllowed: false };
    expect(labels(refused)).not.toContain("Logs");
    expect(reason("logs", refused)).toMatch(/Your role/);
    expect(labels({ aiModel: null, cloudPlace: null })).toContain("Logs");
  });

  it("explains a Docker image's Previews and Patches by its source", () => {
    const subject = { aiModel: null, sourceType: "docker" };
    expect(reason("previews", subject)).toMatch(/Docker image/);
    expect(reason("patches", subject)).toMatch(/never built/);
  });

  it("gives every tab a row lacks a sentence of its own", () => {
    const subjects = [
      { aiModel: null, cloudPlace: null, sourceType: "github" },
      { aiModel: null, cloudPlace: null, sourceType: "docker" },
      { aiModel: null, cloudPlace: null, sourceType: "drop" },
      { aiModel: null, cloudPlace: null, configKind: "cron" },
      { aiModel: null, cloudPlace: null, logsAllowed: false },
      { ...AI_MODEL, cloudPlace: null, sourceType: "docker" },
    ];
    for (const subject of subjects) {
      const shown = new Set(labels(subject));
      const missing = scopeTabEntries("application").filter(
        (entry) => !shown.has(entry.label),
      );
      for (const entry of missing) {
        const why = absentReason(entry, subject);
        expect(why).toBeTruthy();
        // Only an AI model is told about AI models — but for the one tab
        // that is an AI model's alone.
        if (subject.aiModel === null && entry.slug !== "model") {
          expect(why).not.toMatch(/AI model/);
        }
      }
    }
  });
});

/**
 * The Shell tab opens `sh` in one of the Service's own running
 * containers. It is absent for a Service in a Cloud account, which runs none,
 * and for a role known not to hold `service:update`, which the socket would
 * refuse — and a visit to its URL says which.
 */
describe("an Application's Shell tab", () => {
  const reason = (subject: Parameters<typeof absentReason>[1]) =>
    absentReason(tabEntry("application", "shell")!, subject);

  it("sits beside Logs and Variables on a Server's Application", () => {
    const shown = labels({ aiModel: null, cloudPlace: null });
    expect(shown.indexOf("Shell")).toBe(shown.indexOf("Logs") + 1);
    expect(shown.indexOf("Shell")).toBe(shown.indexOf("Variables") - 1);
  });

  it("is offered while the role is still being read, as every gate here fails open", () => {
    expect(labels({ aiModel: null, cloudPlace: null })).toContain("Shell");
    expect(labels(undefined)).toContain("Shell");
  });

  it("is absent in a Cloud account, saying there is no container to open a shell in", () => {
    const cloud = {
      aiModel: null,
      cloudPlace: {
        cloudAccountId: "ca_1",
        cloudAccountName: "Production AWS",
        region: "eu-central-1",
      },
    };
    expect(labels(cloud)).not.toContain("Shell");
    expect(reason(cloud)).toMatch(/Cloud account/);
    expect(reason(cloud)).toMatch(/no container/);
  });

  it("is absent for a role without service:update, saying it is the role", () => {
    const refused = { aiModel: null, cloudPlace: null, shellAllowed: false };
    expect(labels(refused)).not.toContain("Shell");
    expect(reason(refused)).toMatch(/Your role/);
    expect(reason(refused)).not.toMatch(/Cloud account/);
  });
});

/** The same tab on the other two service scopes. */
describe("a database's and a Compose stack's Shell tab", () => {
  const shown = (kind: "database" | "compose", subject?: object) =>
    visibleTabEntries(kind, subject).map((entry) => entry.label);

  it("is offered on a database on a Server, and on every Compose stack", () => {
    expect(shown("database", { cloudAccountId: null })).toContain("Shell");
    expect(shown("compose", {})).toContain("Shell");
  });

  it("is absent on a database in a Cloud account, with its reason", () => {
    const cloud = { cloudAccountId: "ca_1" };
    expect(shown("database", cloud)).not.toContain("Shell");
    expect(absentReason(tabEntry("database", "shell")!, cloud)).toMatch(
      /Cloud account/,
    );
  });

  it("is absent for a role without service:update on either", () => {
    expect(shown("database", { shellAllowed: false })).not.toContain("Shell");
    expect(shown("compose", { shellAllowed: false })).not.toContain("Shell");
  });
});

/**
 * A Service's Requests tab: an Application and a Compose stack have
 * one, after Traces, a Cloud account Application included (it says where its
 * requests are logged instead). A Database has no Domain and so none, and
 * the Server page has none: a Server's requests are on the Requests page.
 */
describe("the Requests tab", () => {
  const slugs = (kind: "server" | "database" | "compose" | "application") =>
    scopeTabEntries(kind).map((entry) => entry.slug);

  it("is on an Application and a Compose stack, after Traces", () => {
    const compose = visibleTabEntries("compose", {}).map(
      (entry) => entry.label,
    );
    expect(compose[compose.indexOf("Traces") + 1]).toBe("Requests");
    expect(slugs("application")).toContain("requests");
  });

  it("stays on an Application in a Cloud account", () => {
    const cloud = {
      aiModel: null,
      cloudPlace: {
        cloudAccountId: "ca_1",
        cloudAccountName: "Production AWS",
        region: "eu-central-1",
      },
    };
    expect(labels(cloud)).toContain("Requests");
  });

  it("is not a tab of a Database or of a Server", () => {
    expect(slugs("database")).not.toContain("requests");
    expect(slugs("server")).not.toContain("requests");
  });
});
