import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { useWebServerSettings } from "@/lib/api/use-web-server-settings";
import { errorMessage } from "@/lib/api/error-message";
import type {
  PreviewDeleted,
  PreviewDeployment,
  RequestedPreview,
} from "@/lib/api/endpoints/preview-deployments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import type {
  usePreviewDeployments,
  usePreviewMutations,
} from "../advanced/use-advanced";
import { ExtendPreviewModal } from "./extend-preview-modal";
import { requestedPreviewColumns } from "./requested-preview-columns";

/**
 * The backend's own switch refusal (`REQUESTED_PREVIEWS_NOT_ALLOWED`), which
 * extend and redeploy answer while the switch is off — so the control says it
 * before it is pressed, in the same words.
 */
const SWITCH_REFUSAL = "Requested previews are not allowed on this Application.";
const EXTEND_REFUSAL = roleRefusal("extend a preview");
const REDEPLOY_REFUSAL = roleRefusal("rebuild a preview");
const EXPIRE_REFUSAL = roleRefusal("expire a preview");

const isRequested = (row: PreviewDeployment): row is RequestedPreview =>
  row.trigger === "requested";

/**
 * The Requested previews an Application holds (ADR-0026), beside the
 * Pull-request previews card and never mixed into it.
 *
 * **A live preview nobody can see is one nobody kills**, so every one is
 * listed until its running copy is really gone — an expired one included,
 * read as *expired, teardown pending* and with no controls, because nothing
 * more can be done to it.
 *
 * **Expire now is Delete.** `DELETE /preview-deployments/:id` on a Requested
 * preview marks it expired and answers at once; the sweep tears it down
 * within the minute. The row flips on that answer, not on a re-read, so the
 * screen never shows a preview the operator has just killed as live.
 *
 * **The switch stops rebuilds, not the previews.** Turning requested previews
 * off leaves the live ones running to their expiry, so with the switch off
 * Extend and Redeploy carry the switch's refusal and Expire now stays — it is
 * the one way left to stop one sooner, and the strip says so.
 */
