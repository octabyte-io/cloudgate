import { api } from "../client";
import type { DeployTarget } from "./environments";
import type { Plan } from "./project-config";

/**
 * `templates.controller.ts` — the **Template catalogue**: `GET /templates` and
 * `GET /templates/tags`. Both take **nothing at all**, so every narrowing the
 * screen offers is client-side.
 *
 * **Only the backend talks to the catalogue.** It reads the instance's
 * `CLOUDGATE_TEMPLATES_URL` (by default the newest `cg-templates` release),
 * keeps the last good copy, and serves each Template's logo out of the file,
 * so every request in this file goes to our own origin.
 *
 * **Off is a coded 503** (`ApiError.isCatalogueNotConfigured`), whose message
 * says why: `CLOUDGATE_TEMPLATES_URL=off`, or an install still setting the old
 * `CLOUDGATE_TEMPLATES_BASE_URL`.
 */

/** Where a Template can run: a Server (or this host), and each cloud. */
export type TemplateRunsOn = "server" | "aws" | "gcp";

/** One Template as the catalogue lists it. */
export interface TemplateSummary {
  /** The folder name: a Config name, never changing. */
  id: string;
  /** The last catalogue commit that changed the template. */
  revision: string;
  name: string;
  description: string;
  /** The app's version, display only; null when the template states none. */
  version: string | null;
  tags: string[];
  links: { website?: string; docs?: string; source?: string };
  /**
   * The logo as a `data:` address, from the catalogue file. Drawn with an
   * `<img>`, where an SVG runs no script.
   */
  logo: string;
  /** Always `server` first, then each cloud that makes every entry. */
  runsOn: TemplateRunsOn[];
}

/** The saved copy the list came from, for the staleness note. */
export interface CatalogueCopy {
  /** When the copy was fetched (ISO): how old it is. */
  fetchedAt: string;
  /** When the address was last checked for a newer copy (ISO). */
  checkedAt: string;
  /** Why the last check kept this copy; null when nothing was wrong. */
  problem: string | null;
}

export interface TemplateCatalogue {
  templates: TemplateSummary[];
  copy: CatalogueCopy;
}

/** One Environment in the setup form's picker. */
export interface SetupEnvironment {
  environmentId: string;
  name: string;
  canTake: boolean;
  /** Why it cannot take the template; null when it can. */
  reason: string | null;
  /**
   * A generated sslip.io host for each compose Domain, by its name, which
   * the form starts from; null where none is generated (a cloud, or a
   * platform host with no public address), and each host is typed.
   */
  hosts: Record<string, string> | null;
  /**
   * In a Cloud Environment, where its compose Domains' typed hosts point
   * (#1379): the Environment network's load balancer, for the DNS records
   * the form shows; `pointsAt` null while that network is not made. Null
   * on a Server or the platform host.
   */
  cloudDomains: { pointsAt: CloudPointTarget | null } | null;
}

/** What a cloud Domain's host points at: a load balancer, or a fixed IP. */
export interface CloudPointTarget {
  dnsName: string;
  kind: "load-balancer" | "cloudfront" | "fixed-ip";
}

/** A compose Domain the setup form asks a host for. */
export interface SetupDomain {
  /** The key of its host in a setup's `hosts`. */
  name: string;
  service: string;
  port: number;
  path: string;
}

/** One value the setup form asks for, with its one check. */
export interface AskedInput {
  name: string;
  label: string;
  description: string | null;
  default: string | null;
  required: boolean;
  secret: boolean;
  format: "email" | "url" | "number" | null;
  pattern: string | null;
}

/**
 * For a new Project (#1376): whether its `production` Environment can take
 * the template on each kind of Deploy target, and why not; `null` when it can.
 */
export interface DeployTargetRefusals {
  server: string | null;
  platformHost: string | null;
  aws: string | null;
  gcp: string | null;
}

/**
 * `GET /templates/:templateId/setup?projectId=`: the setup form's makings.
 * With no `projectId` it is a new Project's form: no Environments, and
 * `deployTargets` instead.
 */
export interface SetupForm {
  templateId: string;
  templateName: string;
  revision: string;
  /** Where the setup name starts: the template's id. */
  setupName: string;
  asked: AskedInput[];
  /** The compose Domains the setup picks a host for. */
  domains: SetupDomain[];
  environments: SetupEnvironment[];
  deployTargets: DeployTargetRefusals;
}

/** Where a setup goes: an existing Project's Environment, or a new Project. */
export type SetupPlace =
  | { projectId: string; environmentId: string }
  | {
      /**
       * A Project with a Cloudgate-kept config and one `production`
       * Environment on `deployTarget`, made on Set up (#1376).
       */
      newProject: { name: string; deployTarget: DeployTarget };
    };

export type TemplateSetupInput = SetupPlace & {
  templateId: string;
  setupName: string;
  /** Asked values, by input name. */
  values: Record<string, string>;
  /** Each compose Domain's host, by its name. */
  hosts?: Record<string, string>;
  /**
   * The get-started wizard's setup (ADR-0073): Cloudgate applies the Plan
   * itself, as the caller, once the target Server is Ready and set up, so
   * nobody presses Apply. Left out, the Plan waits for Apply as always.
   */
  autoApply?: boolean;
};

/** What a setup answers. Every value is reported as present, never shown. */
export interface TemplateSetupResult {
  setupName: string;
  configNames: string[];
  pendingSetup: {
    pendingSetupId: string;
    environmentId: string;
    values: {
      configName: string;
      variable: string;
      made: string;
      hasValue: boolean;
    }[];
  };
  setupRecord: {
    setupRecordId: string;
    /** The Project, a new one's included. */
    projectId: string;
    templateId: string;
    revision: string;
    setupName: string;
    configNames: string[];
  };
  /**
   * The Environment's Plan, which Submit goes to. Null on a repository-kept
   * config, whose next push makes the Plan.
   */
  plan: Plan | null;
  /**
   * On a repository-kept config (#1378), the renamed entries to paste into
   * its file, and where the file is; null otherwise.
   */
  paste: SetupPaste | null;
}

/** A repository-kept config's entries to paste. Cloudgate never writes them. */
export interface SetupPaste {
  /** The entries under `services:`, renamed as the Pending setup holds them. */
  yaml: string;
  /** `owner/repo`. */
  repository: string;
  path: string;
  /** The Environment's Config branch; null for the default branch. */
  branch: string | null;
}

export const templatesApi = {
  /**
   * The Templates this instance offers and the copy they came from. A
   * catalogue that cannot be reached with no saved copy is a 502, or a 504 on
   * the backend's deadline, never an empty list.
   */
  list: () => api.get<TemplateCatalogue>("/templates"),

  /** Every tag on an offered Template, once each. */
  tags: () => api.get<string[]>("/templates/tags"),

  /**
   * The setup form for a Project: the template's asked values, and each
   * Environment with whether it can take the template, and why not. `null`
   * for a new Project's form, which answers by kind of Deploy target.
   */
  setupForm: (templateId: string, projectId: string | null) =>
    api.get<SetupForm>(
      `/templates/${encodeURIComponent(templateId)}/setup${
        projectId === null ? "" : `?projectId=${encodeURIComponent(projectId)}`
      }`,
    ),

  /**
   * Sets a Template up: its Pending setup, its Setup record, and its entries
   * added to the config, which opens the Plan; on a repository-kept config,
   * the entries to paste instead. Never an Agent's (ADR-0023).
   */
  setUp: (input: TemplateSetupInput) =>
    api.post<TemplateSetupResult>("/templates/setup", input),
};
