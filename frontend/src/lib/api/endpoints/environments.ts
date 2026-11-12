import { api } from "../client";

import type {
  ApplicationStatus,
  CloudLeftover,
  GoogleCloudLeftover,
  ServiceType,
} from "./applications";
import type { CloudAccount } from "./cloud-accounts";
import type { Deployment } from "./deployments";
import type { Domain } from "./domains";
import type { TeardownReport } from "./teardown";

/**
 * `environments.controller.ts`. An Environment always belongs to a Project, so
 * the list route takes `projectId` as a query parameter rather than nesting.
 * Like Projects, the list is row-level filtered for non-privileged roles.
 *
 * **`GET /environments/:id` carries the services deployed in it**
 * — the eight service
 * tables `union all`-ed into one projection, on the read the Environment screen
 * already makes, the way a `GET /projects` row carries its children. The list
 * route does **not**: `listByProject` answers bare `environment` rows, because a
 * Project's Environment list has no place to show eight rosters and the union is
 * eight table scans per Environment.
 *
 * **Two Environment-scoped feeds hang off it**
 * `deployments` and
 * `domains`. Both are keyed by a *service* id everywhere else in the API, so that
 * left a client able to enumerate the services and fan out — one request per
 * service on every open, with a partial-failure state to design for the opens
 * where some of them fail. These two routes are the other answer: **one request
 * per tab**, over the same service → environment join `GET /deployments` writes
 * for the Organization. There is no partial state on either because there is no
 * set of independent requests that can half-fail.
 *
 * They are two routes rather than one carrying both, because they back two tabs
 * opened independently and their rows go stale for different reasons — a
 * Deployment feed while a build runs, a domain list only when a domain is
 * edited.
 */

/** The `environment` row (`environments/environment.schema.ts`). */
export interface Environment {
  environmentId: string;
  name: string;
  /** What this copy is for. Null until someone writes one. */
  description: string | null;
  createdAt: string;
  projectId: string;
  /**
   * This Environment's own environment variables, as one encrypted dotenv blob.
   *
   * **Not layered over the Project's, and not handed to the services deployed
   * here.** Like a Project's, it is an interpolation source: a service reaches
   * one by writing `${{environment.KEY}}` in its own variables.
   */
  env: string;
  /**
   * Where a Service a plan creates here will run
   * and the
   * Server an Application added in the console starts on
   * It decides
   * only where a Service is *created*: each Service keeps its own run Server
   * (`EnvironmentService.serverId`), so changing it moves nothing.
   */
  deployTarget: DeployTarget;
  /**
   * The branch this Environment reads a repository-kept Project config from
   * `null` is
   * the repository's default branch.
   */
  configBranch: string | null;
  /**
   * Its Delete in a Cloud account, while it runs or once it could not finish
   * (ADR-0038); `null` on every other Environment.
   */
  cloudDelete: EnvironmentDelete | null;
}

/** One DNS record as the operator copies it to, or removes it from, their DNS provider. */
export interface DnsRecord {
  name: string;
  type: string;
  value: string;
}

/**
 * Something an Environment's Delete left in AWS, or in Google Cloud
 * with whose
 * it was.
 */
export type EnvironmentLeftover = (CloudLeftover | GoogleCloudLeftover) & {
  /** `Service web`, `Environment network (eu-central-1)`. */
  of: string;
};

/**
 * An Environment's Delete in a Cloud account: `deleting` while its
 * cloud Services' Deletes and its networks' removals run, `incomplete` once
 * something was left in AWS or it did not finish. A clean Delete drops the
 * row.
 */
export interface EnvironmentDelete {
  status: "deleting" | "incomplete";
  retrying: boolean;
  force: boolean;
  left: EnvironmentLeftover[];
  /** What its Domains leave at the DNS provider, which Cloudgate never writes. */
  dnsRecordsLeft: DnsRecord[];
  /** Why the latest run did not finish; `null` when it did. */
  unfinished: string | null;
}

