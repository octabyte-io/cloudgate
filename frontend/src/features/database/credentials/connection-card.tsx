import { useState } from "react";

import { Card } from "@/components/console/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

import { DATABASE_KIND } from "../kinds";
import { ExternalConnection } from "./external-connection";
import { InternalConnection } from "./internal-connection";

/**
 * How to connect, from inside the network and from outside it.
 *
 * **Two cards' worth of content in one, on purpose.** The internal and external
 * details are the same six facts with a different host and port, and an
 * operator's actual question is "which of these do I paste" — which is only
 * answerable if both are on screen together, with the difference between them
 * visible. Split across two cards, the external one reads as *the* address and
 * the internal one as a curiosity, which is backwards: the overlay address is
 * the one nearly everything should use. So the two sections are two files under
 * one card, and the reveal is one control for both.
 *
 * **The connection string is the row that matters.** Every other row exists so that
 * someone can check a part of it; the string is what gets pasted. It is assembled
 * from the descriptor's `uri`, so a Redis URL and a Mongo URL are right without this
 * component knowing either scheme.
 */
export function ConnectionCard({
  database,
  kind,
}: {
  database: Database;
  kind: DatabaseKind;
}) {
  const [revealed, setRevealed] = useState(false);
  const descriptor = DATABASE_KIND[kind];
  const primary = descriptor.ports[0];

  const password = database.databasePassword ?? "";
  const user = database.databaseUser ?? "";
  const databaseName = database.databaseName ?? "";

  const internalHost = database.appName;
  const internalUri = descriptor.uri?.({
    host: internalHost,
    port: primary.target,
    user,
    password,
    database: databaseName,
  });

  // `serverId` null is the platform's own host, which has no `server` row and
  // therefore no address we can print. **So there is no external URI**, and
  // that is the whole of the change: this used to substitute the
  // literal `"<this host>"` and hand the result to a row with a copy button, so
  // once secrets were revealed it read as a working connection string and put
  // the password on the clipboard for a URI that cannot connect. The Host row
  // one line down has always said "the address of this Cloudgate host" in
  // words, with no copy — the string now keeps the same promise.
  //
  // Building it from the console's own origin was the other option the issue
  // offered and it is not available: nothing plumbs `CLOUDGATE_PUBLIC_HOST` to
  // the console, `NEXT_PUBLIC_API_URL` is the API's origin rather than this
  // Server's address, and guessing is how a copy button lies a second time.
  const externalHost = database.server?.ipAddress ?? null;
  const externalPort = database.externalPort;
  const externalUri =
    externalPort !== null && externalHost !== null
      ? descriptor.uri?.({
          host: externalHost,
          port: externalPort,
          user,
          password,
          database: databaseName,
        })
      : undefined;

  return (
    <Card>
      <Card.Header
        title="Connection"
        sub={`How something reaches this ${descriptor.label}.`}
        headingLevel={2}
        actions={
          <Button
            size="xs"
            aria-pressed={revealed}
            onClick={() => setRevealed((on) => !on)}
          >
            <Icon name={revealed ? "eyeOff" : "eye"} size={14} />
            {revealed ? "Hide secrets" : "Show secrets"}
          </Button>
        }
      />

      <Card.Body className="grid gap-4">
        <InternalConnection
          host={internalHost}
          port={primary.target}
          databaseName={databaseName}
          user={user}
          password={password}
          rootPassword={database.databaseRootPassword}
          uri={internalUri}
          revealed={revealed}
        />

        <ExternalConnection
          host={externalHost}
          port={externalPort}
          uri={externalUri}
          revealed={revealed}
        />
      </Card.Body>
    </Card>
  );
}
