import { z } from "zod";

import { example, type FieldSpec } from "@/components/console/form-spec";
import type { BackupDatabaseType } from "@/lib/api/endpoints/backups";
import type {
  CreateDatabaseInput,
  Database,
  DatabaseKind,
  UpdateDatabaseInput,
} from "@/lib/api/endpoints/databases";
import { DATABASE_KINDS, DATABASE_LABEL } from "@/lib/api/endpoints/databases";
import type { IconName } from "@/lib/design/icons";
import { serviceNameField } from "@/lib/forms/service-name";

/**
 * **The six engines as one table. This file is the phase.**
 *
 * The backend's six database controllers are near-identical by design — one
 * shared base class, one set of routes, six thin subclasses that differ in an
 * image, a handful of connection columns and a port. The temptation is to
 * mirror that with six folders of panels; the brief calls it out as the wrong
 * answer, and it is, because the differences are *data* and would become
 * `switch (kind)` in a dozen components.
 *
 * So every panel under `features/database/panels/` reads this table and none of
 * them mentions an engine by name. What varies lives here:
 *
 * | | Postgres | MySQL | MariaDB | Mongo | Redis | LibSQL |
 * |---|---|---|---|---|---|---|
 * | database name | ● | ● | ● | | | |
 * | user | ● | ● | ● | ● | | ● |
 * | password | ● | ● | ● | ● | ● | ● |
 * | root password | | ● | ● | | | |
 * | published ports | 1 | 1 | 1 | 1 | 1 | **3** |
 * | dumps | ● | ● | ● | ● | | ● |
 *
 * The two entries worth reading twice are **Redis**, which has no user, no
 * database name and no dump command at all, and **LibSQL**, whose three
 * listeners are why its external-port route is plural — see
 * `EXTERNAL_PORT_ROUTE` in `endpoints/databases.ts`, which is the other half of
 * this table and holds the facts that are about routes rather than screens.
 */

// ── The columns an engine can have ─────────────────────────────────────────

/**
 * A connection column, named exactly as the row and the DTOs name it.
 *
 * "Credential" would be the wrong word for three of these — `replicaSets` and
 * `enableNamespaces` are topology, `databaseName` is an address — but they
 * belong to the same set for the same reason: they are the columns that exist
 * on some engines and not others, they are all set at create time, and they are
 * all edited on the Credentials tab afterwards.
 */
export type ConnectionColumn =
  | "databaseName"
  | "databaseUser"
  | "databasePassword"
  | "databaseRootPassword"
  | "replicaSets"
  | "sqldNode"
  | "sqldPrimaryUrl"
  | "enableNamespaces";

/**
 * One value shape for all six engines, so a form is one type whichever engine
 * it is showing. Which of these are rendered, and which are sent, is the
 * descriptor's answer — not the type's.
 */
export type DatabaseFormValues = {
  name: string;
  description: string;
  dockerImage: string;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
  databaseRootPassword: string;
  replicaSets: boolean;
  sqldNode: "primary" | "replica";
  sqldPrimaryUrl: string;
  enableNamespaces: boolean;
};

/**
 * Each connection column, rendered, once.
 *
 * Six engines share five of these eight, so writing them per engine would be
 * writing the same password hint six times and then having five of them drift.
 */
const COLUMN_FIELD: Record<
  ConnectionColumn,
  FieldSpec<DatabaseFormValues>
