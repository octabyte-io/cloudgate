import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Skeleton } from "@/components/console/skeleton";
import {
  TeardownReportModal,
  useTeardownReport,
} from "@/components/console/teardown-report-modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { isPullRequestPreview } from "@/lib/api/endpoints/preview-deployments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import { previewColumns } from "../advanced/preview-columns";
import type {
  usePreviewDeployments,
  usePreviewMutations,
} from "../advanced/use-advanced";

const REDEPLOY_REFUSAL = roleRefusal("rebuild a preview");
const TEAR_DOWN_REFUSAL = roleRefusal("tear a preview down");

/**
 * The pull-request previews that are open right now.
 *
 * This half works completely — four real routes, and the row carries the pull
 * request it belongs to, the branch it builds, the isolated service name it runs
 * under and the host it answers on. The strip above the table says the thing the
 * limit on the card above is counting: each of these is a **separate service**,
 * with its own container and its own volumes.
 *
 * **The strip says when every slot is taken, which is the most this screen can
 * say about a refused pull request**.
 * A pull request turned away by the limit used to be told nothing anywhere; it
 * is now told on the pull request itself, which is where the person who opened
 * it is. What it cannot be is a *row* here: `ensurePreview` writes nothing when
 * it refuses, so there is no record of the refused pull request for this table
 * to list — naming one would take a column this table does not have. So the
 * screen answers the question it can answer from what it holds, which is
 * whether the next pull request will be refused, and says it in the same
 * sentence as the limit it follows from.
 *
 * **A limit of 0 is a different sentence and it lives in the empty state**,
 * because that is the only place it can be read. Previews on and "Most previews
 * at once" at 0 refuses every pull request and writes no preview, so there are
 * no rows, so the strip above is not rendered at all — the one state the
 * refusal matters most in was the one state this screen said nothing in. The
 * empty table already explains itself (no pull request is open, previews are
 * off); the limit is the third reason it can be empty, and it is the reason
 * that makes the first one's invitation false. `PreviewDeploymentsService`'s
 * own zero arm tells the pull request the same thing — that the setting allows
 * none, and that raising it and pushing again is what builds one — so the two
 * readers are told one behaviour rather than two.
 */
export function PreviewListCard({
  previews,
  mutations,
  active,
  limit,
}: {
  previews: ReturnType<typeof usePreviewDeployments>;
  mutations: ReturnType<typeof usePreviewMutations>;
  /** Whether previews are switched on, which decides what an empty table means. */
  active: boolean;
  /** "Most previews at once", which is what the open rows are counted against. */
  limit: number;
}) {
  // Pull-request previews only: this card counts them against "Most previews
  // at once" and links each to its pull request, and a Requested preview has
  // neither a pull request nor a slot under that limit; they have a
  // card of their own.
  const rows = (previews.data ?? []).filter(isPullRequestPreview);
  const teardown = useTeardownReport();
  // Redeploy's and Delete's decorators.
  const canCreate = usePermission({ deployment: ["create"] });
  const canCancel = usePermission({ deployment: ["cancel"] });
  // `>=` rather than `===`: lowering the limit below the open count leaves more
  // previews running than the limit allows, and every one of those states
  // refuses the next pull request exactly the same way.
  const atLimit = rows.length >= limit;
  // A limit of 0 refuses every pull request rather than the next one, and it is
  // the arm where "tearing one down frees a slot" is false — tearing every
  // preview down frees nothing. `active` guards it because previews switched
  // off is the plainer reason for the same silence and the one to say first.
  const refusesEvery = active && limit === 0;

  return (
    <>
      <Card>
        <Card.Header
          title="Pull-request previews"
          sub={
            rows.length > 0
              ? `${rows.length} running from ${rows.length === 1 ? "one pull request" : "open pull requests"}.`
              : undefined
          }
          headingLevel={2}
        />

        {previews.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">
              {errorMessage(previews.error)}
            </p>
          </Card.Body>
        ) : previews.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <>
            {rows.length > 0 ? (
              <MetaStrip>
                Each of these is a <strong>separate service</strong> beside this
                Application, with its own container and its own volumes, which
                is what the limit above counts. Tearing one down removes the
                service, the code cloned for it and the image built for it.
                {refusesEvery ? (
                  <>
                    {" "}
                    <strong>Every pull request is refused.</strong>{" "}
                    &ldquo;Most previews at once&rdquo; is 0, so nothing new is
                    built for one however many of these are torn down, and the
                    pull request is told so. Raise the limit above and push
                    again for a preview.
                  </>
                ) : atLimit ? (
                  <>
                    {" "}
                    <strong>Every slot is taken.</strong> A pull request opened
                    now is refused rather than queued, and told so on the pull
                    request; it gets a preview the next time it is pushed to,
                    once one of these has been torn down.
                  </>
                ) : null}
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label="Open preview deployments"
                rows={rows}
                getRowId={(item) => item.previewDeploymentId}
                defaultSort={{ id: "createdAt", dir: "desc" }}
                columns={previewColumns({
                  actions: (item) => (
                    <>
                      <Button
                        size="xs"
                        disabled={
                          !canCreate.allowed || mutations.redeploy.isPending
                        }
                        title={canCreate.allowed ? undefined : REDEPLOY_REFUSAL}
                        onClick={async () => {
                          try {
                            await mutations.redeploy.mutateAsync(
                              item.previewDeploymentId,
                            );
                            toast.done(
                              `Rebuilding the preview for #${item.pullRequestNumber}.`,
                              {
                                description: `From the head of ${item.branch}.`,
                              },
                            );
                          } catch (error) {
                            toast.error(error);
                          }
                        }}
                      >
                        Redeploy
                      </Button>
                      <Button
                        size="xs"
                        variant="dngr"
                        disabled={
                          !canCancel.allowed || mutations.remove.isPending
                        }
                        title={canCancel.allowed ? undefined : TEAR_DOWN_REFUSAL}
                        onClick={async () => {
                          try {
                            const clean = await teardown.runDelete(() =>
                              mutations.remove.mutateAsync(
                                item.previewDeploymentId,
                              ),
                            );
                            // A preview's own tree is its parent's file — a
                            // teardown that could not remove it leaves the last
                            // copy on the run Server, and the row it belonged
                            // to is gone.
                            if (clean) {
                              toast.done(
                                `Preview for #${item.pullRequestNumber} torn down.`,
                              );
                            }
                          } catch (error) {
                            toast.error(error);
                          }
                        }}
                      >
                        Tear down
                      </Button>
                    </>
                  ),
                })}
                empty={
                  <EmptyState
                    icon="branch"
                    title={
                      !active
                        ? "Previews are off for this Application"
                        : refusesEvery
                          ? "Every pull request is refused"
                          : "No pull request is open"
                    }
                  >
                    {!active
                      ? "Turn them on above, give them a wildcard host, and every open pull request gets a running copy of this Application to look at."
                      : refusesEvery
                        ? 'Raise the limit above and push again for a preview. “Most previews at once” is 0, so a pull request is refused rather than queued, and told so on the pull request.'
                        : "Open one against this Application's tracked branch and a preview is built for it, on its own host under the wildcard above."}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <TeardownReportModal
        report={teardown.report}
        serviceName="This preview"
        open={teardown.open}
        onOpenChange={teardown.setOpen}
      />
    </>
  );
}
