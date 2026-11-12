import { CopyButton } from "@/components/console/copy-button";
import { KVRow } from "@/components/console/kv-list";

import { SecretValue } from "./secret-value";

/**
 * A database's login as rows of a `KVList`: its database and user when the
 * engine has them, and its password, hidden until the card's one reveal.
 * Shared by the Server's connection and a cloud postgres's, whose
 * login is the same three facts at a different address.
 */
export function LoginRows({
  databaseName,
  user,
  password,
  revealed,
}: {
  databaseName: string;
  user: string;
  password: string;
  revealed: boolean;
}) {
  return (
    <>
      {databaseName ? (
        <KVRow
          label="Database"
          value={databaseName}
          title={databaseName}
          mono
          action={<CopyButton value={databaseName} label="database name" />}
        />
      ) : null}
      {user ? (
        <KVRow
          label="User"
          value={user}
          title={user}
          mono
          action={<CopyButton value={user} label="user" />}
        />
      ) : null}
      <KVRow
        label="Password"
        value={<SecretValue value={password} revealed={revealed} />}
        mono
        action={<CopyButton value={password} label="password" />}
      />
    </>
  );
}
