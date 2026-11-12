import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { RowTime } from "@/components/console/rows/cells";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ApiKey } from "@/lib/api/endpoints/users";
import { useArrival } from "@/components/console/use-arrival";

import { CreateApiKeyModal } from "./create-api-key-modal";
import { DeleteApiKeyModal } from "./delete-api-key-modal";
import { useApiKeys } from "./use-account";

/**
 * Personal keys (formerly API keys), built around the one fact
 * that shapes the whole card: **the secret exists in exactly one HTTP response,
 * ever.**
 *
 * better-auth hashes the key on the way in and the listing carries only `start`
 * — the first few characters — so there is no reveal control here and there
 * could not be one. Every screen in this product that shows a credential has had
 * to decide what to do about that (F13 reveals a *public* key permanently
 * because there is no private one to show; F15 leaves an edit dialog's secret box
 * empty because blank means "keep"); this is the version where the honest answer
 * is a dialog that says "copy this now" and means it.
 *
 * **What a key can do is not shown, because nothing records it.** An api-key
 * session carries no `activeOrganizationId` — `organizations.service.getActive`
 * falls back to the caller's *default* membership for exactly that reason — so a
 * key acts as the whole person in whichever Organization happens to be their
 * default. A "scopes" column would be inventing a boundary that is not enforced.
 * The card says this in one sentence instead, under its title.
 *
 * **The footer says the other half:** a key cannot manage keys, which is
 * what makes Revoke here a revocation. Why is at the backend's `createAuth`
 * `disabledPaths`.
 *
 * This paragraph used to open by conceding that `rbac/access-control.ts` "has an
 * `api: ['read']` statement" before arguing that it changed nothing. It no longer
 * does: the statement was deleted, because it was declared, granted by owner and admin, and consulted
 * by no route — the three `/users/me/api-keys` routes are authorized by the
 * caller's own session on their own user row, and the sentence above is why
 * pointing them at a statement was the wrong repair.
 */
export function ApiKeysCard() {
  const keys = useApiKeys();
  const arrival = useArrival(keys.isPending);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);

  const rows = keys.data ?? [];

  return (
    <Card>
      <Card.Header
        title="Personal keys"
        sub="For scripts and CI. A personal key acts as you: everything you can do, in your default Organization."
        headingLevel={2}
        actions={
          <Button size="sm" variant="pri" onClick={() => setCreating(true)}>
            Create a key
          </Button>
        }
      />
      {keys.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : keys.error ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(keys.error)}</p>
        </Card.Body>
      ) : (
        <Card.Body flush className={arrival}>
          <DataTable<ApiKey>
            label="Your personal keys"
            rows={rows}
            getRowId={(row) => row.id}
            empty={
              <EmptyState
                icon="key"
                title="No personal keys yet"
                action={
                  <Button
                    size="sm"
                    variant="pri"
                    onClick={() => setCreating(true)}
                  >
                    Create a key
                  </Button>
                }
              >
                A key lets a script sign in as you without your password. It is
                shown once, when it is created.
              </EmptyState>
            }
            columns={[
              {
                id: "name",
                head: "Name",
                tone: "key",
                cell: (row) => row.name ?? <Dash word="Unnamed" />,
              },
              {
                id: "start",
                head: "Starts with",
                cell: (row) =>
                  row.start ? (
                    <Chip variant="mono">{row.start}…</Chip>
                  ) : (
                    <Dash word="Unknown" />
                  ),
              },
              {
                id: "created",
                head: "Created",
                cell: (row) => <RowTime iso={row.createdAt} />,
                compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
              },
              {
                id: "used",
                head: "Last used",
                // The Agent key list's words for the same fact, not a
                // bare dash that reads as "unknown".
                cell: (row) =>
                  row.lastRequest ? (
                    <RowTime iso={row.lastRequest} />
                  ) : (
                    "Never used"
                  ),
              },
              {
                id: "expires",
                head: "Expires",
                cell: (row) =>
                  row.expiresAt ? (
                    <RowTime iso={row.expiresAt} />
                  ) : (
                    <Dash word="Never" />
                  ),
              },
              {
                id: "actions",
                head: <span className="sr-only">Actions</span>,
                className: "w-20 text-right",
                cell: (row) => (
                  <Button
                    type="button"
                    size="xs"
                    variant="dngr"
                    onClick={() => setDeleting(row)}
                  >
                    Revoke
                  </Button>
                ),
              },
            ]}
          />
        </Card.Body>
      )}
      <Card.Footer>
        Keys are managed only from a signed-in console session. A key cannot
        create, list or revoke keys, so revoking one here stops whoever holds
        it.
      </Card.Footer>

      {creating ? (
        <CreateApiKeyModal key="create" open onOpenChange={setCreating} />
      ) : null}
      <DeleteApiKeyModal
        apiKey={deleting}
        open={deleting !== null}
        onOpenChange={(next: boolean) => {
          if (!next) setDeleting(null);
        }}
      />
    </Card>
  );
}