> = {
  databaseName: {
    kind: "text",
    name: "databaseName",
    label: "Database name",
    mono: true,
    placeholder: example("storefront"),
    hint: "The database created inside the engine on first start. Changing it later does not rename the existing one — the engine only reads this when its data directory is empty.",
  },
  databaseUser: {
    kind: "text",
    name: "databaseUser",
    label: "User",
    mono: true,
    placeholder: example("storefront"),
    hint: "The account applications connect as. Created on first start, alongside the database.",
  },
  databasePassword: {
    kind: "password",
    name: "databasePassword",
    label: "Password",
    hint: "Leave it empty when creating and one is generated for you — 16 characters, which is better than one you would pick. $ ! ' \" \\ / and spaces are refused: the password is interpolated into the container's start command.",
  },
  databaseRootPassword: {
    kind: "password",
    name: "databaseRootPassword",
    label: "Root password",
    hint: "This engine manages the application user and root as two separate credentials. Backups and restores run as root, so this is the one the dump command uses.",
  },
  replicaSets: {
    kind: "switch",
    name: "replicaSets",
    label: "Run as a replica set",
    hint: "Starts mongod with --replSet and initiates a single-node set on first boot. Transactions and change streams need one; a standalone server refuses both. Turning it on later re-initiates against a data directory that was not built for it.",
  },
  sqldNode: {
    kind: "select",
    name: "sqldNode",
    label: "Node type",
    options: [
      { value: "primary", label: "Primary", detail: "accepts writes" },
      { value: "replica", label: "Replica", detail: "follows a primary" },
    ],
    hint: "A sqld process is either the primary or a read replica following one.",
  },
  sqldPrimaryUrl: {
    kind: "text",
    name: "sqldPrimaryUrl",
    label: "Primary URL",
    mono: true,
    placeholder: "http://libsql-a1b2c3:5001",
    when: (values) => values.sqldNode === "replica",
    hint: "The primary's gRPC address. Required for a replica, and refused for a primary — the backend validates both directions.",
  },
  enableNamespaces: {
    kind: "switch",
    name: "enableNamespaces",
    label: "Enable namespaces",
    hint: "Adds --enable-namespaces to the sqld command, so one server can hold many logical databases addressed by hostname.",
  },
};

// ── Ports ──────────────────────────────────────────────────────────────────

/** One listener an engine publishes, and the column that publishes it. */
export type PortSpec = {
  /** The column on the row and in the external-port body. */
  column: "externalPort" | "externalGRPCPort" | "externalAdminPort";
  /** "Database", "gRPC", "Admin". Names the listener, not the column. */
  label: string;
  /** The port inside the container. Fixed by the image, never by us. */
  target: number;
  hint: string;
  /**
   * Why this listener cannot be published for *this* row, or `null` when it
   * can.
   *
   * One engine needs it and the alternative is worse than the parameter: a
   * LibSQL **replica** has no gRPC listener of its own, and the backend answers
   * a body that sets one with a 400
   * (`LibsqlService.saveExternalPorts`). A form that offered the field anyway
   * would let someone fill it in, press Save, and be told off for a combination
   * the screen suggested. Saying so where the field would be is the fix, and it
   * belongs in the table with the rest of the engine's shape.
   */
  unavailable?: (row: Database) => string | null;
};

// ── The descriptor ─────────────────────────────────────────────────────────

