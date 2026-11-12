import { and, eq } from 'drizzle-orm';
import type { ServiceType } from '../applications/application.schema';
import { SERVICE_TABLES } from '../common/service-parent';
import { listComposePublishedPorts } from '../compose/compose-file';
import { compose } from '../compose/compose.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import { port } from '../networking/ports/port.schema';
import { recordedPreviewAddress } from '../preview-deployments/preview-host';
import { SERVICE_STATUS } from './service-owner';

// What a TCP Uptime check may dial: one of its Service's published TCP
// ports, on the address of the Server the Service runs on — or, on a
// Self-hosted instance only, the platform host's.

/** One published TCP port, as the console's picker offers it. */
export interface PublishedPort {
  port: number;
  /** What it is, in the console's words: "Database", "web → 80". */
  label: string;
}

/** `GET /uptime-checks/published-ports`. */
export interface PublishedPorts {
  /** The address a TCP check on this Service dials; null when it has none. */
  host: string | null;
  ports: PublishedPort[];
  /** Why there is nothing to dial, as a sentence; null when there is. */
  unavailableReason: string | null;
}

/**
 * What an operator is told when a Service has no port a TCP check could dial,
 * by kind — each naming where the port is published, so the refusal is also
 * the way out (spec story 18).
 */
const NO_PORT_REASON: Record<'application' | 'compose' | 'database', string> = {
  application:
    'This Application publishes no TCP port. Publish one on its Advanced tab first; a TCP check dials a published port.',
  compose:
    'This Compose file publishes no fixed TCP port. Publish one in the file (ports: "5432:5432") first; a TCP check dials a published port, not an inner service.',
  database:
    'This database has no external port. Publish its port first, under Published ports on its Credentials tab; a TCP check dials the external port.',
};

/**
 * A Compose deployed from a repository deploys the file in its repository,
 * which Cloudgate reads only on the machine at deploy time; the `composeFile`
 * column is not that file. Its published ports are recorded by a successful
 * deploy (`compose.deployedPublishedPorts`), so until one has
 * succeeded they are not known here, and the refusal says so — and how to
 * get past it — rather than that the file publishes none.
 */
export const COMPOSE_FROM_REPOSITORY_REASON =
  'Cloudgate reads the published ports of a Compose deployed from a repository when it deploys it, and this one hasn’t deployed successfully yet. Deploy it first; a TCP check dials a port its file publishes.';

/** The platform host's address when it has none recorded (see {@link tcpPlaceOf}). */
export const PLATFORM_HOST_FALLBACK_ADDRESS = '127.0.0.1';

/**
 * Said of a Service in a Cloud account, in every instance mode: a TCP check
 * dials a published port on its Server's address (CONTEXT.md, Uptime check),
 * and such a Service has no Server. Its `serverId` is `null`, which used to
 * read as the platform host, so the check dialled the box Cloudgate runs on
 * rather than anything the Service serves.
 */
export const CLOUD_SERVICE_TCP_REASON =
  'This Service runs in a Cloud account, not on a Server, so a TCP check has no Server address to dial. Watch it with an HTTP check at one of its Domains instead.';

/**
 * Said on the Hosted instance of a Service with no Server: the platform host
 * runs no customer's Services and is not dialled for one (ADR-0053), so a
 * port number a customer chose is never tried against the box's own
 * listeners (Postgres, the backend, Traefik, Docker).
 */
export const PLATFORM_HOST_TCP_REASON =
  'This Service has no Server, and this Cloudgate does not dial its own host for an Uptime check. Move it to one of your Servers; a TCP check dials a published port on its Server’s address.';

/** Said when a Service's Server has no address recorded to dial. */
export const NO_SERVER_ADDRESS_TCP_REASON =
  'This Service’s Server has no address recorded, so a TCP check has nothing to dial. Set the Server’s IP address first.';

/** Whether this is the Hosted instance; `InstanceMode` answers it. */
export interface HostedFlag {
  readonly isHosted: boolean;
}

/**
 * Where a TCP check on this Service dials, or why it dials nowhere: one answer
 * for the picker, the create and turn-on refusals and every probe tick.
 */
export type TcpPlace =
  { host: string; refusal: null } | { host: null; refusal: string };

/**
 * The address a TCP check on this Service dials: its Server's `ipAddress`, or
 * for a Service on the platform host of a **Self-hosted** instance the host's
 * recorded `server_ip` — what a client would dial. An instance that never
 * recorded one dials loopback, which is the same machine the Probe runs on and
 * so reaches the same published ports.
 *
 * **A `null` `serverId` is the platform host only off hosted mode, and only
 * for a Service not in a Cloud account.** A Service in a Cloud account (an
 * Application, a database, a Compose stack on its Stack VM) has no Server in
 * any mode ({@link CLOUD_SERVICE_TCP_REASON}); on the Hosted instance no
 * customer's port is dialled on the box ({@link PLATFORM_HOST_TCP_REASON}).
 * Either refusal travels as the published ports' `unavailableReason`, so no
 * such check is created or turned on, and the probe tick turns an existing one
 * off with it rather than dial.
 */
export async function tcpPlaceOf(
  db: DrizzleDB,
  serviceType: ServiceType,
  serviceId: string,
  mode: HostedFlag,
): Promise<TcpPlace> {
  const columns = SERVICE_TABLES[serviceType];
  const [row] = await db
    .select({
      serverId: columns.serverId,
      ...(columns.cloudAccountId && { cloudAccountId: columns.cloudAccountId }),
    })
    .from(columns.table)
    .where(eq(columns.id, serviceId))
    .limit(1);
  const found = row as
    { serverId?: string | null; cloudAccountId?: string | null } | undefined;
  if (found?.cloudAccountId) {
    return { host: null, refusal: CLOUD_SERVICE_TCP_REASON };
  }
  const serverId = found?.serverId ?? null;
  if (serverId === null && mode.isHosted) {
    return { host: null, refusal: PLATFORM_HOST_TCP_REASON };
  }
  const address = await recordedPreviewAddress(db, serverId);
  if (address) return { host: address, refusal: null };
  // Loopback stands in only for the platform host itself; a Server with no
  // address is not the box, and an empty host would dial it all the same.
  if (serverId !== null) {
    return { host: null, refusal: NO_SERVER_ADDRESS_TCP_REASON };
  }
  return { host: PLATFORM_HOST_FALLBACK_ADDRESS, refusal: null };
}

