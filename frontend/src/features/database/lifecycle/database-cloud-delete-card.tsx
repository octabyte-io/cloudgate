import { useState } from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/console/card";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { usePermission } from "@/lib/auth/use-permission";

import { FORGET_WARNING } from "../../application/lifecycle/cloud-delete-card";
import { useDatabaseCloudDeleteActions } from "../use-cloud-delete";
import { DATABASE_DELETE_REFUSAL } from "../use-database";

/**
 * A cloud database's Delete, while it runs and when it could not finish
 * (ADR-0038), as
 * a cloud Service's is: **Deleting** while its destroy-only Cloud run
 * is queued or running, naming the final snapshot it keeps (or saying its data
 * goes); **Delete incomplete** once it left something in AWS or did not
 * finish, listing each leftover, with **Retry** — which keeps the snapshot the
 * Delete named — and **Forget**, after warning what may still bill. Both need
 * `service: delete`, the Delete's own statement.
 */
export function DatabaseCloudDeleteCard({
  database,
  kind,
}: {
  database: Database;
  kind: DatabaseKind;
}) {
  const record = database.cloudDelete;
  const router = useRouter();
  const permission = usePermission({ service: ["delete"] });
  const actions = useDatabaseCloudDeleteActions(
    kind,
    database.databaseId,
    database.environmentId,
  );
  const [forgetting, setForgetting] = useState(false);
  if (!record) return null;

  const busy = actions.retry.isPending || actions.forget.isPending;
  const refused = !permission.allowed;
  const keeps = record.finalSnapshot
    ? `It keeps a final snapshot, ${record.finalSnapshot}, until you delete it in AWS.`
    : "Its data is deleted for good: no final snapshot is taken.";

  if (record.status === "deleting") {
    return (
      <Card className="border-warn-line">
        <Card.Header
          title={`Deleting ${database.name}`}
          sub="A Cloud run is destroying it in its Cloud account."
          headingLevel={2}
        />
        <Card.Body>
          <p className="max-w-lede text-body text-tx-2">
            {keeps} Its Deployment log shows what is destroyed. Once AWS is
            checked and nothing is left, this database and its Infrastructure
            state go.
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
            {keeps} Its Infrastructure state is kept, because it still describes
            what is left. Retry destroys again from that state.
          </p>
          {record.left.length > 0 ? (
            <ul
              aria-label={`What the Delete of ${database.name} left in AWS`}
              className="list-disc pl-5 text-meta text-tx-2"
            >
              {record.left.map((one) => (
                <li key={`${one.type}:${one.awsId}`} className="wrap-anywhere">
                  {one.type} <span className="font-mono">{one.awsId}</span> (
                  {one.region}
                  {one.tag ? `, ${one.tag}` : ""})
                </li>
              ))}
            </ul>
          ) : null}
          {refused ? (
            <p className="text-meta text-tx-2">{DATABASE_DELETE_REFUSAL}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={refused || busy}
              title={refused ? DATABASE_DELETE_REFUSAL : undefined}
              onClick={() =>
                void actions.retry
                  .mutateAsync()
                  .then(() => toast.done(`Deleting ${database.name} again.`))
                  .catch((error: unknown) => toast.error(error))
              }
            >
              Retry
            </Button>
            <Button
              variant="dngr"
              disabled={refused || busy}
              title={refused ? DATABASE_DELETE_REFUSAL : undefined}
              onClick={() => setForgetting(true)}
            >
              Forget
            </Button>
          </div>
        </Card.Body>
      </Card>

      <Modal open={forgetting} onOpenChange={setForgetting}>
        <Modal.Header
          title={`Forget ${database.name}?`}
          description="Cloudgate stops tracking what its Delete left in AWS."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">{FORGET_WARNING}</p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Keep it</Button>} />
          <Button
            type="button"
            variant="dngr"
            disabled={refused || busy}
            onClick={() =>
              void actions.forget
                .mutateAsync()
                .then(() => {
                  setForgetting(false);
                  toast.done(`${database.name} forgotten.`, {
                    description:
                      "What it left is listed in the audit log. Remove it in AWS to stop paying for it.",
                  });
                  router.push(`/environments/${database.environmentId}`);
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
