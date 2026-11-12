import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { useForgetVisited } from "@/components/shell/recents";
import { Button } from "@/components/ui/button";
import type { CloudLeftover } from "@/lib/api/endpoints/applications";
import { bucketsApi, type Bucket } from "@/lib/api/endpoints/buckets";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

/** Forget's warning, the backend's: what is left may still bill. */
export const BUCKET_FORGET_WARNING =
  "Forget drops this bucket from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in AWS until you remove it there.";

const REFUSAL = "Retry and Forget need service: delete, as the Delete does.";

const COLUMNS: Column<CloudLeftover>[] = [
  { id: "type", head: "Type", cell: (row) => row.type, tone: "key" },
  {
    id: "awsId",
    head: "AWS id",
    cell: (row) => <span className="font-mono">{row.awsId}</span>,
    tone: "wrap",
  },
  { id: "region", head: "Region", cell: (row) => row.region },
  {
    id: "why",
    head: "Why",
    cell: (row) =>
      row.because === "partly-emptied"
        ? "Partly emptied: it still holds files"
        : "Should have gone",
    tone: "wrap",
  },
];

/**
 * A bucket on AWS's Delete, while it runs and when it could not finish
 * (ADR-0038).
 *
 * - **Deleting**: its destroy-only Cloud run is queued or running — after
 *   emptying it, when its Delete asked for its files to go.
 * - **Delete incomplete**: emptying stopped partway, so the bucket is left
 *   "partly emptied" with nothing destroyed, or the run left something or
 *   did not finish. **Retry** runs it again (emptying again when asked);
 *   **Forget** drops the bucket after warning that what is left may bill.
 *   Both need `service: delete`.
 */
export function BucketCloudDeleteCard({ bucket }: { bucket: Bucket }) {
  const record = bucket.cloudDelete;
  const router = useRouter();
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  const permission = usePermission({ service: ["delete"] });
  const [forgetting, setForgetting] = useState(false);
  const retry = useMutation({
    mutationFn: () => bucketsApi.retryDelete(bucket.bucketId),
    onSettled: () => invalidate.bucket(bucket.bucketId),
  });
  const forget = useMutation({
    mutationFn: () => bucketsApi.forgetDelete(bucket.bucketId),
    onSuccess: () => {
      forgetVisited([bucket.bucketId]);
      return invalidate.environment({
        environmentId: bucket.environmentId,
        projectId: bucket.environment.project.projectId,
      });
    },
  });
  if (!record) return null;

  const busy = retry.isPending || forget.isPending;
  const refused = !permission.allowed;

  if (record.status === "deleting") {
    return (
      <Card className="border-warn-line">
        <Card.Header
          title={`Deleting ${bucket.name}`}
          sub={
            record.deleteFiles
              ? "A Cloud run is emptying it, then destroying it."
              : "A Cloud run is destroying it in its Cloud account."
          }
          headingLevel={2}
        />
        <Card.Body>
          <p className="max-w-lede text-body text-tx-2">
            Once AWS is checked and nothing is left, this bucket and its
            Infrastructure state go. If emptying stops partway, or anything is
            left, it stays here as Delete incomplete, listing what.
          </p>
        </Card.Body>
      </Card>
    );
  }

  return (
    <>
      <Card className="border-bad-line">
        <Card.Header
          title="Delete incomplete"
          sub={
            record.left.length > 0
              ? `${record.left.length} ${record.left.length === 1 ? "resource is" : "resources are"} still in AWS, and may still bill.`
              : "The Delete did not finish."
          }
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-3">
          {record.unfinished ? (
            <p className="max-w-lede text-body text-tx-2">
              {record.unfinished}
            </p>
          ) : null}
          <p className="max-w-lede text-body text-tx-2">
            Its Infrastructure state is kept, because it still describes what is
            left.{" "}
            {record.deleteFiles
              ? "Retry empties the bucket again, then destroys it."
              : "Retry destroys again from that state."}
          </p>
          {refused ? <p className="text-meta text-tx-2">{REFUSAL}</p> : null}
          <div className="flex gap-2">
            <Button
              disabled={refused || busy}
              title={refused ? REFUSAL : undefined}
              onClick={() =>
                void retry
                  .mutateAsync()
                  .then(() => toast.done(`Deleting ${bucket.name} again.`))
                  .catch((error: unknown) => toast.error(error))
              }
            >
              Retry
            </Button>
            <Button
              variant="dngr"
              disabled={refused || busy}
              title={refused ? REFUSAL : undefined}
              onClick={() => setForgetting(true)}
            >
              Forget
            </Button>
          </div>
        </Card.Body>
        {record.left.length > 0 ? (
          <Card.Body flush>
            <DataTable
              label={`What the Delete of ${bucket.name} left in AWS`}
              rows={record.left}
              columns={COLUMNS}
              getRowId={(row) => `${row.type}:${row.awsId}`}
            />
          </Card.Body>
        ) : null}
      </Card>

      <Modal open={forgetting} onOpenChange={setForgetting}>
        <Modal.Header
          title={`Forget ${bucket.name}?`}
          description="Cloudgate stops tracking what its Delete left in AWS."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">{BUCKET_FORGET_WARNING}</p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Keep it</Button>} />
          <Button
            type="button"
            variant="dngr"
            disabled={refused || busy}
            onClick={() =>
              void forget
                .mutateAsync()
                .then(() => {
                  setForgetting(false);
                  toast.done(`${bucket.name} forgotten.`, {
                    description:
                      "What it left is listed in the audit log. Remove it in AWS to stop paying for it.",
                  });
                  router.push(`/environments/${bucket.environmentId}`);
                })
                .catch((error: unknown) => toast.error(error))
            }
          >
            Forget
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
