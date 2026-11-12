import { api } from "../client";
import type { Database } from "./databases";

/**
 * The kinds RDS makes, which take an Existing database by RDS identifier
 * and login: a postgres and a mysql.
 */
export type RdsKind = "postgres" | "mysql";

/** Whether a database kind is one RDS makes. */
export function isRdsKind(kind: string): kind is RdsKind {
  return kind === "postgres" || kind === "mysql";
}

/**
 * An **Existing database** (ADR-0033): a postgres or mysql Service whose place
 * is an RDS instance the operator already has. Cloudgate looks it up at
 * every plan and never changes it. Its login is the apps' own, typed by the
 * operator and only ever read back as set (`hasDatabasePassword`).
 */
export interface ExistingDatabase {
  identifier: string;
  cloudAccountId: string;
  region: string;
  /** "I made it reachable from this Environment", which Cloudgate cannot check. */
  madeReachable: boolean;
  /** Where the last plan's lookup found it; `null` until one has. */
  address: { host: string; port: number } | null;
  hasDatabasePassword: boolean;
  /**
   * The last plan found nothing under its identifier: "AWS cannot
   * find acme-prod", and since when. `null` while it is found.
   */
  notFound: { sentence: string; since: string } | null;
  /**
   * Cloudgate's own endpoint to it, on Google Cloud: its acceptance
   * as last read, and the backend's sentence while it is not accepted.
   * `null` until one is made, and on AWS.
   */
  endpoint: {
    status: string;
    checkedAt: string | null;
    sentence: string | null;
  } | null;
}

/** A postgres's or a mysql's existing-database place, or `null` for any other database. */
export function existingOf(row: Database): ExistingDatabase | null {
  if (!isRdsKind(row.kind)) return null;
  return (
    (row as Database & { existing?: ExistingDatabase | null }).existing ?? null
  );
}

/**
 * A switch between a Cloudgate-made and an existing database the next plan
 * makes: which way, the identifier it goes to, and what its Apply
 * does. Never the login.
 */
export interface DatabaseSwitch {
  to: "existing" | "made";
  identifier: string | null;
  sentence: string;
}

/** A postgres's, a mysql's or a redis's pending switch, or `null`. */
export function switchOf(row: Database): DatabaseSwitch | null {
  if (!isRdsKind(row.kind) && row.kind !== "redis") return null;
  return (row as Database & { switch?: DatabaseSwitch | null }).switch ?? null;
}

/** What the "Use an existing database" form sends. */
export interface UseExistingInput {
  environmentId: string;
  configName: string;
  identifier: string;
  databaseUser: string;
  databasePassword: string;
  databaseName: string;
  madeReachable: boolean;
}

/** An edit on its page: any of the login, the identifier or the tick. */
export type UpdateExistingInput = Partial<
  Omit<UseExistingInput, "environmentId" | "configName">
>;

/**
 * Where this Environment's Services reach a database from: what the
 * operator lets into the database's security group, which Cloudgate never
 * changes.
 */
export interface ExistingReach {
  cloudAccountId: string;
  cloudAccountName: string;
  region: string;
  vpcId: string | null;
  serviceSubnets: string[];
  port: number;
  securityGroups: { configName: string; groupName: string }[];
  /**
   * On Google Cloud, where nothing is let in by hand: the project
   * Cloudgate's endpoint is made in, which the instance must allow, and the
   * read grant an instance in another project needs, `<instance-project>`
   * standing for its project. `null` on AWS.
   */
  google: {
    projectId: string;
    serviceAccount: string;
    readGrant: string;
  } | null;
}

/** What an Existing database's Delete answers beside the row. */
export interface LeftAsItWas {
  identifier: string;
  message: string;
}

/** An RDS kind's Existing database routes: `/postgres/...` or `/mysql/...`. */
export const existingRdsApi = (kind: RdsKind) => ({
  /** `service: ['create']`; the Project config does not change. */
  create: (input: UseExistingInput) =>
    api.post<unknown>(`/${kind}/existing`, input),
  /** `service: ['update']`. */
  update: (databaseId: string, input: UpdateExistingInput) =>
    api.patch<unknown>(`/${kind}/${databaseId}/existing`, input),
  /**
   * A switch the next plan makes, `service: ['update']`: to an
   * existing database with what "Use an existing database" takes, or to one
   * Cloudgate makes; and its cancel.
   */
  switchToExisting: (
    databaseId: string,
    input: Omit<UseExistingInput, "environmentId" | "configName">,
  ) => api.post<unknown>(`/${kind}/${databaseId}/switch/to-existing`, input),
  switchToMade: (databaseId: string) =>
    api.post<unknown>(`/${kind}/${databaseId}/switch/to-made`, {}),
  cancelSwitch: (databaseId: string) =>
    api.delete<unknown>(`/${kind}/${databaseId}/switch`),
  reach: (environmentId: string) =>
    api.get<ExistingReach>(
      `/${kind}/existing/reach?environmentId=${encodeURIComponent(environmentId)}`,
    ),
});
