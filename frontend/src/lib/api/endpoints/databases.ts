import { api } from "../client";

import type {
  ApplicationStatus,
  CloudDelete,
  CloudLeftover,
} from "./applications";
import type { Environment } from "./environments";
import type { Project } from "./projects";
import type { Server } from "./servers";
import type { TeardownReport } from "./teardown";

/**
 * The six managed database engines, which are six controllers with one shape:
 * `postgres.controller.ts`, `mysql`, `mariadb`, `mongo`, `redis`, `libsql`.
 * Every one of them mounts at its own name and exposes the same routes —
 * `GET /:id`, `PATCH /:id`, `PATCH /:id/environment`, `POST /:id/deploy`,
 * `:id/start`, `:id/stop`, `:id/rebuild`, `:id/status`, an external-port route
 * and `DELETE /:id` (`databases/common/database-service.ts` is the shared
 * base).
 *
 * **Two descriptor tables, and the split is deliberate.** This module owns the
 * facts that are about *routes and columns* — which id field an engine's row
 * uses, which columns it carries, and the one route whose spelling differs.
 * `src/features/database/kinds.ts` owns the facts that are about *screens* —
 * the display name, the icon, the version list, the credential set, the
 * connection string. A panel reads the second and never branches on an engine
 * name; this file is what makes that possible.
 *
 * Two things exist here because a database's *URL* has to carry its engine:
 * `GET /:id` is only meaningful if you already know which controller to ask, so
 * `/databases/postgres/<id>` is the route (`scope.ts`), and `DATABASE_KINDS` is
 * the vocabulary both the router and this module read.
 */

export const DATABASE_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
] as const;

export type DatabaseKind = (typeof DATABASE_KINDS)[number];

/** A path segment is a string until something checks it. */
export function isDatabaseKind(value: string): value is DatabaseKind {
  return (DATABASE_KINDS as readonly string[]).includes(value);
}

/**
 * How each engine names itself. Third-party names keep their own spelling
 * (`CONTEXT.md`) — this is PostgreSQL's product name, not our vocabulary.
 */
export const DATABASE_LABEL: Record<DatabaseKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongo: "MongoDB",
  redis: "Redis",
  libsql: "LibSQL",
};

/**
 * Each engine's primary key is named after itself — `postgresId`, `mysqlId`.
 * That is fine in a table and useless in a shell that has to handle all six, so
 * `findOne` normalises it to `databaseId` and keeps `kind` beside it. The raw
 * field stays on the row.
 */
const ID_FIELD = {
  postgres: "postgresId",
  mysql: "mysqlId",
  mariadb: "mariadbId",
  mongo: "mongoId",
  redis: "redisId",
  libsql: "libsqlId",
} as const satisfies Record<DatabaseKind, string>;

type IdField = (typeof ID_FIELD)[DatabaseKind];

/**
 * **The one asymmetry in six otherwise identical controllers.**
 *
 * Five engines publish a single port and mount `POST /:id/external-port`;
 * LibSQL's sqld has three listeners — http, grpc and admin — so its route is
 * `POST /:id/external-ports` and its body carries all three
 * (`LibsqlController.saveExternalPorts`, `saveLibsqlExternalPortsSchema`). It is
 * one word of difference and exactly the kind of thing that becomes an
 * `if (kind === "libsql")` in a component. It lives here instead, and `saveExternalPorts`
 * below is the only code that reads it.
 */
const EXTERNAL_PORT_ROUTE = {
  postgres: "external-port",
  mysql: "external-port",
  mariadb: "external-port",
  mongo: "external-port",
  redis: "external-port",
  libsql: "external-ports",
} as const satisfies Record<DatabaseKind, string>;

// ── Rows ───────────────────────────────────────────────────────────────────

/**
 * What every engine's row holds, whichever engine it is.
 *
 * The connection columns are **not** here: they are where the engines stop
 * being uniform, and `DatabaseRow` is the part the shell can rely on.
 */
