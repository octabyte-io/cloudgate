import { useState, type ReactNode } from "react";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Button } from "@/components/ui/button";
import type {
  CloudEndpoint,
  Database,
  DatabaseKind,
} from "@/lib/api/endpoints/databases";
import { memorystoreSettingsOf } from "@/lib/api/endpoints/memorystore-redis";
import { Icon } from "@/lib/design/icons";

import { DATABASE_KIND } from "../kinds";
import { LoginRows } from "./login-rows";
import { SecretValue } from "./secret-value";

/** Which cloud's own password rule a database has. */
type CloudLogin = "memorystore" | "elasticache" | "postgres";

const NO_PASSWORD =
  "No password. Only this Environment's private network reaches it, over TLS";

/**
 * What each password rule shows: its password rows, its connection string,
 * and whether that string holds a secret (masked, with Show secrets) or is
 * copied at all.
 */
const LOGINS: Record<
  CloudLogin,
  {
    secret: boolean;
    copied: boolean;
    /** Whether a linked Service has a `password` Output to link. */
    passwordOutput: boolean;
    rows: (database: Database, revealed: boolean) => ReactNode;
    uri: (
      endpoint: CloudEndpoint,
      database: Database,
      kind: DatabaseKind,
    ) => string | undefined;
  }
> = {
  // ADR-0042: no password, so its URL has no userinfo.
  memorystore: {
    secret: false,
    copied: true,
    passwordOutput: false,
    rows: () => <KVRow label="Password" value={NO_PASSWORD} title={NO_PASSWORD} />,
    uri: ({ host, port }) => `rediss://${host}:${port}`,
  },
  // Its password is the AUTH token Cloudgate made, read back only as set,
  // so its string names it and is not copied.
  elasticache: {
    secret: false,
    copied: false,
    passwordOutput: true,
    rows: (database) => (
      <KVRow
        label="Password"
        value={
          database.hasAuthToken ? "AUTH token: set" : "AUTH token: not set"
        }
      />
    ),
    uri: ({ host, port }) => `rediss://default:<AUTH token>@${host}:${port}`,
  },
  // On RDS and Cloud SQL the login is real, as on a Server; a mysql on RDS's
  // string is MySQL's.
  postgres: {
    secret: true,
    copied: true,
    passwordOutput: true,
    rows: (database, revealed) => (
      <LoginRows
        databaseName={database.databaseName ?? ""}
        user={database.databaseUser ?? ""}
        password={database.databasePassword ?? ""}
        revealed={revealed}
      />
    ),
    uri: ({ host, port }, database, kind) =>
      DATABASE_KIND[kind === "mysql" ? "mysql" : "postgres"].uri?.({
        host,
        port,
        user: database.databaseUser ?? "",
        password: database.databasePassword ?? "",
        database: database.databaseName ?? "",
      }),
  },
};

/**
 * A cloud database's place: where its last Cloud run saved it answers, or
 * `null` before one has, and whose password rule it has.
 */
function cloudPlaceOf(
  row: Database,
  kind: DatabaseKind,
): { endpoint: CloudEndpoint | null; login: CloudLogin } {
  if (kind === "redis") {
    // A redis on Google Cloud answers `memorystore` beside it.
    if (memorystoreSettingsOf(row) || row.memorystoreEndpoint) {
      return { endpoint: row.memorystoreEndpoint ?? null, login: "memorystore" };
    }
    return { endpoint: row.elasticacheEndpoint ?? null, login: "elasticache" };
  }
  return {
    endpoint: row.rdsEndpoint ?? row.cloudSqlEndpoint ?? null,
    login: "postgres",
  };
}

/**
 * How something reaches a database Cloudgate made on a cloud: the
 * address its Cloud run saved, over TLS (a mysql on RDS offers it), and the password its cloud
 * has, which is what wiring hands a linked Service. In place of the
 * Server's connection card, whose host is the Swarm service name and whose
 * password a cloud instance never sees, and of External ports, since a
 * cloud database publishes none. Its CA is said, not printed: a linked
 * Service gets it as the `ca` Output.
 */
export function CloudConnectionCard({
  database,
  kind,
}: {
  database: Database;
  kind: DatabaseKind;
}) {
  const [revealed, setRevealed] = useState(false);
  const { endpoint, login } = cloudPlaceOf(database, kind);
  const shows = LOGINS[login];
  const uri =
    endpoint === null ? undefined : shows.uri(endpoint, database, kind);
  const masked = shows.secret && !revealed;

  return (
    <Card>
      <Card.Header
        title="Connection"
        sub={`How a Service in this Environment reaches this ${DATABASE_KIND[kind].label}.`}
        headingLevel={2}
        actions={
          shows.secret ? (
            <Button
              size="xs"
              aria-pressed={revealed}
              onClick={() => setRevealed((on) => !on)}
            >
              <Icon name={revealed ? "eyeOff" : "eye"} size={14} />
              {revealed ? "Hide secrets" : "Show secrets"}
            </Button>
          ) : undefined
        }
      />

      <Card.Body className="grid gap-4">
        <KVList>
          {endpoint ? (
            <>
              <KVRow
                label="Host"
                value={endpoint.host}
                title={endpoint.host}
                mono
                action={<CopyButton value={endpoint.host} label="host" />}
              />
              <KVRow
                label="Port"
                value={<span className="num">{endpoint.port}</span>}
                action={
                  <CopyButton value={String(endpoint.port)} label="port" />
                }
              />
            </>
          ) : (
            <KVRow
              label="Host"
              value="Not made yet: its address appears once its Cloud run has made it"
            />
          )}
          {/* RDS's default parameter group leaves a MySQL's TLS off by default. */}
          <KVRow
            label="TLS"
            value={kind === "mysql" ? "Offered, not required" : "Required"}
          />
          {shows.rows(database, revealed)}
          {uri ? (
            <KVRow
              label="Connection string"
              value={
                shows.secret ? (
                  <SecretValue value={uri} revealed={revealed} />
                ) : (
                  uri
                )
              }
              title={masked ? undefined : uri}
              mono
              action={
                shows.copied ? (
                  <CopyButton value={uri} label="connection string" />
                ) : undefined
              }
            />
          ) : null}
        </KVList>
        <p className="text-meta text-tx-2">
          Its certificate authority reaches a linked Service as the{" "}
          <code className="font-mono">ca</code> Output. A Service gets these by
          linking <code className="font-mono">url</code>,{" "}
          <code className="font-mono">host</code>,{" "}
          <code className="font-mono">port</code> and{" "}
          <code className="font-mono">ca</code>
          {shows.passwordOutput ? (
            <>
              {" "}
              (and <code className="font-mono">password</code>)
            </>
          ) : null}{" "}
          on its Variables tab.
        </p>
      </Card.Body>
    </Card>
  );
}
