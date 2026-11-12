import { useState } from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  cloudNameOf,
  onGoogleCloud,
  isGoogleLeftover,
  type ApplicationDetail,
  type CloudDelete,
  type CloudLeftover,
  type GoogleCloudLeftover,
} from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";
import type { Mark } from "@/lib/design/status";

import {
  APPLICATION_DELETE_REFUSAL,
  useCloudDeleteActions,
} from "../use-application";

/**
 * Forget's warning, the backend's `FORGET_WARNING` (ADR-0038): what
 * is left may still bill, and only the audit log keeps the list.
 */
export const FORGET_WARNING =
  "Forget drops this Service from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in AWS until you remove it there.";

/** {@link FORGET_WARNING} on Google Cloud, the backend's `GOOGLE_FORGET_WARNING`. */
export const GOOGLE_FORGET_WARNING =
  "Forget drops this Service from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in Google Cloud until you remove it there.";

/** The status a cloud Delete gives its Service, in place of `applicationStatus`. */
export function cloudDeleteMark(record: CloudDelete): Mark {
  return record.status === "deleting"
    ? { glyph: "◐", tone: "warn", label: "deleting" }
    : { glyph: "✕", tone: "bad", label: "delete incomplete" };
}

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
    id: "tag",
    head: "Cloudgate tag",
    cell: (row) =>
      row.tag ? (
        <span className="font-mono">{row.tag}</span>
      ) : (
        "None: AWS made it"
      ),
    tone: "wrap",
  },
];

/** A Google Cloud leftover's columns: type, Google name, region, label. */
const GOOGLE_COLUMNS: Column<GoogleCloudLeftover>[] = [
  { id: "type", head: "Type", cell: (row) => row.type, tone: "key" },
  {
    id: "googleName",
    head: "Google name",
    cell: (row) => <span className="font-mono">{row.googleName}</span>,
    tone: "wrap",
  },
  { id: "region", head: "Region", cell: (row) => row.region },
  {
    id: "label",
    head: "Cloudgate label",
    cell: (row) =>
      row.label ? (
        <span className="font-mono">{row.label}</span>
      ) : (
        "None: found by its name"
      ),
    tone: "wrap",
  },
];

/** Why one is left, when the Delete stopped short of it on purpose. */
function whyLeft(row: { because?: "partly-emptied" }): string {
  return row.because === "partly-emptied"
    ? "Partly emptied: it still holds files"
    : "Should have gone";
}

const WHY: Column<CloudLeftover> = {
  id: "why",
  head: "Why",
  cell: whyLeft,
  tone: "wrap",
};

/** {@link WHY} on Google Cloud: a static site's bucket left partly emptied. */
const GOOGLE_WHY: Column<GoogleCloudLeftover> = {
  id: "why",
  head: "Why",
  cell: whyLeft,
  tone: "wrap",
};

/**
 * A cloud Service's Delete, while it runs and when it could not finish
 * (ADR-0038).
 *
 * - **Deleting**: its destroy-only Cloud run is queued or running, recorded
 *   as a Deployment whose log is on this page. Nothing to press: the run is
 *   ended from its Deployment (Stop the run), like a deploy's.
 * - **Delete incomplete**: the run left something in AWS, or did not
 *   finish. Each leftover is listed with its type, AWS id, region and
 *   Cloudgate's tag, and the only ways out are **Retry**, which destroys
 *   again from the kept state, and **Forget**, which drops the Service after
 *   warning that what is left may still bill. Both need `service: delete`,
 *   the Delete's own statement. Deploy and Start are refused meanwhile.
 *
 * On Google Cloud each leftover is listed by type, Google name,
 * region and Cloudgate's label, and Retry starts again from the network
 * step, which takes the Service's Domains off the Environment network.
 */