export interface DatabaseRow extends Partial<Record<IdField, string>> {
  name: string;
  /** The Docker service name. Immutable, and unique across the instance. */
  appName: string;
  /**
   * The fixed key a Project config uses for this Service: minted from the
   * display name at create and never changed by a rename.
   */
  configName: string;
  description: string | null;
  /** The same five states an Application's column holds — it is the same
   * enum — with `stopped` written by a Stop, here as there. */
  applicationStatus: ApplicationStatus;
  dockerImage: string;
  replicas: number;
  /** Published on the host, or `null` for reachable only inside the network. */
  externalPort: number | null;
  /** The dotenv blob. One encrypted column, exactly like a Project's. */
  env: string | null;
  command: string | null;
  args: string[] | null;
  memoryReservation: string | null;
  memoryLimit: string | null;
  cpuReservation: string | null;
  cpuLimit: string | null;
  createdAt: string;
  environmentId: string;
  /** `null` until the row is deployed onto a Server. */
  serverId: string | null;
  /**
   * When an Output a postgres, mysql or redis links to changed outside a plan
   * "deploy to pick up the new value" until it deploys. Absent on an
   * engine whose variables cannot be wired.
   */
  wiredChangedAt?: string | null;
  /**
   * The Cloud account a postgres on RDS or a redis on ElastiCache runs in
   * absent or `null` on a Server and on the other engines.
   */
  cloudAccountId?: string | null;
  /**
   * A postgres on RDS that Cloudgate stopped: its status line, and
   * Stop's warning while AWS has not started it again. `null` when it is
   * not stopped; absent off RDS.
   */
  rdsStop?: RdsStop | null;
  /**
   * A postgres on Cloud SQL that Cloudgate stopped: "Stopped", with
   * no date, since Google never starts it by itself, and Stop's warning.
   * `null` when it is not stopped; absent off Cloud SQL, so its presence is
   * how the console knows a postgres runs there.
   */
  cloudSqlStop?: CloudSqlStop | null;
  region?: string | null;
  /**
   * Where a cloud database answers, as its last Cloud run saved it:
   * a postgres on RDS (`rdsEndpoint`) or Cloud SQL (`cloudSqlEndpoint`), a
   * redis on ElastiCache (`elasticacheEndpoint`) or Memorystore
   * (`memorystoreEndpoint`). `null` until it is made; absent off its cloud.
   * A `ca` is the instance's own CA, PEM.
   */
  rdsEndpoint?: CloudEndpoint | null;
  cloudSqlEndpoint?: (CloudEndpoint & { ca: string }) | null;
  elasticacheEndpoint?: CloudEndpoint | null;
  memorystoreEndpoint?: (CloudEndpoint & { ca: string }) | null;
  /**
   * Whether a redis's AUTH token is set; never the token. A redis on
   * a cloud answers no `databasePassword`.
   */
  hasAuthToken?: boolean;
  /** Its Delete in that Cloud account, under way or incomplete. */
  cloudDelete?: DatabaseCloudDelete | null;
}

/** Where a cloud database answers inside its Environment network. */
export interface CloudEndpoint {
  host: string;
  port: number;
}

/**
 * The stop of a postgres on RDS: `stopped` until the date AWS starts
 * it again by itself, then `started-by-aws`. The backend's `RdsStopView`.
 */
export interface RdsStop {
  state: "stopped" | "started-by-aws";
  restartsAt: string;
  /** "Stopped, AWS starts it again on <date>" or "Started again by AWS". */
  sentence: string;
  /** "AWS starts it again on <date>, and storage and backups still bill". */
  warning: string | null;
}

/** The stop of a postgres on Cloud SQL. The backend's `CloudSqlStopView`. */
export interface CloudSqlStop {
  state: "stopped";
  /** "Stopped". */
  sentence: string;
  /** "Storage, backups and its private address still cost money. …". */
  warning: string;
}

/**
 * A cloud database's Delete: a cloud Service's, and the final
 * snapshot it keeps — `null` when it was asked to delete the data too.
 */
