import { api } from "../client";

import type { Plan } from "./project-config";

/**
 * What Cloudgate made in a Cloud account, read from an Infrastructure state
 * (ADR-0036
 * item 3) — never the state itself, which no route hands out. Each resource
 * is its type, AWS id, region and tags only, never a setting's value.
 */
export interface CloudResource {
  /** The OpenTofu type: `aws_ecs_service`, `aws_iam_role`. */
  type: string;
  awsId: string;
  /** Its region, or `global` for IAM. */
  region: string;
  tags: Record<string, string>;
  /**
   * False for what a tag search cannot find — IAM, what carries no tag of
   * Cloudgate's, the network cards AWS made — so Recovery by tag could not
   * take it back if its state were lost.
   */
  findableByTag: boolean;
}

/**
 * One resource of a Google state
 * its type,
 * Google name, region and labels only, never a setting's value.
 */
export interface GoogleCloudResource {
  /** The OpenTofu type: `google_cloud_run_v2_service`, `google_compute_network`. */
  type: string;
  /** The fixed name Cloudgate gave it, or Google's id for a kind with no name. */
  googleName: string;
  /** Its region, or `global`. */
  region: string;
  labels: Record<string, string>;
  /**
   * Whether it carries Cloudgate's state label. Networks, subnets and most
   * compute kinds take no labels: they are not findable by mark, and a plan
   * finds them again by their fixed name.
   */
  labelled: boolean;
}

/** `GET /applications/:id/cloud-resources` and a network's `…/resources`. */
export interface CloudResourceList {
  /** Which cloud the state is in, so which resources it lists; absent from an older API, which meant AWS. */
  cloud?: "aws" | "gcp";
  /** `null` before the first apply made the state. */
  stateId: string | null;
  /** False when Cloudgate cannot read the state: Rebuild from the cloud is offered. */
  readable: boolean;
  /** Why the state could not be listed, naming it. */
  failure: string | null;
  resources: CloudResource[] | GoogleCloudResource[];
  /** Why the network cards AWS made could not be looked up, when they could not; `null` on Google. */
  networkCardsUnread: string | null;
}

export const cloudResourcesApi = {
  /** `service: read`. */
  ofService: (applicationId: string) =>
    api.get<CloudResourceList>(
      `/applications/${applicationId}/cloud-resources`,
    ),

  /** `environment: read`. */
  ofNetwork: (environmentId: string, environmentNetworkId: string) =>
    api.get<CloudResourceList>(
      `/environments/${environmentId}/networks/${environmentNetworkId}/resources`,
    ),

  /**
   * Rebuild from the cloud (`service: update`), confirmed by the Service's
   * name: the unreadable state is discarded and a plan that adopts by tag
   * (on Google, by name) is answered.
   */
  rebuildService: (applicationId: string, confirmName: string) =>
    api.post<Plan>(`/applications/${applicationId}/state/rebuild`, {
      confirmName,
    }),

  /** Rebuild a network's state (`environment: update`), confirmed by the Environment's name. */
  rebuildNetwork: (
    environmentId: string,
    environmentNetworkId: string,
    confirmName: string,
  ) =>
    api.post<Plan>(
      `/environments/${environmentId}/networks/${environmentNetworkId}/state/rebuild`,
      { confirmName },
    ),
};
