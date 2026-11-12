import { api } from "../client";

import type { ApplicationStatus } from "./applications";
import type { TeardownReport } from "./teardown";

/**
 * `preview-deployments.controller.ts` — one isolated environment per open pull
 * request, carved out of the Application's preview wildcard.
 *
 * The **row** is complete: the PR it belongs to, the branch it builds, the
 * service name it runs under and the host it answers on. The **settings** live
 * on the Application, and the four that carry weight have landed
 * `previewLimit`
 * caps how many previews a repository can open, and `previewEnv` /
 * `previewBuildArgs` keep a preview build off production's variables. Of the
 * eleven settings, the remaining ones are per-preview TLS settings. Each
 * preview gets a Traefik router of its own once its build converges
 * pointed at
 * `previewPort` and answering HTTP, plus HTTPS with whatever certificate
 * Traefik holds for the host. Which of the two the row *links* is the
 * backend's `url`.
 */

/** The fields every preview has, whatever made it. */
interface PreviewDeploymentBase {
  previewDeploymentId: string;
  /** What the preview builds: the PR's head branch, or the one asked for. */
  branch: string;
  /** The isolated service name this runs under, beside production. */
  appName: string;
  /** The host, carved out of the Application's preview wildcard. */
  domain: string;
  previewStatus: ApplicationStatus;
  createdAt: string;
  applicationId: string;
  /**
   * The link to print for the host: `https://` only where a stored
   * certificate covers it, `http://` otherwise. Derived on every read, so a
   * wildcard uploaded later flips it; the Delete answer does not carry it.
   */
  url: string;
  /** Why `url` is `http://` — present exactly when it is. */
  urlNote?: string;
  /**
   * The newest Deployment this preview's builds wrote, which its row
   * links into the parent's Deployments tab. `null` until one is.
   */
  latestDeploymentId: string | null;
}

/** A preview a pull request opened, which lives until the pull request closes. */
export interface PullRequestPreview extends PreviewDeploymentBase {
  trigger: "pullRequest";
  pullRequestId: string;
  pullRequestNumber: string;
  pullRequestTitle: string;
  pullRequestURL: string;
  requesterId: null;
  requestedBy: null;
  expiresAt: null;
  expiredAt: null;
  expiryCause: null;
}

/**
 * Where a requester stands in the Organization now: still in it,
 * gone from it (removed, or deleted), or banned — an Agent's Suspend and a
 * person's deactivation write the same ban.
 */
export type RequesterStanding = "member" | "removed" | "suspended";

/**
 * Who asked for a Requested preview, **named by its create audit row**
 * so the name outlives the requester; `name` is `null` only when no
 * such row exists.
 */
export interface RequestedBy {
  id: string | null;
  name: string | null;
  standing: RequesterStanding;
}

/**
 * A preview a caller asked for (ADR-0026) — usually an Agent — which has
 * no pull request and goes at `expiresAt`. The backend holds the two shapes
 * apart with a check constraint, so neither half of this union is optimistic.
 */
export interface RequestedPreview extends PreviewDeploymentBase {
  trigger: "requested";
  pullRequestId: null;
  pullRequestNumber: null;
  pullRequestTitle: null;
  pullRequestURL: null;
  /** Who asked; `null` once that user is gone. The name is on the audit row. */
  requesterId: string | null;
  /** Who asked, as the create audit row names them. */
  requestedBy: RequestedBy | null;
  expiresAt: string;
  /**
   * When it expired, by its clock or by a delete — the row stays,
   * *expired, teardown pending*, until its running copy is gone, then the
   * read answers 404. `null` while it is live.
   */
  expiredAt: string | null;
  expiryCause: "expiry" | "delete" | null;
}

/** A preview as the list and get routes answer it: either trigger. */
export type PreviewDeployment = PullRequestPreview | RequestedPreview;

/** What a delete answers: the row as stored, without the read-only facts. */
export type PreviewDeleted = Omit<
  PreviewDeployment,
  "url" | "urlNote" | "requestedBy" | "latestDeploymentId"
> &
  TeardownReport;

/** Whether a pull request made this preview. */
export const isPullRequestPreview = (
  preview: PreviewDeployment,
): preview is PullRequestPreview => preview.trigger === "pullRequest";

export const previewDeploymentsApi = {
  listByApplication: (applicationId: string) =>
    api.get<PreviewDeployment[]>(
      `/applications/${applicationId}/preview-deployments`,
    ),

  findOne: (previewDeploymentId: string) =>
    api.get<PreviewDeployment>(`/preview-deployments/${previewDeploymentId}`),

  /**
   * Sets a Requested preview's expiry to now plus `ttlMinutes` — a new
   * window, not time added to what was left. Refused over the
   * instance maximum, and on an expired preview.
   */
  extend: (previewDeploymentId: string, ttlMinutes: number) =>
    api.post<Omit<RequestedPreview, "requestedBy" | "latestDeploymentId">>(
      `/preview-deployments/${previewDeploymentId}/extend`,
      { ttlMinutes },
    ),

  /** Rebuilds the preview from the head of its branch. */
  redeploy: (previewDeploymentId: string) =>
    api.post<unknown>(`/preview-deployments/${previewDeploymentId}/redeploy`),

  /**
   * Tears a pull-request preview down — its service, its router and its host
   * — and carries the preview's own tree if the teardown could not remove it
   * A Requested preview is **expired now** instead: the answer
   * is the expired row at once, and the sweep tears it down within the minute.
   */
  remove: (previewDeploymentId: string) =>
    api.delete<PreviewDeleted>(`/preview-deployments/${previewDeploymentId}`),
};