export type DatabaseDescriptor = {
  kind: DatabaseKind;
  /** The engine's own product name. A third-party string, not our vocabulary. */
  label: string;
  icon: IconName;
  /** One line on the create grid. What it is for, not what it is. */
  blurb: string;
  /**
   * What the backend's column default inserts when create omits `dockerImage`.
   *
   * **Not what the create form prefills** — see `suggestedImages`. For five
   * engines the two are the same string; MariaDB is why they are two fields.
   */
  defaultImage: string;
  /**
   * Tags worth knowing about, newest first. Suggestions in a hint, never a
   * closed list — `dockerImage` is a free string the backend hands to
   * `docker pull`, and a Picker over four tags would refuse `postgres:16.4`, a
   * private mirror, and everything published after this was written.
   *
   * **The first one is what a new database is created with**, rather than
   * `defaultImage`. MariaDB was the reason: its column default used to be
   * `mariadb:6`, and there is no such tag on Docker Hub — `docker pull
   * mariadb:6` answers `not found` — so a form that prefilled the backend's own
   * default created a database that could never pull its image.
   * The column default is now `mariadb:11` and corrected the stuck rows, so the
   * two now agree. The split stays: the prefill is a product choice about which
   * tag to suggest, and it should not silently follow a schema default that
   * changes.
   */
  suggestedImages: readonly string[];
  /** Every listener this engine publishes. The first is the one you connect to. */
  ports: readonly PortSpec[];
  /** Exactly the connection columns this engine's row and DTOs carry. */
  columns: readonly ConnectionColumn[];
  /**
   * How a client addresses it, or `null` for an engine with no URI form worth
   * printing. The host is the swarm service name on `cloudgate-network`; from
   * outside, it is the Server's address and the published port.
   */
  uri: ((parts: UriParts) => string) | null;
  /**
   * What happens to the `command` / `args` columns at deploy time.
   *
   * `buildDatabaseServiceSpec` lets an engine supply a `containerCommand` that
   * **wins over the row's own columns outright** (its own `containerCommand`
   * option says so), and
   * three of the six use it — but all three still read `command` themselves,
   * so the Advanced tab's run-command fields mean four different things
   * depending on the engine, and none of them is "ignored":
   *
   * - `"row"` — Postgres, MySQL, MariaDB, a standalone Mongo. The columns are
   *   the container's argv. A Command replaces the image's own entrypoint,
   *   which is what drops root and initialises an empty data directory, so the
   *   working shape is flags in Arguments and Command empty (the official
   *   postgres image refuses to start as root).
   * - `"generated"` — Mongo as a replica set. Cloudgate builds a bootstrap
   *   script; `args` is ignored, and `command` runs in the background once the
   *   replica set is initiated, while the script still ends waiting on mongod
   *   (`MongoService.replicaSetStartupScript`).
   * - `"replaces-launcher"` — LibSQL. `args` is ignored, and `command` replaces
   *   the whole `sqld` invocation Cloudgate otherwise generates, listen
   *   addresses and `--db-path` included (`LibsqlService.containerCommand`,
   *   whose docblock records honouring it as deliberate). This used to be
   *   `"generated"` with the words **saved and then ignored**, and a Command of
   *   `sqld` took a live database off the network. {@link launcher}
   *   carries what it replaces.
   * - `"password-wrapper"` — Redis, and the sharpest one. It has no password
   *   setting; the password is enforced by starting the container with
   *   `redis-server --requirepass`, and `RedisService.containerCommand` only
   *   applies that entrypoint when both columns are empty. So filling one in
   *   silently produces an **unauthenticated** server.
   *
   * A function of the row because Mongo's answer depends on `replicaSets`.
   */
  entrypoint: (
    row: Database,
  ) => "row" | "generated" | "replaces-launcher" | "password-wrapper";
  /**
   * The start command Cloudgate generates when `command` is empty, for an
   * engine whose `entrypoint` is `"replaces-launcher"` — what a Command has to
   * carry to keep the database reachable.
   *
   * A copy of `LibsqlService`'s `DEFAULT_SQLD_COMMAND`, not a read of it: the
   * backend exposes no route for it, and the card needs it before any deploy.
   * `listens` is the check the card warns with at save rather than a refusal
   * at the backend, because the column is a free program-and-arguments and a
   * sqld variant may spell its listen address in ways a refusal would have to
   * enumerate.
   */
  launcher?: {
    command: string;
    listens: (command: string) => boolean;
    address: string;
  };
  /**
   * When a credential saved on the Credentials tab reaches the engine.
   *
   * - `"first-start"` — Postgres, MySQL, MariaDB, Mongo. The image's
   *   entrypoint reads the environment only against an empty data directory
   *   (Mongo's replica-set script likewise creates its root user only when it
   *   initiates the set), so a change here does not change what the running
   *   engine accepts.
   * - `"every-deploy"` — Redis and LibSQL. Nothing is stored in the data
   *   directory: Redis's password is `--requirepass` on every start, and
   *   LibSQL's `SQLD_HTTP_AUTH` is read by sqld on every start. Measured by
   *   restarting `libsql-server:v0.24.32` against an existing `iku.db`
   *   with a new value: the new credential answered 200, the old 401, and the
   *   data was intact.
   *
   * A value rather than a function of the row: no engine's answer depends on
   * one. The static paragraph this replaced said `"first-start"` of all six.
   */
  credentials: "first-start" | "every-deploy";
  /**
   * The dump type, or `null` for an engine with no dump command.
   *
   * **Redis is the null.** `backupDatabaseTypes` is five long and
   * `BACKUP_COMMANDS` has no Redis entry, so a Redis backup cannot be created,
   * run or restored. The Backups tab reads this rather than testing the name.
   */
  backup: BackupDatabaseType | null;
  /**
   * What "database" means to this engine, for the one backup field that is not
   * filled in from the row — once per direction. `schedule` is the Add
   * a schedule form, where the dump is taken **from** the database; `restore`
   * is the Restore wizard's "Name the database" step, where the dump goes back
   * **into** one. A single sentence shared by both read backwards on one of the
   * two screens for every engine.
   */
  backupDatabaseHint?: { schedule: string; restore: string };
};

