import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import {
  connectionId,
  gitProvidersApi,
  type GitConnection,
  type GitProviderKind,
  type SourceRepository,
} from "@/lib/api/endpoints/git-providers";
import { cn } from "@/lib/utils";

import { providerOf } from "./providers";

/**
 * **The connection test, and it is a real one.**
 *
 * No strategy controller has a `/test` route — the brief's "the connection test
 * implied by listing repositories" is exactly right, because
 * `GET /<kind>/:id/repositories` is a round trip to the provider with these
 * credentials, and there is no cheaper question that proves anything. So the
 * button *is* the read the source picker will make later, and what it reports is
 * what that picker will see.
 *
 * Three outcomes, and they are three different sentences:
 *
 * 1. **Repositories.** The count, and the first few names, so it is obvious the
 *    connection reaches the *right* account.
 * 2. **None.** Authenticated, and can see nothing — which for GitHub means the
 *    App is installed somewhere with no repositories granted, and for GitLab
 *    with no groups set means personal projects only. Not an error, and not the
 *    same thing as a refusal (F09's first defect, which was exactly this pair
 *    collapsed into one).
 * 3. **A refusal**, carrying the provider's own words.
 *
 * The result renders **in place** rather than in a dialog, which is also why
 * this is not a `rowExtras` button on the table: a dialog mounted inside a table
 * cell unmounts when the query refetches, and this button's whole job is to
 * cause a query (F10's first list-level decision).
 */
export function RepositoryCheck({
  kind,
  connections,
}: {
  kind: GitProviderKind;
  connections: GitConnection[];
}) {
  const descriptor = providerOf(kind);
  if (connections.length === 0) return null;

  return (
    <Card tone="plain">
      <Card.Header
        title="Check a connection"
        sub={`Lists repositories through ${descriptor.label} with the stored credentials — the same read an Application's source picker makes.`}
        headingLevel={3}
      />
      <Card.Body className="grid gap-2.5">
        {connections.map((connection) => (
          <CheckRow
            key={connection.gitProviderId}
            kind={kind}
            connection={connection}
          />
        ))}
      </Card.Body>
    </Card>
  );
}

type Result =
  | { ok: true; repositories: SourceRepository[] }
  | { ok: false; message: string };

function CheckRow({
  kind,
  connection,
}: {
  kind: GitProviderKind;
  connection: GitConnection;
}) {
  const descriptor = providerOf(kind);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function check() {
    setResult(null);
    setPending(true);
    try {
      const repositories = await gitProvidersApi.repositories(
        kind,
        connectionId(kind, connection),
      );
      setResult({ ok: true, repositories });
    } catch (error) {
      setResult({ ok: false, message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-0 flex-1 basis-40 text-body font-medium wrap-anywhere text-tx">
          {connection.gitProvider?.name ?? descriptor.label}
        </span>
        <Button
          size="sm"
          onClick={check}
          disabled={pending}
          aria-busy={pending || undefined}
        >
          List repositories
        </Button>
      </div>

      {result === null ? null : result.ok ? (
        <div className="mt-2.5 text-meta text-tx-2">
          {result.repositories.length === 0 ? (
            // Authenticated and empty-handed. Deliberately not "this connection
            // does not work": it does, and the thing to change is at the
            // provider, not here.
            <p className="wrap-anywhere">
              This connection works and can see{" "}
              <strong className="font-medium text-tx">no repositories</strong>.
              The credentials are accepted; nothing has been shared with them.{" "}
              {emptyAdvice(kind)}
            </p>
          ) : (
            <>
              <p>
                <strong className="font-medium text-tx">
                  {result.repositories.length}
                </strong>{" "}
                {result.repositories.length === 1
                  ? "repository"
                  : "repositories"}{" "}
                reachable.
              </p>
              <p className="mt-1.5 flex flex-wrap gap-1.5">
                {result.repositories.slice(0, 6).map((repository) => (
                  <Chip key={repository.key} variant="mono">
                    {repository.owner}/{repository.name}
                  </Chip>
                ))}
                {result.repositories.length > 6 ? (
                  <span className="self-center">
                    and {result.repositories.length - 6} more
                  </span>
                ) : null}
              </p>
            </>
          )}
        </div>
      ) : (
        <p
          className={cn(
            "mt-2.5 rounded-md border border-bad-line bg-bad-tint px-3 py-2 text-meta wrap-anywhere text-tx",
          )}
        >
          <span className="font-medium">{descriptor.label} refused. </span>
          {result.message}
        </p>
      )}
    </div>
  );
}

/** What to change, per provider, when the answer is an empty list. */
function emptyAdvice(kind: GitProviderKind): string {
  if (kind === "github")
    return "Grant the App access to some repositories on its installation page.";
  if (kind === "gitlab")
    return "With no groups set, Cloudgate offers personal projects only — set the group names above to reach a group's.";
  if (kind === "bitbucket")
    return "Set a workspace above, or grant the token repository read access.";
  return "Check that the token's account can see the repositories you expect.";
}