export interface DatabaseCloudDelete extends Omit<CloudDelete, "left"> {
  /** The report's *Left* list, AWS's: a Cloud SQL Delete lists none yet. */
  left: CloudLeftover[];
  finalSnapshot: string | null;
}

/**
 * `GET /:kind/:id/final-snapshot` — the snapshot a Delete pressed now keeps
 * with about what it costs a month, for the Delete dialog. On Google
 * Cloud it is the final backup.
 */
export interface FinalSnapshotPreview {
  /** Which cloud keeps it: a snapshot on AWS, a backup on Google Cloud. */
  cloud: "aws" | "gcp";
  name: string;
  region: string;
  sizeGb: number;
  monthlyUsd: number;
  /**
   * `keeps snapshot <name>, about $X a month, until you delete it in AWS`,
   * or `keeps backup <name>, …, until you delete it in Google Cloud`.
   */
  sentence: string;
}

/**
 * Every connection column any of the six engines carries, each optional.
 *
 * One widened type rather than six row types and a discriminated union, because
 * the alternative pushes the branch back into the panels: a screen holding
 * `Postgres | Redis | Libsql` has to narrow before it can read `databaseUser`,
 * and narrowing is `switch (kind)`. Which columns are *real* for an engine is
 * the descriptor's job to say (`features/database/kinds.ts`), and a column an
 * engine does not have simply is not in its response.
 *
 * - `databaseName` — Postgres, MySQL, MariaDB. Mongo's root user owns the whole
 *   server and Redis is one keyspace, so neither has one.
 * - `databaseUser` — everything except Redis.
 * - `databasePassword` — all six. It is Redis's entire connection identity.
 * - `databaseRootPassword` — MySQL and MariaDB, which manage the application
 *   user and root as two separate credentials.
 * - `replicaSets` — Mongo. Switches the deploy to a single-node replica set.
 * - `sqldNode` / `sqldPrimaryUrl` / `enableNamespaces` — LibSQL's topology.
 * - `externalGRPCPort` / `externalAdminPort` — LibSQL's other two listeners.
 */
export interface DatabaseConnection {
  databaseName?: string;
  databaseUser?: string;
  databasePassword?: string;
  databaseRootPassword?: string;
  replicaSets?: boolean;
  sqldNode?: "primary" | "replica";
  sqldPrimaryUrl?: string | null;
  enableNamespaces?: boolean;
  externalGRPCPort?: number | null;
  externalAdminPort?: number | null;
}

/**
 * Whether a database's data volume is on its Server: `true`, `false`
 * only when the Server positively says it is not, `null` when it cannot be
 * known — a multi-node swarm, where the volume may be on another node, or a
 * Server that did not answer. The backend's `databaseVolumeLeftBehind`.
 */
export type VolumePresence = boolean | null;

/** `GET /:kind/:id/volume` — the volume, read before a Delete is confirmed. */
export interface DataVolume {
  present: VolumePresence;
}

/** What a database's Delete answers beside the row: the teardown's leftovers
 * and whether the data volume stayed on the Server. */
export type DatabaseDeleteReport = TeardownReport & {
  volumeLeftBehind: VolumePresence;
  /** An Existing database's Delete: what was left as it was, and said so. */
  left?: { identifier: string; message: string };
};

/** A row with its engine and a normalised id, plus the joined parent chain. */
export interface Database extends DatabaseRow, DatabaseConnection {
  kind: DatabaseKind;
  databaseId: string;
  environment: Environment & { project: Project };
  server: Server | null;
}

type DatabaseResponse = DatabaseRow &
  DatabaseConnection & {
    environment: Environment & { project: Project };
    server: Server | null;
  };

// ── Inputs ─────────────────────────────────────────────────────────────────

/**
 * What `POST /:kind` takes.
 *
 * The union of all six create DTOs, with everything an engine does not have
 * simply left out of the body. `databasePassword` is optional in every one of
 * them and generated server-side when omitted (`generateDatabasePassword` — 16
 * lowercase alphanumerics), which is the better default: a password nobody
 * chose is a password nobody reuses.
 */