export type UriParts = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/**
 * Percent-encode every part a person typed — user, password and database
 * name — as the backend's `outputs.ts` does, so the Copy button copies the
 * same URI a wired variable holds.
 */
const enc = encodeURIComponent;

export const DATABASE_KIND: Record<DatabaseKind, DatabaseDescriptor> = {
  postgres: {
    kind: "postgres",
    label: DATABASE_LABEL.postgres,
    icon: "db",
    blurb: "The relational default. Transactions, JSON, and extensions for most of the rest.",
    defaultImage: "postgres:18",
    suggestedImages: ["postgres:18", "postgres:17", "postgres:16", "postgres:15"],
    ports: [
      {
        column: "externalPort",
        label: "Database",
        target: 5432,
        hint: "The port Postgres listens on inside the container.",
      },
    ],
    columns: ["databaseName", "databaseUser", "databasePassword"],
    entrypoint: () => "row",
    credentials: "first-start",
    uri: (p) =>
      `postgresql://${enc(p.user)}:${enc(p.password)}@${p.host}:${p.port}/${enc(p.database)}`,
    backup: "postgres",
    backupDatabaseHint: {
      schedule: "The database inside this server that gets dumped.",
      restore: "The database inside this server that the dump goes into.",
    },
  },

  mysql: {
    kind: "mysql",
    label: DATABASE_LABEL.mysql,
    icon: "db",
    blurb: "The relational workhorse most off-the-shelf applications expect.",
    defaultImage: "mysql:8.4",
    suggestedImages: ["mysql:8.4", "mysql:8", "mysql:5.7"],
    ports: [
      {
        column: "externalPort",
        label: "Database",
        target: 3306,
        hint: "The port MySQL listens on inside the container.",
      },
    ],
    columns: [
      "databaseName",
      "databaseUser",
      "databasePassword",
      "databaseRootPassword",
    ],
    entrypoint: () => "row",
    credentials: "first-start",
    uri: (p) =>
      `mysql://${enc(p.user)}:${enc(p.password)}@${p.host}:${p.port}/${enc(p.database)}`,
    backup: "mysql",
    backupDatabaseHint: {
      schedule:
        "The database that gets dumped. mysqldump and the restore both run as root, not as the application user.",
      restore:
        "The database the dump goes into. mysqldump and the restore both run as root, not as the application user.",
    },
  },

  mariadb: {
    kind: "mariadb",
    label: DATABASE_LABEL.mariadb,
    icon: "db",
    blurb: "MySQL's fork, wire-compatible with it and maintained separately.",
    defaultImage: "mariadb:11",
    suggestedImages: ["mariadb:11", "mariadb:10.11"],
    ports: [
      {
        column: "externalPort",
        label: "Database",
        target: 3306,
        hint: "The port MariaDB listens on inside the container. The same as MySQL's — they are wire-compatible.",
      },
    ],
    columns: [
      "databaseName",
      "databaseUser",
      "databasePassword",
      "databaseRootPassword",
    ],
    entrypoint: () => "row",
    credentials: "first-start",
    uri: (p) =>
      `mysql://${enc(p.user)}:${enc(p.password)}@${p.host}:${p.port}/${enc(p.database)}`,
    backup: "mariadb",
    backupDatabaseHint: {
      schedule: "The database that gets dumped.",
      restore: "The database the dump goes into.",
    },
  },

  mongo: {
    kind: "mongo",
    label: DATABASE_LABEL.mongo,
    icon: "db",
    blurb: "Documents rather than rows, for data whose shape is still moving.",
    defaultImage: "mongo:8",
    suggestedImages: ["mongo:8", "mongo:7", "mongo:6"],
    ports: [
      {
        column: "externalPort",
        label: "Database",
        target: 27017,
        hint: "The port mongod listens on inside the container.",
      },
    ],
    // No `databaseName`: the root user owns the whole server, and a database
    // comes into existence the first time something writes to it.
    columns: ["databaseUser", "databasePassword", "replicaSets"],
    // Only the replica-set branch builds an entrypoint; a standalone Mongo uses
    // the row's own columns like Postgres does (`MongoService.containerCommand`).
    entrypoint: (row) => (row.replicaSets ? "generated" : "row"),
    credentials: "first-start",
    uri: (p) =>
      `mongodb://${enc(p.user)}:${enc(p.password)}@${p.host}:${p.port}/${enc(p.database || "")}?authSource=admin`,
    backup: "mongo",
    backupDatabaseHint: {
      schedule:
        "Which database in this server to dump. Mongo has no single database of its own — the root user owns them all — so this one has to be named.",
      restore:
        "Which database in this server the dump goes into. Mongo has no single database of its own — the root user owns them all — so this one has to be named. Its collections are dropped and replaced by the dump's.",
    },
  },

  redis: {
    kind: "redis",
    label: DATABASE_LABEL.redis,
    icon: "zap",
    blurb: "An in-memory keyspace, for caches, queues and sessions.",
    defaultImage: "redis:8",
    suggestedImages: ["redis:8", "redis:7"],
    ports: [
      {
        column: "externalPort",
        label: "Database",
        target: 6379,
        hint: "The port redis-server listens on inside the container.",
      },
    ],
    // The password is the whole connection identity: no user, no database name.
    columns: ["databasePassword"],
    entrypoint: () => "password-wrapper",
    credentials: "every-deploy",
    uri: (p) => `redis://default:${enc(p.password)}@${p.host}:${p.port}`,
    backup: null,
  },

  libsql: {
    kind: "libsql",
    label: DATABASE_LABEL.libsql,
    icon: "db",
    blurb: "SQLite over the network, as a primary with read replicas following it.",
    defaultImage: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
    suggestedImages: ["ghcr.io/tursodatabase/libsql-server:v0.24.32"],
    // Three listeners, which is the whole reason this engine's external-port
    // route is plural. The order is the order the form shows them in.
    ports: [
      {
        column: "externalPort",
        label: "HTTP",
        target: 8080,
        hint: "The HTTP API clients connect to.",
      },
      {
        column: "externalGRPCPort",
        label: "gRPC",
        target: 5001,
        hint: "How a replica follows this primary. Publish it only if the replica is on another Server — one in the same Environment reaches the primary over the overlay network.",
        unavailable: (row) =>
          row.sqldNode === "replica"
            ? "A replica has no gRPC listener of its own — it connects to the primary's. The backend refuses a body that publishes one."
            : null,
      },
      {
        column: "externalAdminPort",
        label: "Admin",
        target: 5000,
        hint: "sqld's admin API — namespace management and diagnostics. Publishing it on the host exposes those to anyone who can reach the port.",
      },
    ],
    columns: [
      "databaseUser",
      "databasePassword",
      "sqldNode",
      "sqldPrimaryUrl",
      "enableNamespaces",
    ],
    entrypoint: () => "replaces-launcher",
    launcher: {
      command:
        "sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000",
      // sqld's default is 127.0.0.1:8080, reachable from nothing outside the
      // container — which is what a bare `sqld` produced.
      listens: (command) =>
        /--http-listen-addr[ =](0\.0\.0\.0|\[::\]):8080(\s|$)/.test(command),
      address: "0.0.0.0:8080",
    },
    credentials: "every-deploy",
    // sqld authenticates with HTTP basic, so the credentials go in the URL the
    // way a browser would send them.
    uri: (p) => `http://${enc(p.user)}:${enc(p.password)}@${p.host}:${p.port}`,
    backup: "libsql",
    backupDatabaseHint: {
      schedule:
        "sqld has no dump tool, so a backup is a tar of the whole data directory and this names the file rather than a database inside the server.",
      restore:
        "sqld has no dump tool, so a backup is a tar of the data directory and unpacks back into the file it was taken from, whatever name is typed here.",
    },
  },
};