/**
 * An Environment's Deploy target (`environments/deploy-target.ts`): a Server,
 * the platform host, or a Cloud account plus an AWS region.
 */
export type DeployTarget =
  | { kind: "server"; serverId: string }
  | { kind: "platform-host" }
  | { kind: "cloud"; cloudAccountId: string; region: string };

/**
 * What a create or an update of an Environment answers: the row, plus the
 * region check's warnings when a Cloud account was chosen (a VPC quota nearly
 * reached). Empty otherwise.
 */
export type SavedEnvironment = Environment & { warnings: string[] };

/**
 * One service deployed in an Environment, as the Environment read reports it
 * (`environment-services.ts`).
 *
 * Deliberately uniform across all eight kinds: it is a **projection**, not the
 * service row, which is what lets one shape cover an Application, a Compose
 * stack and six engines — and is also why no credential-bearing column can ride
 * along. Enough to list the service and follow it to its own `GET /<kind>/:id`,
 * and nothing more.
 */
export interface EnvironmentService {
  /** Which kind this is, and so which route reads it in full. */
  serviceType: ServiceType;
  /** The service's own primary key — `applicationId`, `postgresId`, … */
  serviceId: string;
  name: string;
  /** The Docker service name. Unique across the instance. */
  appName: string;
  /**
   * The fixed key a Project config uses for this Service: minted from the
   * display name at create and never changed by a rename.
   */
  configName: string;
  description: string | null;
  /** `applicationStatus`, or compose's `composeStatus` — one shared enum. */
  status: ApplicationStatus;
  /** `null` deploys onto the platform's own host. */
  serverId: string | null;
  createdAt: string;
}

/** `GET /environments/:id` — the row plus what is deployed in it. */
export interface EnvironmentDetail extends Environment {
  /** Ordered by name, then kind, then id — a total order, server-side. */
  services: EnvironmentService[];
}

/**
 * The service a feed row belongs to. Always present: both feeds reach their rows
 * *through* a service in the Environment, so there is no "unknown owner" case to
 * render — which is the difference between this and the Organization feed, where
 * a host-level scheduled run belongs to no service at all.
 */
export interface FeedService {
  serviceType: ServiceType;
  serviceId: string;
  name: string;
}

/**
 * One row of `GET /environments/:id/deployments`.
 *
 * `owner` and `service` are **not the same thing**, and the Deployments table
 * shows both for it. A `deployment` row belongs to whatever ran it — an
 * Application, a Compose stack, a cron entry, a volume backup or a database
 * backup — while `service` is the service whose Environment put the row in this
 * feed. A nightly Postgres dump is owned by the backup and served by the
 * Postgres instance.
 */
export interface EnvironmentDeployment extends Deployment {
  owner: {
    type: "application" | "compose" | "schedule" | "volumeBackup" | "backup";
    id: string;
    name: string;
  };
  service: FeedService;
}

/**
 * One row of `GET /environments/:id/domains` — the `domain` row plus which
 * service answers the host. A managed database contributes none: nothing routes
 * to one from outside.
 */
export interface EnvironmentDomain extends Domain {
  service: FeedService;
}

/** Where an Environment network is in its life (ADR-0038). */
export type EnvironmentNetworkStatus =
  | "creating"
  | "ready"
  | "create-failed"
  | "deleting"
  | "delete-incomplete";

/**
 * One row of `GET /environments/:id/networks`: an Environment network
 * in a Cloud account and region, with what it costs while idle — shown even
 * with no Service in it, since it bills until it is removed.
 */