export interface CreateDatabaseInput {
  name: string;
  environmentId: string;
  appName?: string;
  description?: string;
  dockerImage?: string;
  serverId?: string | null;
  databaseName?: string;
  databaseUser?: string;
  databasePassword?: string;
  databaseRootPassword?: string;
  replicaSets?: boolean;
  sqldNode?: "primary" | "replica";
  sqldPrimaryUrl?: string | null;
  enableNamespaces?: boolean;
}

/**
 * What `PATCH /:kind/:id` takes — every update DTO is `.partial()`.
 *
 * Three columns are deliberately absent from all six: `appName` (immutable — it
 * names the swarm service and the data volume), `environmentId` (a database
 * does not move Environment) and `applicationStatus` (that is the lifecycle's
 * to write, not a form's).
 */
export type UpdateDatabaseInput = Partial<{
  name: string;
  description: string | null;
  dockerImage: string;
  command: string | null;
  args: string[] | null;
  replicas: number;
  memoryReservation: string | null;
  memoryLimit: string | null;
  cpuReservation: string | null;
  cpuLimit: string | null;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
  databaseRootPassword: string;
  replicaSets: boolean;
  sqldNode: "primary" | "replica";
  sqldPrimaryUrl: string | null;
  enableNamespaces: boolean;
}>;

/**
 * What the external-port route takes.
 *
 * Five engines read only `externalPort`; LibSQL reads all three and refuses a
 * body where every one is null. `null` unpublishes a port.
 */
export interface ExternalPortsInput {
  externalPort: number | null;
  externalGRPCPort?: number | null;
  externalAdminPort?: number | null;
}

// ── The API ────────────────────────────────────────────────────────────────