/** The six, in the order the create grid shows them. */
export const DATABASE_DESCRIPTORS: readonly DatabaseDescriptor[] =
  DATABASE_KINDS.map((kind) => DATABASE_KIND[kind]);

// ── What the descriptor answers ────────────────────────────────────────────

/** Whether this engine has a column at all — the one predicate panels use. */
export function hasColumn(
  kind: DatabaseKind,
  column: ConnectionColumn,
): boolean {
  return DATABASE_KIND[kind].columns.includes(column);
}

/**
 * A password field on the Credentials tab's edit form. The form starts
 * empty and an empty field keeps the stored password, so the hint says that,
 * not the create form's "leave it empty and one is generated"; and the stored
 * value is read only behind the Connection card's Show secrets, the one place
 * a stored secret is revealed.
 */
const EDIT_PASSWORD = {
  placeholder: "Unchanged",
  hint: "Leave it empty to keep the current password. A new one replaces it; $ ! ' \" \\ / and spaces are refused, since the password is interpolated into the container's start command.",
} as const;

/**
 * This engine's connection fields, in its own order. `mode` is
 * `databaseSchema`'s: `"update"` is the Credentials tab, where a password
 * field holds only what is typed into it.
 */
export function connectionFields(
  kind: DatabaseKind,
  mode: "create" | "update" = "create",
): FieldSpec<DatabaseFormValues>[] {
  const descriptor = DATABASE_KIND[kind];
  return descriptor.columns.map((column) =>
    // `COLUMN_FIELD`'s "Created on first start" is the four first-start
    // engines' answer; LibSQL's user is half of `SQLD_HTTP_AUTH`, read on
    // every start, and said so here rather than in a seventh column entry.
    column === "databaseUser" && descriptor.credentials === "every-deploy"
      ? {
          ...COLUMN_FIELD.databaseUser,
          hint: "The account applications connect as. Read on every start, alongside the password, so a change applies at the next deploy.",
        }
      : mode === "update" && PASSWORD_COLUMNS.includes(column)
        ? { ...COLUMN_FIELD[column], ...EDIT_PASSWORD }
        : COLUMN_FIELD[column],
  );
}

