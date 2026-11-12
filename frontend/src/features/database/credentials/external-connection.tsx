import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Icon } from "@/lib/design/icons";

import { SecretValue } from "./secret-value";

/**
 * The published port, and the warning that is **not a footnote.**
 *
 * A published port on a Swarm service is reachable by anyone who can route to the
 * host — there is no allowlist column, no firewall rule Cloudgate writes, and the
 * password is the only thing in the way. No port published is the safe default and
 * reads as one here rather than as something missing.
 */
export function ExternalConnection({
  host,
  port,
  uri,
  revealed,
}: {
  /** `null` for the platform's own host, which has no `server` row to print. */
  host: string | null;
  port: number | null;
  uri: string | undefined;
  revealed: boolean;
}) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-body font-semibold text-tx">From outside the Server</h3>
      {port === null ? (
        <p className="text-meta text-tx-2">
          No port is published, so nothing outside the overlay network can reach
          this database. That is the safe default — publish one below only if
          something off this Server has to connect.
        </p>
      ) : (
        <>
          <KVList>
            <KVRow
              label="Host"
              value={
                host ?? (
                  <span className="text-tx-2">
                    the address of this Cloudgate host
                  </span>
                )
              }
              title={host ?? undefined}
              mono={host !== null}
              action={
                host ? <CopyButton value={host} label="host" /> : undefined
              }
            />
            <KVRow
              label="Port"
              value={<span className="num">{port}</span>}
              action={<CopyButton value={String(port)} label="port" />}
            />
            {uri ? (
              <KVRow
                label="Connection string"
                value={<SecretValue value={uri} revealed={revealed} />}
                mono
                title={revealed ? uri : undefined}
                action={
                  <CopyButton value={uri} label="external connection string" />
                }
              />
            ) : null}
          </KVList>
          {/* No host to name means no string to copy — see `connection-card.tsx`.
              Saying so beats an absent row: an operator who has seen this row on
              a database that runs on a Server would otherwise read its absence
              as a load that has not finished. */}
          {!uri && host === null ? (
            <p className="text-meta text-tx-2">
              There is no connection string to copy, because Cloudgate has no
              address of its own host to put in one. Build it from the address
              you reach this host on, the port above, and the database, user and
              password in the section above.
            </p>
          ) : null}
          <p className="flex items-start gap-2 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx-2">
            <Icon name="alert" size={15} className="mt-0.5 flex-none text-warn" />
            <span>
              This port is open to anything that can reach the Server on it.
              Cloudgate writes no firewall rule and there is no allowlist — the
              password above is the only thing between the internet and this data.
            </span>
          </p>
        </>
      )}
    </section>
  );
}