export const databasesApi = {
  /**
   * One database, by engine and id. Both come from the URL, because neither is
   * derivable from the other: the id says nothing about which of the six
   * controllers owns it.
   */
  findOne: async (
    kind: DatabaseKind,
    databaseId: string,
  ): Promise<Database> => {
    const row = await api.get<DatabaseResponse>(`/${kind}/${databaseId}`);
    return {
      ...row,
      kind,
      // The row's own id, and the one we asked for as the fallback: a response
      // is keyed by the id in the request, so echoing it back cannot be wrong.
      databaseId: row[ID_FIELD[kind]] ?? databaseId,
    };
  },

  create: (kind: DatabaseKind, input: CreateDatabaseInput) =>
    api.post<DatabaseResponse>(`/${kind}`, input),

  update: (
    kind: DatabaseKind,
    databaseId: string,
    input: UpdateDatabaseInput,
  ) => api.patch<DatabaseResponse>(`/${kind}/${databaseId}`, input),

  /** The dotenv blob, whole. Its own route, exactly like an Application's. */
  saveEnvironment: (
    kind: DatabaseKind,
    databaseId: string,
    env: string | null,
  ) =>
    api.patch<DatabaseResponse>(`/${kind}/${databaseId}/environment`, { env }),

  /**
   * Pull the image and converge the swarm service onto the row's spec.
   *
   * **A database's deploy writes no `deployment` row and no log file** —
   * `BaseDatabaseService.deployInternal` does the work inline and moves
   * `applicationStatus` running → done. So unlike an Application there is
   * nothing to stream and nothing to list afterwards; what a screen can show is
   * the status, and the container's own log once it is up.
   */
  deploy: (kind: DatabaseKind, databaseId: string) =>
    api.post<unknown>(`/${kind}/${databaseId}/deploy`),

  /** `docker service scale <appName>=1`, then the row goes `done`. */
  start: (kind: DatabaseKind, databaseId: string) =>
    api.post<unknown>(`/${kind}/${databaseId}/start`),

  /** `docker service scale <appName>=0`, then the row goes `stopped` — which
   * `idle`, the column's default, could not say apart from never deployed
   * */
  stop: (kind: DatabaseKind, databaseId: string) =>
    api.post<unknown>(`/${kind}/${databaseId}/stop`),

  /**
   * **Destructive.** Drops the service *and its data volume*, then deploys from
   * scratch — `removeDatabaseVolume` runs `docker volume rm --force` on
   * `<appName>-data`. Everything in the database is gone. Nothing else on these
   * screens does that, which is why it is the one action behind a typed
   * confirmation.
   */
  rebuild: (kind: DatabaseKind, databaseId: string) =>
    api.post<unknown>(`/${kind}/${databaseId}/rebuild`),

  /**
   * Publish or unpublish the engine's port on the host, and converge.
   *
   * The route's spelling comes from `EXTERNAL_PORT_ROUTE` — see the note there.
   * This is the only function in the app that knows LibSQL's is different.
   */
  saveExternalPorts: (
    kind: DatabaseKind,
    databaseId: string,
    input: ExternalPortsInput,
  ) =>
    api.post<unknown>(
      `/${kind}/${databaseId}/${EXTERNAL_PORT_ROUTE[kind]}`,
      input,
    ),

  /**
   * Carries the file-mounts tree it could not reclaim, if any, and
   * whether the data volume is still on the Server — `null` when that could not
   * be read.
   */
  remove: (
    kind: DatabaseKind,
    databaseId: string,
    deleteData = false,
    /** Drop the row though the service could not be confirmed gone. */
    force = false,
  ) =>
    api.delete<DatabaseResponse & DatabaseDeleteReport>(
      `/${kind}/${databaseId}`,
      {
        query: {
          ...(deleteData ? { deleteData: "true" } : {}),
          ...(force ? { force: "true" } : {}),
        },
      },
    ),

  /**
   * The final snapshot a cloud database's Delete pressed now keeps;
   * `null` off a Cloud account. Guarded as the Delete is.
   */
  finalSnapshot: async (kind: DatabaseKind, databaseId: string) =>
    (await api.get<FinalSnapshotPreview | null>(
      `/${kind}/${databaseId}/final-snapshot`,
    )) ?? null,

  /** **Retry** a cloud database's incomplete Delete. `service: delete`. */
  retryCloudDelete: (kind: DatabaseKind, databaseId: string) =>
    api.post<DatabaseResponse>(`/${kind}/${databaseId}/delete/retry`),

  /** **Forget** a cloud database's incomplete Delete. `service: delete`. */
  forgetCloudDelete: (kind: DatabaseKind, databaseId: string) =>
    api.post<unknown>(`/${kind}/${databaseId}/delete/forget`),

  /**
   * Whether `<appName>-data` is on the Server now — the Delete dialog's read
   * before it is confirmed. Guarded as the Delete is.
   */
  dataVolume: (kind: DatabaseKind, databaseId: string) =>
    api.get<DataVolume>(`/${kind}/${databaseId}/volume`),

  /**
   * **`POST /:id/status` is a status *write*, and nothing calls it.**
   *
   * The phase brief flagged it as looking like a read; the DTO settles it —
   * `changePostgresStatusSchema` is `{ applicationStatus: 'idle' | 'running' |
   * 'done' | 'error' | 'stopped' }` and `BaseDatabaseService.changeStatus` does a bare
   * column update through `updateStatus`. It moves the badge and touches no
   * container.
   *
   * It is typed here and offered on no screen, deliberately. Deploy, start,
   * stop and rebuild each write the status themselves as part of doing the
   * thing; a control that wrote it on its own would exist only to make the
   * console disagree with the Server — a database reading `done` while its
   * service is scaled to zero. It is internal bookkeeping, not an operator
   * action.
   */
  changeStatus: (
    kind: DatabaseKind,
    databaseId: string,
    applicationStatus: ApplicationStatus,
  ) =>
    api.post<DatabaseResponse>(`/${kind}/${databaseId}/status`, {
      applicationStatus,
    }),
};