/** The columns {@link valuesFrom} never fills and a save clears. */
export const PASSWORD_COLUMNS: readonly ConnectionColumn[] = [
  "databasePassword",
  "databaseRootPassword",
];

/**
 * The image field. A **text** field on every screen, never a closed list.
 *
 * `dockerImage` is a free string the backend passes to `docker pull`, and a
 * Picker over four tags we happened to know about would refuse `postgres:16.4`,
 * a private mirror, and every tag published after this was written. The
 * suggestions go in the hint, where being out of date costs nothing.
 */
export function imageField(
  kind: DatabaseKind,
): FieldSpec<DatabaseFormValues> {
  const descriptor = DATABASE_KIND[kind];
  return {
    kind: "text",
    name: "dockerImage",
    label: "Image",
    mono: true,
    placeholder: descriptor.defaultImage,
    hint: `Any tag ${descriptor.label} publishes, or a mirror of your own. Common ones: ${descriptor.suggestedImages.join(", ")}. Changing it takes effect on the next deploy, and a major version usually will not start against an older version's data directory.`,
  };
}

/**
 * The blank form for an engine.
 *
 * `databasePassword` stays empty on purpose: omitted, the backend generates one.
 *
 * The image is the **first suggestion, not the column default** — see
 * `suggestedImages`. For five engines these are the same string; for MariaDB
 * the column default is a tag that does not exist.
 */
