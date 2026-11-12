import { api } from "../client";
import type { Plan } from "./project-config";

/**
 * `pending-setups.controller.ts` — an Environment's **Pending setups**: what
 * a Template setup chose, waiting encrypted on its Environment for the Apply
 * that creates its parts (ADR-0065). Listed on `environment: ['read']` and
 * cancelled on `environment: ['update']`.
 *
 * **No value ever comes back**, asked or generated: each is how it is made
 * and whether it is present (ADR-0019).
 */

/** One value a Pending setup holds, as present only. */
export interface PendingSetupValue {
  configName: string;
  variable: string;
  /** How it is made: `asked`, `generated (base64, 32 bytes)`, `fixed`. */
  made: string;
  hasValue: boolean;
}

export interface PendingSetup {
  pendingSetupId: string;
  environmentId: string;
  templateId: string;
  templateName: string;
  revision: string;
  setupName: string;
  /** The Config names it has not created yet. */
  configNames: string[];
  createdAt: string;
  /** When the 30-day sweep drops it, unless an Apply uses it up first. */
  expiresAt: string;
  values: PendingSetupValue[];
  /**
   * Where the Apply Cloudgate makes for a get-started wizard's setup stands
   * (ADR-0073); null for every other setup, whose plan waits for Apply.
   */
  autoApply: AutoApplyView | null;
}

/**
 * A get-started wizard's setup on its way to the Apply Cloudgate makes for
 * it (ADR-0073). A setup whose Apply created every part is gone from the
 * list, so `applied` is only seen on one an Apply left parts of.
 */
export interface AutoApplyView {
  status: "waiting" | "applying" | "applied" | "refused";
  /** While `waiting`: what for, in words to show as they are. */
  waitingFor: string | null;
  /** While `refused`: why Cloudgate gave the Apply up. */
  message: string | null;
}

/** The note a setup the 30-day sweep dropped leaves on its Environment. */
export interface ExpiredSetup {
  expiredSetupId: string;
  templateId: string;
  templateName: string;
  setupName: string;
  configNames: string[];
  setUpAt: string;
  expiredAt: string;
}

/** `GET /environments/:environmentId/pending-setups`. */
export interface PendingSetupList {
  pendingSetups: PendingSetup[];
  /** Newest first; each kept 30 days. */
  expired: ExpiredSetup[];
}

/** What a cancel answers. */
export interface CancelledPendingSetup {
  pendingSetup: PendingSetup;
  /**
   * The Environment's plan, made again when its open plan was to create the
   * cancelled parts; null otherwise.
   */
  plan: Plan | null;
}

export const pendingSetupsApi = {
  list: (environmentId: string) =>
    api.get<PendingSetupList>(
      `/environments/${encodeURIComponent(environmentId)}/pending-setups`,
    ),
  remove: (environmentId: string, pendingSetupId: string) =>
    api.delete<CancelledPendingSetup>(
      `/environments/${encodeURIComponent(environmentId)}/pending-setups/${encodeURIComponent(pendingSetupId)}`,
    ),
};