/** {@link tcpPlaceOf}'s address alone, for a read that only names it. */
export async function tcpHostOf(
  db: DrizzleDB,
  serviceType: ServiceType,
  serviceId: string,
  mode: HostedFlag,
): Promise<string | null> {
  return (await tcpPlaceOf(db, serviceType, serviceId, mode)).host;
}

/**
 * Every TCP port the Service publishes now, and the address they are dialled
 * on:
 *
 * - an **Application**'s `port` rows with protocol `tcp`;
 * - a **Compose**'s fixed TCP ports (`listComposePublishedPorts`) — the
 *   published side, never an inner service — read from its file when that
 *   file is the one it deploys (`sourceType` `raw`), and otherwise from the
 *   record its last successful deploy from a repository left
 *   (`compose.deployedPublishedPorts`); one with no such deploy yet has
 *   none known here ({@link COMPOSE_FROM_REPOSITORY_REASON});
 * - a **database**'s external port, and a LibSQL's gRPC and Admin ports
 *   beside it.
 *
 * No port is `unavailableReason`, never an empty list on its own, and so is
 * no place to dial them ({@link tcpPlaceOf}), with `host` null.
 */
export async function publishedPortsOf(
  db: DrizzleDB,
  serviceType: ServiceType,
  serviceId: string,
  mode: HostedFlag,
): Promise<PublishedPorts> {
  const place = await tcpPlaceOf(db, serviceType, serviceId, mode);
  // Nowhere to dial outranks which ports: there is no port to offer on it.
  if (place.refusal !== null) {
    return { host: null, ports: [], unavailableReason: place.refusal };
  }
  const { host } = place;
  const ports = await portsOf(db, serviceType, serviceId);
  if (ports === FROM_REPOSITORY) {
    return {
      host,
      ports: [],
      unavailableReason: COMPOSE_FROM_REPOSITORY_REASON,
    };
  }
  const unique = ports.filter(
    (entry, index) => ports.findIndex((p) => p.port === entry.port) === index,
  );
  const kind =
    serviceType === 'application' || serviceType === 'compose'
      ? serviceType
      : 'database';
  return {
    host,
    ports: unique,
    unavailableReason: unique.length === 0 ? NO_PORT_REASON[kind] : null,
  };
}

/** The one external port each single-listener engine publishes. */
const EXTERNAL_PORT = {
  postgres: postgres.externalPort,
  mysql: mysql.externalPort,
  mariadb: mariadb.externalPort,
  mongo: mongo.externalPort,
  redis: redis.externalPort,
} as const;

/**
 * {@link portsOf}'s answer for a Compose whose file is in a repository and
 * that has no successful deploy recorded yet.
 */
const FROM_REPOSITORY = Symbol('compose from a repository');

async function portsOf(
  db: DrizzleDB,
  serviceType: ServiceType,
  serviceId: string,
): Promise<PublishedPort[] | typeof FROM_REPOSITORY> {
  // A bucket publishes no port: it is reached with its key.
  if (serviceType === 'bucket') return [];
  if (serviceType === 'application') {
    const rows = await db
      .select({ published: port.publishedPort, target: port.targetPort })
      .from(port)
      .where(and(eq(port.applicationId, serviceId), eq(port.protocol, 'tcp')))
      .orderBy(port.publishedPort);
    return rows.map((row) => ({
      port: row.published,
      label: `Container port ${row.target}`,
    }));
  }
  if (serviceType === 'compose') {
    const [row] = await db
      .select({
        composeFile: compose.composeFile,
        sourceType: compose.sourceType,
        deployedPublishedPorts: compose.deployedPublishedPorts,
      })
      .from(compose)
      .where(eq(compose.composeId, serviceId))
      .limit(1);
    // Raw reads the file column and a repository source the record, so a
    // switch between them never shows the other's ports.
    const published =
      row && row.sourceType !== 'raw'
        ? row.deployedPublishedPorts
        : listComposePublishedPorts(row?.composeFile ?? '');
    if (published === null) return FROM_REPOSITORY;
    return published.map((entry) => ({
      port: entry.published,
      label: `${entry.service} → ${entry.target}`,
    }));
  }
  if (serviceType === 'libsql') {
    const [row] = await db
      .select({
        externalPort: libsql.externalPort,
        externalGRPCPort: libsql.externalGRPCPort,
        externalAdminPort: libsql.externalAdminPort,
      })
      .from(libsql)
      .where(eq(libsql.libsqlId, serviceId))
      .limit(1);
    if (!row) return [];
    return [
      { port: row.externalPort, label: 'Database' },
      { port: row.externalGRPCPort, label: 'gRPC' },
      { port: row.externalAdminPort, label: 'Admin' },
    ].filter((entry): entry is PublishedPort => entry.port !== null);
  }
  const { table, id } = SERVICE_STATUS[serviceType];
  const [row] = await db
    .select({ externalPort: EXTERNAL_PORT[serviceType] })
    .from(table)
    .where(eq(id, serviceId))
    .limit(1);
  return row?.externalPort == null
    ? []
    : [{ port: row.externalPort, label: 'Database' }];
}