export function blankValues(kind: DatabaseKind): DatabaseFormValues {
  return {
    name: "",
    description: "",
    dockerImage:
      DATABASE_KIND[kind].suggestedImages[0] ?? DATABASE_KIND[kind].defaultImage,
    databaseName: "",
    databaseUser: "",
    databasePassword: "",
    databaseRootPassword: "",
    replicaSets: false,
    sqldNode: "primary",
    sqldPrimaryUrl: "",
    enableNamespaces: false,
  };
}

/** The row, as form values — the Credentials tab's starting point. */
export function valuesFrom(row: Database): DatabaseFormValues {
  return {
    name: row.name,
    description: row.description ?? "",
    dockerImage: row.dockerImage,
    databaseName: row.databaseName ?? "",
    databaseUser: row.databaseUser ?? "",
    // Never the stored values: an empty field keeps them, and the
    // Connection card's Show secrets is where a stored secret is read.
    databasePassword: "",
    databaseRootPassword: "",
    replicaSets: row.replicaSets ?? false,
    sqldNode: row.sqldNode ?? "primary",
    sqldPrimaryUrl: row.sqldPrimaryUrl ?? "",
    enableNamespaces: row.enableNamespaces ?? false,
  };
}

/**
 * The connection columns this engine has, as a request body.
 *
 * **`mode` is F10's rule, and it is load-bearing here too.** An empty optional
 * is `undefined` when creating — every create DTO types the password
 * `.optional()`, which *refuses a null*, and omitting it is what triggers the
 * server-side generation. On update the same emptiness means "leave it alone",
 * and sending `""` would fail `min(1)` on the user and the database name. So
 * `update` drops empties rather than clearing them: none of these columns is
 * nullable, and there is nothing to clear them to.
 */
function connectionBody(
  kind: DatabaseKind,
  values: DatabaseFormValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const column of DATABASE_KIND[kind].columns) {
    const value = values[column];
    if (typeof value === "boolean") {
      body[column] = value;
      continue;
    }
    const text = String(value).trim();
    if (text !== "") body[column] = text;
  }
  // A primary must not carry one, and the backend refuses a body that does.
  if (values.sqldNode !== "replica") delete body.sqldPrimaryUrl;
  return body;
}

/**
 * The zod schema for an engine's form, built from its columns.
 *
 * One schema shape covering every column, with the rules turned on only for the
 * columns this engine has — so a Redis form is not asked for a user it does not
 * have, and a Postgres form is. `mode` is what separates the two screens that
 * use it: **creating**, where an empty password means "generate one", and
 * **editing**, where an empty field means "leave this one alone" (there is
 * nothing to clear it to — none of these columns is nullable).
 *
 * The password rule is the backend's own `DATABASE_PASSWORD_REGEX`, checked here
 * so the refusal lands on the field as you type rather than as a 400 after a
 * round trip. The reason for the rule is worth carrying with it: the password is
 * interpolated into the container's start command, so a `$` or a quote in it
 * breaks the shell rather than the login.
 */
