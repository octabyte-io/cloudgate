import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";

import { LoginRows } from "./login-rows";
import { SecretValue } from "./secret-value";

/**
 * The overlay address — **the one nearly everything should use.**
 *
 * Every service on `cloudgate-network` resolves the Swarm service by name, so this
 * needs no published port and never leaves the Server. The connection string is the
 * row that matters: every other row exists so somebody can check a part of it.
 */
export function InternalConnection({
  host,
  port,
  databaseName,
  user,
  password,
  rootPassword,
  uri,
  revealed,
}: {
  host: string;
  port: number;
  databaseName: string;
  user: string;
  password: string;
  /** Present only for the engines that have one. */
  rootPassword: string | undefined;
  /** Assembled from the engine's own descriptor, so no scheme is known here. */
  uri: string | undefined;
  revealed: boolean;
}) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-body font-semibold text-tx">Inside the Environment</h3>
      <p className="text-meta text-tx-2">
        Every service on <code className="font-mono">cloudgate-network</code>{" "}
        resolves the Swarm service by name, so this needs no published port and
        never leaves the Server.
      </p>
      <KVList>
        <KVRow
          label="Host"
          value={host}
          title={host}
          mono
          action={<CopyButton value={host} label="host" />}
        />
        <KVRow
          label="Port"
          value={<span className="num">{port}</span>}
          action={<CopyButton value={String(port)} label="port" />}
        />
        <LoginRows
          databaseName={databaseName}
          user={user}
          password={password}
          revealed={revealed}
        />
        {rootPassword !== undefined ? (
          <KVRow
            label="Root password"
            value={<SecretValue value={rootPassword} revealed={revealed} />}
            mono
            action={<CopyButton value={rootPassword} label="root password" />}
          />
        ) : null}
        {uri ? (
          <KVRow
            label="Connection string"
            value={<SecretValue value={uri} revealed={revealed} />}
            mono
            title={revealed ? uri : undefined}
            action={<CopyButton value={uri} label="connection string" />}
          />
        ) : null}
      </KVList>
    </section>
  );
}
