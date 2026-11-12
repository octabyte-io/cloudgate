import { useState } from "react";

import { Card } from "@/components/console/card";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  gitProvidersApi,
  type GitProvider,
} from "@/lib/api/endpoints/git-providers";
import { errorMessage } from "@/lib/api/error-message";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { TONE_FILL } from "@/lib/design/status";
import { cn } from "@/lib/utils";

import { providerOf } from "./providers";

/**
 * **Base rows with no strategy row behind them.**
 *
 * This section was built
 * when three of the
 * four strategies filtered their own `list()` by their credential requirements
 * while `POST /` accepted every field as optional. Saving a connection without
 * the App you had not installed yet made it vanish, and it could not be
 * recovered, because the strategy id that `GET /<kind>/:id` and
 * `PATCH /<kind>/:id` need comes only from the list it was missing from.
 *
 * **All four listings are unfiltered now.** An incomplete connection
 * is listed now, opens, and can be completed by editing it — so the routine
 * path into this state is gone and this set is normally empty.
 *
 * It is kept because it is no longer about credentials at all. `GET
 * /git-providers` returns every base row unfiltered, and `create()` writes base
 * and detail in one transaction, so a base row absent from all four kind lists
 * now means the two tables actually disagree — a half-removed connection, a
 * restored backup, a hand-edited row. That is worth naming rather than
 * rendering as nothing, and `DELETE /git-providers/:id` takes the base id, so
 * removing one is still reachable when nothing else can open it.
 *
 * Rendered only when there is one. It is not a warning about a possibility; it
 * is a list of rows that really are in this state.
 */
export function UnlistedConnections({
  unlisted,
}: {
  unlisted: GitProvider[];
}) {
  const invalidate = useInvalidate();
  const [removing, setRemoving] = useState<GitProvider | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // `DELETE /git-providers/:id` is `gitProviders: ['delete']`.
  const canRemove = usePermission({ gitProviders: ["delete"] });

  if (unlisted.length === 0) return null;

  return (
    <>
      <Card>
        <Card.Header
          title={
            unlisted.length === 1
              ? "One connection was saved and is not listed"
              : `${unlisted.length} connections were saved and are not listed`
          }
          sub="These rows exist and no provider listing returns them, which now means the connection's two halves disagree rather than that a credential is missing. Nothing can open one — the only thing left to do with it is remove it and connect again."
          headingLevel={2}
        />
        <Card.Body className="grid gap-2.5">
          {unlisted.map((row) => {
            const descriptor = providerOf(row.providerType);
            return (
              <div
                key={row.gitProviderId}
                className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-block size-2 flex-none rounded-pill",
                      TONE_FILL.warn,
                    )}
                  />
                  <span className="min-w-0 flex-1 basis-40 text-body font-medium wrap-anywhere text-tx">
                    <span className="sr-only">Not listed: </span>
                    {row.name}
                  </span>
                  <span className="text-meta text-tx-2">
                    {descriptor.label}
                  </span>
                  <Button
                    size="sm"
                    variant="dngr"
                    disabled={!canRemove.allowed}
                    title={canRemove.allowed ? undefined : REMOVE_REFUSAL}
                    onClick={() => canRemove.allowed && setRemoving(row)}
                  >
                    Remove
                  </Button>
                </div>
                {/* No per-row "what it is missing" line. It used to name
                    `descriptor.requirement`, which was the cause of this state
                    once and is not the cause now — the card's own sub says
                    what being here means, and a credential note would send
                    someone off to fix the wrong thing. */}
              </div>
            );
          })}
        </Card.Body>
      </Card>

      <Modal
        open={removing !== null}
        onOpenChange={(next) => {
          setRefusal(null);
          if (!next) setRemoving(null);
        }}
      >
        {removing ? (
          <>
            <Modal.Header
              title={`Remove ${removing.name}?`}
              description="This connection is not usable, so nothing is depending on it."
            />
            <Modal.Body>
              <p className="text-body wrap-anywhere text-tx-2">
                It is removed from Cloudgate. Nothing at{" "}
                {providerOf(removing.providerType).label} is changed — the app or
                token you created there is still yours, and you can connect again
                with it.
              </p>
              {refusal ? (
                <p className="rounded-md border border-bad-line bg-bad-tint px-3 py-2.5 text-meta wrap-anywhere text-tx">
                  {refusal}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Modal.Gap />
              <Modal.Close render={<Button type="button">Keep it</Button>} />
              <Button
                type="button"
                variant="dngr"
                disabled={pending}
                aria-busy={pending || undefined}
                onClick={async () => {
                  setRefusal(null);
                  setPending(true);
                  try {
                    await gitProvidersApi.remove(removing.gitProviderId);
                    await invalidate.gitProviders();
                    toast.done(`${removing.name} removed.`);
                    setRemoving(null);
                  } catch (error) {
                    setRefusal(errorMessage(error));
                  } finally {
                    setPending(false);
                  }
                }}
              >
                Remove connection
              </Button>
            </Modal.Footer>
          </>
        ) : null}
      </Modal>
    </>
  );
}

const REMOVE_REFUSAL = roleRefusal("remove a git connection");
