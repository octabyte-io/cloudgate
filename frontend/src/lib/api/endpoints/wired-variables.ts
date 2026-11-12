import { api } from "../client";

/** The Service types whose variables can be wired (ADR-0031). */
export const LINKING_TYPES = [
  "application",
  "postgres",
  "mysql",
  "redis",
] as const;

export type LinkingType = (typeof LINKING_TYPES)[number];

export function isLinkingType(serviceType: string): serviceType is LinkingType {
  return (LINKING_TYPES as readonly string[]).includes(serviceType);
}

/** One wired variable: a name and where it comes from, never a value. */
export interface WiredVariable {
  name: string;
  /** The source Service's Config name. */
  source: string;
  /** Which of the source's Outputs fills it in at deploy. */
  output: string;
}

/** A Service the picker offers, and the Outputs its kind hands out there. */
export interface LinkSource {
  configName: string;
  kind: string;
  outputs: string[];
}

/** `GET /services/:type/:id/links`. */
export interface WiredVariablesView {
  serviceType: LinkingType;
  serviceId: string;
  configName: string;
  /**
   * Where the Project's config is kept: the console saves a link into a
   * Cloudgate-kept one; a repository-kept one's file sets them; a
   * Project with none has no links.
   */
  keptIn: "cloudgate" | "repository" | null;
  /** Whether a console Save may set links here. */
  editable: boolean;
  links: WiredVariable[];
  /**
   * When a linked Output changed outside a plan: the Service reads
   * "deploy to pick up the new value" until it deploys.
   */
  wiredChangedAt: string | null;
  /** The sources a plan would accept, only those. Empty unless `editable`. */
  sources: LinkSource[];
}

export const wiredVariablesApi = {
  /** `service: read`. */
  find: (serviceType: LinkingType, serviceId: string) =>
    api.get<WiredVariablesView>(`/services/${serviceType}/${serviceId}/links`),

  /**
   * Sets the whole set of links as a console Save (`service: update`). A name
   * that held a typed value loses it. `PROJECT_CONFIG_REPOSITORY_KEPT` on a
   * repository-kept config, `LINK_REFUSED` for a link its plan refuses (409).
   */
  save: (
    serviceType: LinkingType,
    serviceId: string,
    links: readonly WiredVariable[],
  ) =>
    api.put<WiredVariablesView>(`/services/${serviceType}/${serviceId}/links`, {
      links,
    }),
};
