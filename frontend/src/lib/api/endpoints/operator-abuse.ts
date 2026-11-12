import { api } from "../client";

import type { OperatorNamedOrganization } from "./operator";

/**
 * `operator/operator-abuse.controller.ts` — the Operator page's abuse
 * actions (ADR-0071, #1401). **Hosted only** and Operators only, as every
 * Operator route: 404 on a Self-hosted instance, 403 for anybody else. Each
 * write is recorded in the target Organization's audit log and the Instance
 * organization's.
 */

/** An open abuse report: forwarded, and not closed by an Operator yet. */
export type OperatorAbuseReport = {
  id: string;
  organization: OperatorNamedOrganization;
  /** The report as the owners and admins received it. */
  report: string;
  forwardedAt: string;
  /** 24 hours after it was forwarded. Passing it suspends nothing by itself. */
  deadlineAt: string;
  /** The Operator who forwarded it, by sign-in address; null once gone. */
  forwardedBy: string | null;
};

/** A Bought Server's power-off for abuse, as both sides see it. */
export type OperatorPowerOff = { poweredOffAt: string; reason: string };

export const operatorAbuseApi = {
  /** Every open abuse report, the nearest deadline first. */
  reports: () => api.get<OperatorAbuseReport[]>("/operator/abuse-reports"),

  /**
   * Emails the report to the Organization's owners and admins with a
   * 24-hour deadline, and keeps it open on the Operator page.
   */
  forward: (organizationId: string, report: string) =>
    api.post<OperatorAbuseReport>(
      `/operator/organizations/${organizationId}/abuse-reports`,
      { report },
    ),

  /** Closes an open report, answered or acted on. 409 when already closed. */
  close: (reportId: string) =>
    api.post<unknown>(`/operator/abuse-reports/${reportId}/close`, {}),

  /**
   * Powers the Bought Server's machine off at once; its Server page shows
   * "Powered off by Cloudgate: <reason>". 409 when already off or when it
   * has no running machine, 502 when the provider refuses.
   */
  powerOff: (boughtServerId: string, reason: string) =>
    api.post<OperatorPowerOff>(
      `/operator/bought-servers/${boughtServerId}/power-off`,
      { reason },
    ),

  /** Powers it back on: the only way it comes back on. */
  powerOn: (boughtServerId: string) =>
    api.post<unknown>(
      `/operator/bought-servers/${boughtServerId}/power-on`,
      {},
    ),
};