const PASSWORD_OK = /^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/;

const PASSWORD_MESSAGE =
  "A password here cannot contain $ ! ' \" \\ / or a space — it is interpolated into the container's start command.";

/**
 * The database and user a Postgres, MySQL or MariaDB is created with, as
 * the backend's `databaseIdentifierSchema` checks them: an unquoted
 * identifier, within the engine's own limit. Create only; Mongo's user is
 * percent-encoded wherever it goes and has no database column.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER_MAX: Partial<
  Record<DatabaseKind, { databaseName: number; databaseUser: number }>
> = {
  postgres: { databaseName: 63, databaseUser: 63 },
  mysql: { databaseName: 64, databaseUser: 32 },
  mariadb: { databaseName: 64, databaseUser: 80 },
};

export function databaseSchema(
  kind: DatabaseKind,
  mode: "create" | "update",
): z.ZodType<DatabaseFormValues> {
  const has = (column: ConnectionColumn) =>
    DATABASE_KIND[kind].columns.includes(column);

  /** Required when the engine has it and we are creating it for the first time. */
  const identity = (
    column: "databaseName" | "databaseUser",
    message: string,
  ) => {
    if (!has(column) || mode !== "create") return z.string().trim();
    const required = z.string().trim().min(1, message);
    const max = IDENTIFIER_MAX[kind]?.[column];
    if (max === undefined) return required;
    return required
      .max(max, `${DATABASE_KIND[kind].label} allows ${max} characters here.`)
      .regex(
        IDENTIFIER,
        "Use letters, digits and underscores, starting with a letter or underscore.",
      )
      .refine(
        (value) =>
          !(
            kind === "postgres" &&
            column === "databaseUser" &&
            value.toLowerCase().startsWith("pg_")
          ),
        "PostgreSQL reserves names starting with pg_ for its own roles.",
      );
  };

  const password = z
    .string()
    .refine((value) => PASSWORD_OK.test(value), PASSWORD_MESSAGE);

  return z
    .object({
      name: serviceNameField("A database needs a name."),
      description: z.string(),
      dockerImage: z.string().trim(),
      databaseName: identity(
        "databaseName",
        "Name the database this engine creates on first start.",
      ),
      databaseUser: identity(
        "databaseUser",
        "Name the account applications will connect as.",
      ),
      databasePassword: password,
      databaseRootPassword: password,
      replicaSets: z.boolean(),
      sqldNode: z.enum(["primary", "replica"]),
      sqldPrimaryUrl: z.string().trim(),
      enableNamespaces: z.boolean(),
    })
    .superRefine((values, ctx) => {
      // The backend validates this in both directions and the form should too,
      // because getting it wrong is a 400 on a field the person cannot see the
      // rule for.
      if (
        has("sqldPrimaryUrl") &&
        values.sqldNode === "replica" &&
        values.sqldPrimaryUrl === ""
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["sqldPrimaryUrl"],
          message: "A replica has to name the primary it follows.",
        });
      }
    }) as unknown as z.ZodType<DatabaseFormValues>;
}

/** `POST /:kind` — identity plus the engine's own columns. */
export function toCreateInput(
  kind: DatabaseKind,
  values: DatabaseFormValues,
  environmentId: string,
  serverId?: string | null,
): CreateDatabaseInput {
  const image = values.dockerImage.trim();
  return {
    name: values.name.trim(),
    environmentId,
    ...(values.description.trim() !== ""
      ? { description: values.description.trim() }
      : {}),
    ...(image !== "" ? { dockerImage: image } : {}),
    ...(serverId === undefined ? {} : { serverId }),
    ...connectionBody(kind, values),
  };
}

/** `PATCH /:kind/:id` — the connection columns only. */
export function toCredentialsInput(
  kind: DatabaseKind,
  values: DatabaseFormValues,
): UpdateDatabaseInput {
  return connectionBody(kind, values) as UpdateDatabaseInput;
}