export interface EnvironmentNetwork {
  environmentNetworkId: string;
  cloudAccountId: string;
  cloudAccountName: string;
  /** Its Cloud account's cloud, which says which address below it has. */
  cloud: CloudAccount["cloud"];
  region: string;
  status: EnvironmentNetworkStatus;
  /** An AWS load balancer's address, for a DNS record; `null` until made, and on Google Cloud. */
  albDnsName: string | null;
  /** A Google network's fixed IP, for a Domain's `A` record; `null` until made, and on AWS. */
  ipAddress: string | null;
  vpcId: string | null;
  /** What a removal left behind, in AWS or Google Cloud; empty otherwise. */
  leftovers: (CloudLeftover | GoogleCloudLeftover)[];
  /**
   * While Google holds its subnet after a removal
   * the
   * subnet and network named, and when Cloudgate tries again by itself.
   * `null` otherwise, and always on AWS.
   */
  subnetHold: string | null;
  /** When Cloudgate's own next try at removing it is due; `null` when none is. */
  holdNextTryAt: string | null;
  /** The DNS records its Domains left at the DNS provider, named again when it is removed. */
  dnsRecordsLeft: DnsRecord[];
  /** The figure a plan shows, in its cloud's words: `about $24/month while idle` on AWS. */
  idleCost: string;
  /** The Environment's Services running in it. */
  serviceCount: number;
  /** Its newest run, whose Deployment log tells how it went. */
  lastRun: Deployment | null;
  /**
   * False when Cloudgate cannot read its Infrastructure state: every
   * run on it fails until Rebuild from the cloud.
   */
  stateReadable: boolean;
  createdAt: string;
}

export interface CreateEnvironmentInput {
  name: string;
  description?: string;
  projectId: string;
  env?: string;
  /**
   * Required by `POST /environments` once the organization has a deploy
   * Server; with none, the platform host is taken without asking.
   */
  deployTarget?: DeployTarget;
  /** `null` (or `""`) is the repository's default branch. */
  configBranch?: string | null;
}

/** No `projectId`: an Environment does not move between Projects. */
export type UpdateEnvironmentInput = Partial<
  Omit<CreateEnvironmentInput, "projectId">
>;

export const environmentsApi = {
  listByProject: (projectId: string) =>
    api.get<Environment[]>("/environments", { query: { projectId } }),

  findOne: (environmentId: string) =>
    api.get<EnvironmentDetail>(`/environments/${environmentId}`),

  /** Every Deployment of every service here, newest first. Unpaged, like
   * the per-service lists it gathers. */
  listDeployments: (environmentId: string) =>
    api.get<EnvironmentDeployment[]>(
      `/environments/${environmentId}/deployments`,
    ),

  /** Every host answered by a service here, by host. */
  listDomains: (environmentId: string) =>
    api.get<EnvironmentDomain[]>(`/environments/${environmentId}/domains`),

  /** The Environment's networks in Cloud accounts, each with its idle cost. */
  listNetworks: (environmentId: string) =>
    api.get<EnvironmentNetwork[]>(`/environments/${environmentId}/networks`),

  create: (input: CreateEnvironmentInput) =>
    api.post<SavedEnvironment>("/environments", input),

  update: (environmentId: string, input: UpdateEnvironmentInput) =>
    api.patch<SavedEnvironment>(`/environments/${environmentId}`, input),

  /**
   * Deletes the Environment. In a Cloud account it answers at once,
   * the row `cloudDelete: deleting`, with the DNS records its Domains leave.
   * Otherwise it answers with what it kept, each bucket that holds files
   * among it.
   */
  remove: (environmentId: string) =>
    api.delete<Environment & TeardownReport & { dnsRecordsLeft?: DnsRecord[] }>(
      `/environments/${environmentId}`,
    ),

  /** Retry an incomplete cloud Delete: `environment: delete`. */
  retryCloudDelete: (environmentId: string) =>
    api.post<Environment & { dnsRecordsLeft: DnsRecord[] }>(
      `/environments/${environmentId}/delete/retry`,
    ),

  /** Forget an incomplete cloud Delete: the rows go, the list into the audit log. */
  forgetCloudDelete: (environmentId: string) =>
    api.post<{ environmentId: string; forgotten: EnvironmentLeftover[] }>(
      `/environments/${environmentId}/delete/forget`,
    ),
};