export function RequestedPreviewsCard({
  applicationId,
  previews,
  mutations,
  allowed,
  limit,
}: {
  applicationId: string;
  previews: ReturnType<typeof usePreviewDeployments>;
  mutations: ReturnType<typeof usePreviewMutations>;
  /** `requestedPreviewsAllowed`, the Application's switch. */
  allowed: boolean;
  /** `requestedPreviewLimit`, which every requested row counts against. */
  limit: number;
}) {
  // `deployment: ['create']` is extend's and redeploy's decorator, and
  // `deployment: ['cancel']` is Delete's.
  const canCreate = usePermission({ deployment: ["create"] });
  const canCancel = usePermission({ deployment: ["cancel"] });
  const settings = useWebServerSettings();
  const [extending, setExtending] = useState<RequestedPreview | null>(null);
  // Delete's answers, by id: the expired row as the backend wrote it, laid
  // over the list until the list's own re-read carries it too.
  const [expiredNow, setExpiredNow] = useState<Record<string, PreviewDeleted>>(
    {},
  );

  const rows = (previews.data ?? [])
    .filter(isRequested)
    .map((row) => {
      const answer = expiredNow[row.previewDeploymentId];
      return answer && row.expiredAt === null
        ? {
            ...row,
            expiresAt: answer.expiresAt ?? row.expiresAt,
            expiredAt: answer.expiredAt,
            expiryCause: answer.expiryCause,
          }
        : row;
    });
  const live = rows.filter((row) => row.expiredAt === null);
  // Every row counts, expired ones too, until the sweep deletes it.
  const atLimit = rows.length >= limit;

  // The role first: a caller who could not extend with the switch on is told
  // that, not about a switch they could not flip back either.
  const createRefusal = (roleSentence: string) =>
    !canCreate.allowed ? roleSentence : !allowed ? SWITCH_REFUSAL : undefined;

  const expire = async (row: RequestedPreview) => {
    try {
      const answer = await mutations.remove.mutateAsync(row.previewDeploymentId);
      if (answer && answer.expiredAt) {
        setExpiredNow((held) => ({ ...held, [row.previewDeploymentId]: answer }));
      }
      toast.done(`The preview of ${row.branch} has expired.`, {
        description: "Its copy is torn down within the minute.",
      });
    } catch (error) {
      toast.error(error);
    }
  };

  const redeploy = async (row: RequestedPreview) => {
    try {
      await mutations.redeploy.mutateAsync(row.previewDeploymentId);
      toast.done(`Rebuilding the preview of ${row.branch}.`, {
        description: "Its expiry stays where it is.",
      });
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <>
      <Card>
        <Card.Header
          title="Requested previews"
          sub={
            rows.length > 0
              ? `${rows.length} of at most ${limit}, each asked for from a branch and gone at its expiry.`
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
            </div>
          </Card.Body>
        ) : (
          <>
            {rows.length > 0 ? (
              <MetaStrip>
                {!allowed && live.length > 0 ? (
                  <>
                    <strong>Requested previews are off.</strong> These run
                    until they expire; delete one to stop it now.
                  </>
                ) : (
                  <>
                    Each of these is a <strong>separate service</strong>{" "}
                    beside this Application, built from the branch it was asked
                    for and torn down at its expiry.
                  </>
                )}
                {atLimit ? (
                  <>
                    {" "}
                    <strong>Every slot is taken.</strong> A request made now is
                    refused and told the soonest expiry; expiring one now frees
                    its slot once its teardown finishes.
                  </>
                ) : null}
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label="Requested preview deployments"
                rows={rows}
                getRowId={(row) => row.previewDeploymentId}
                defaultSort={{ id: "createdAt", dir: "desc" }}
                columns={requestedPreviewColumns({
                  applicationId,
                  actions: (row) => (
                    <>
                      <Button
                        size="xs"
                        disabled={
                          !canCreate.allowed ||
                          !allowed ||
                          mutations.extend.isPending
                        }
                        title={createRefusal(EXTEND_REFUSAL)}
                        onClick={() => setExtending(row)}
                      >
                        Extend
                      </Button>
                      <Button
                        size="xs"
                        disabled={
                          !canCreate.allowed ||
                          !allowed ||
                          mutations.redeploy.isPending
                        }
                        title={createRefusal(REDEPLOY_REFUSAL)}
                        onClick={() => redeploy(row)}
                      >
                        Redeploy
                      </Button>
                      <Button
                        size="xs"
                        variant="dngr"
                        disabled={
                          !canCancel.allowed || mutations.remove.isPending
                        }
                        title={canCancel.allowed ? undefined : EXPIRE_REFUSAL}
                        onClick={() => expire(row)}
                      >
                        Expire now
                      </Button>
                    </>
                  ),
                })}
                empty={
                  <EmptyState
                    icon="branch"
                    title={
                      allowed
                        ? "No requested preview is running"
                        : "Requested previews are off for this Application"
                    }
                  >
                    {allowed
                      ? "Whoever may deploy this Application, an Agent included, can ask for a copy of it built from a branch. It runs on its own host under the wildcard above until it expires."
                      : "Turn on “Allow requested previews” above and an Agent, or anyone who may deploy this Application, can ask for a copy of it built from a branch."}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      {extending ? (
        <ExtendPreviewModal
          key={extending.previewDeploymentId}
          branch={extending.branch}
          maxMinutes={settings.data?.requestedPreviewMaxTtlMinutes}
          extend={async (ttlMinutes) => {
            await mutations.extend.mutateAsync({
              id: extending.previewDeploymentId,
              ttlMinutes,
            });
            toast.done(`The preview of ${extending.branch} is extended.`, {
              description: `It now expires ${ttlMinutes} minutes from now.`,
            });
          }}
          open
          onOpenChange={(open) => {
            if (!open) setExtending(null);
          }}
        />
      ) : null}
    </>
  );
}