export function CloudDeleteCard({
  application,
}: {
  application: ApplicationDetail;
}) {
  const record = application.cloudDelete;
  const router = useRouter();
  const permission = usePermission({ service: ["delete"] });
  const actions = useCloudDeleteActions(
    application.applicationId,
    application.environmentId,
  );
  const [forgetting, setForgetting] = useState(false);
  if (!record) return null;

  const busy = actions.retry.isPending || actions.forget.isPending;
  const cloudName = application.cloudPlace
    ? cloudNameOf(application.cloudPlace)
    : "AWS";
  const google = onGoogleCloud(application.cloudPlace);
  const awsLeft = record.left.filter(
    (one): one is CloudLeftover => !isGoogleLeftover(one),
  );
  const googleLeft = record.left.filter(isGoogleLeftover);
  // A static site's bucket whose emptying stopped partway.
  const partlyEmptied = record.left.some(
    (one) => one.because === "partly-emptied",
  );
  const refused = !permission.allowed;

  if (record.status === "deleting") {
    return (
      <Card className="border-warn-line">
        <Card.Header
          title={`Deleting ${application.name}`}
          sub="A Cloud run is destroying it in its Cloud account."
          headingLevel={2}
        />
        <Card.Body>
          <p className="max-w-lede text-body text-tx-2">
            Its Deployment log shows what is destroyed. Once {cloudName} is
            checked and nothing is left, this Service, its Deployments and its
            Infrastructure state go. If anything is left, it stays here as
            Delete incomplete, listing what.
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
              ? `${record.left.length} ${record.left.length === 1 ? "resource is" : "resources are"} still in ${cloudName}, and may still bill.`
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
            left, so it cannot be deployed or started.{" "}
            {google
              ? partlyEmptied
                ? "Retry starts again from the network step: it takes its Domains off the Environment network, empties its bucket again, then destroys it, and searches Google Cloud again."
                : "Retry starts again from the network step: it takes its Domains off the Environment network, destroys again from that state, and searches Google Cloud again."
              : partlyEmptied
                ? "Retry empties its bucket again, then destroys it."
                : "Retry destroys again from that state."}
          </p>
          {refused ? (
            <p className="text-meta text-tx-2">{APPLICATION_DELETE_REFUSAL}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={refused || busy}
              title={refused ? APPLICATION_DELETE_REFUSAL : undefined}
              onClick={() =>
                void actions.retry
                  .mutateAsync()
                  .then(() =>
                    toast.done(`Deleting ${application.name} again.`, {
                      description:
                        "A new Cloud run destroys what its state still holds.",
                    }),
                  )
                  .catch((error: unknown) => toast.error(error))
              }
            >
              Retry
            </Button>
            <Button
              variant="dngr"
              disabled={refused || busy}
              title={refused ? APPLICATION_DELETE_REFUSAL : undefined}
              onClick={() => setForgetting(true)}
            >
              Forget
            </Button>
          </div>
        </Card.Body>
        {awsLeft.length > 0 ? (
          <Card.Body flush>
            <DataTable
              label={`What the Delete of ${application.name} left in AWS`}
              rows={awsLeft}
              columns={partlyEmptied ? [...COLUMNS, WHY] : COLUMNS}
              getRowId={(row) => `${row.type}:${row.awsId}`}
            />
          </Card.Body>
        ) : null}
        {googleLeft.length > 0 ? (
          <Card.Body flush>
            <DataTable
              label={`What the Delete of ${application.name} left in Google Cloud`}
              rows={googleLeft}
              columns={
                partlyEmptied ? [...GOOGLE_COLUMNS, GOOGLE_WHY] : GOOGLE_COLUMNS
              }
              getRowId={(row) => `${row.type}:${row.region}:${row.googleName}`}
            />
          </Card.Body>
        ) : null}
      </Card>

      <Modal open={forgetting} onOpenChange={setForgetting}>
        <Modal.Header
          title={`Forget ${application.name}?`}
          description={`Cloudgate stops tracking what its Delete left in ${cloudName}.`}
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            {google ? GOOGLE_FORGET_WARNING : FORGET_WARNING}
          </p>
          {record.left.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-meta text-tx-2">
              {record.left.map((one) => {
                const name = isGoogleLeftover(one) ? one.googleName : one.awsId;
                return (
                  <li
                    key={`${one.type}:${one.region}:${name}`}
                    className="wrap-anywhere"
                  >
                    {one.type} {name} ({one.region})
                  </li>
                );
              })}
            </ul>
          ) : null}
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
                  toast.done(`${application.name} forgotten.`, {
                    description: `What it left is listed in the audit log. Remove it in ${cloudName} to stop paying for it.`,
                  });
                  router.push(`/environments/${application.environmentId}`);
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
