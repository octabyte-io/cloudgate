import { api } from "../client";
import type { Database } from "./databases";
import { existingOf, type ExistingReach } from "./existing-postgres";

/**
 * An **Existing database** that is a redis (ADR-0033): a redis
 * Service whose place is a node-based ElastiCache replication group with
 * cluster mode off, which the operator already has. Cloudgate looks it up
 * at every plan and never changes it. Its AUTH token is only ever read back
 * as set (`hasAuthToken`, on the row).
 */
export interface ExistingCache {
  /** The replication group's id. */
  identifier: string;
  cloudAccountId: string;
  region: string;
  /** "I made it reachable from this Environment", which Cloudgate cannot check. */
  madeReachable: boolean;
  /** TLS on: `rediss://` and a `ca`; off: `redis://` and none. */
  tls: boolean;
  /** Where the last plan's lookup found it; `null` until one has. */
  address: { host: string; port: number } | null;
  /** The last plan found nothing under its id: "AWS cannot find" it. */
  notFound?: { sentence: string; since: string } | null;
  /**
   * On Google Cloud, once Cloudgate's two endpoints to the Valkey
   * instance are made: whether the operator has registered them on it, and
   * while they wait the exact `--add-endpoints` command. `null` before, and
   * on AWS.
   */
  registration?: ValkeyRegistration | null;
}

/** An existing Valkey's registration of Cloudgate's two endpoints. */
export interface ValkeyRegistration {
  status: "waiting" | "registered";
  /** The backend's "waiting for registration" sentence, `null` once registered. */
  sentence: string | null;
  /** The `gcloud memorystore instances update … --add-endpoints` command, while it waits. */
  command: string | null;
  checkedAt: string | null;
  endpoints: { name: string; address: string }[];
}

/**
 * A Memorystore for Valkey instance's name on Google Cloud,
 * `project/region/instance`.
 */
export const VALKEY_INSTANCE_NAME =
  /^(?:[a-z][a-z0-9.-]*[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z]+-[a-z]+[0-9]+\/[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether an existing cache is a Valkey instance on Google Cloud, named `project/region/instance`. */
export function isGoogleCache(
  existing: Pick<ExistingCache, "identifier">,
): boolean {
  return existing.identifier.includes("/");
}

/** A redis's existing-cache place, or `null` for any other database. */
export function existingCacheOf(row: Database): ExistingCache | null {
  if (row.kind !== "redis") return null;
  return (
    (row as Database & { existing?: ExistingCache | null }).existing ?? null
  );
}

/**
 * Whether a database is an Existing one of either kind, and
 * what it is: Cloudgate runs nothing for it, so its lifecycle is its own.
 */
export function existingPlaceOf(row: Database): { identifier: string } | null {
  return existingOf(row) ?? existingCacheOf(row);
}

/** Whether a redis row's AUTH token is set; never the token. */
export function hasAuthToken(row: Database): boolean {
  return (row as Database & { hasAuthToken?: boolean }).hasAuthToken === true;
}

/** What the "Use an existing database" form sends for a redis. */
export interface UseExistingCacheInput {
  environmentId: string;
  configName: string;
  identifier: string;
  /** Empty: the cache has no AUTH token. */
  authToken: string;
  tls: boolean;
  madeReachable: boolean;
}

/** An edit on its page; an empty `authToken` clears the token. */
export type UpdateExistingCacheInput = Partial<
  Omit<UseExistingCacheInput, "environmentId" | "configName">
>;

export const existingRedisApi = {
  /** `service: ['create']`; the Project config does not change. */
  create: (input: UseExistingCacheInput) =>
    api.post<{ redisId: string }>(`/redis/existing`, input),
  /** `service: ['update']`. */
  update: (redisId: string, input: UpdateExistingCacheInput) =>
    api.patch<unknown>(`/redis/${redisId}/existing`, input),
  /**
   * A switch the next plan makes, `service: ['update']`: to an
   * existing cache with what "Use an existing cache" takes, or to one
   * Cloudgate makes; and its cancel.
   */
  switchToExisting: (
    redisId: string,
    input: Omit<UseExistingCacheInput, "environmentId" | "configName">,
  ) => api.post<unknown>(`/redis/${redisId}/switch/to-existing`, input),
  switchToMade: (redisId: string) =>
    api.post<unknown>(`/redis/${redisId}/switch/to-made`, {}),
  cancelSwitch: (redisId: string) =>
    api.delete<unknown>(`/redis/${redisId}/switch`),
  reach: (environmentId: string) =>
    api.get<ExistingReach>(
      `/redis/existing/reach?environmentId=${encodeURIComponent(environmentId)}`,
    ),
};
