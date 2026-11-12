import { useState } from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { DnsRecords } from "@/components/console/dns-records";
import {
  isGoogleLeftover,
  type CloudLeftover,
  type GoogleCloudLeftover,
} from "@/lib/api/endpoints/applications";
import type {
  Environment,
  EnvironmentDelete,
} from "@/lib/api/endpoints/environments";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";
import { usePermission } from "@/lib/auth/use-permission";
import { planCloudName } from "@/features/project/environment-plan-card";

import {
  ENVIRONMENT_DELETE_REFUSAL,
  useEnvironmentCloudDeleteActions,
} from "./use-environments";
import { CLOUD_NAMES } from "@/lib/api/endpoints/cloud-accounts";

/**
 * Forget's warning, the backend's `ENVIRONMENT_FORGET_WARNING`
 * (ADR-0038): what is left may still bill, and only the audit log keeps the
 * list.
 */
export const ENVIRONMENT_FORGET_WARNING =
  "Forget drops this Environment from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in AWS until you remove it there.";

/** {@link ENVIRONMENT_FORGET_WARNING} on Google Cloud, the backend's `GOOGLE_ENVIRONMENT_FORGET_WARNING`. */
export const GOOGLE_ENVIRONMENT_FORGET_WARNING =
  "Forget drops this Environment from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in Google Cloud until you remove it there.";

/** A leftover in AWS, with whose it was. */
type AwsLeft = CloudLeftover & { of: string };
/** A leftover in Google Cloud, with whose it was. */
type GoogleLeft = GoogleCloudLeftover & { of: string };

const COLUMNS: Column<AwsLeft>[] = [
  { id: "of", head: "Of", cell: (row) => row.of, tone: "key" },
  { id: "type", head: "Type", cell: (row) => row.type },
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

/** A Google Cloud leftover's columns: whose, type, Google name, region, label. */
const GOOGLE_COLUMNS: Column<GoogleLeft>[] = [
  { id: "of", head: "Of", cell: (row) => row.of, tone: "key" },
  { id: "type", head: "Type", cell: (row) => row.type },
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

/**
 * An Environment's Delete in a Cloud account, while it runs and when it
 * could not finish
 * (ADR-0038).
 *
 * - **Deleting**: its cloud Services' Deletes run, then its Environment
 *   networks' removals, each a Cloud run with its own Deployment log.
 * - **Delete incomplete**: something was left in AWS, or a run did not
 *   finish. Each leftover is listed with whose it was, its type, AWS id,
 *   region and Cloudgate's tag; the only ways out are **Retry** and
 *   **Forget**, which warns that what is left may still bill. Both need
 *   `environment: delete`, the Delete's own statement.
 *
 * Both name the DNS records its Domains leave at the operator's DNS
 * provider, which Cloudgate never writes.
 *
 * On Google Cloud
 * each leftover is listed by type, Google name, region and Cloudgate's
 * label, and the reason names Google's subnet hold with when Cloudgate
 * tries again by itself.
 */
export function EnvironmentDeleteCard({
  environment,
}: {
  environment: Environment;
}) {
  const record = environment.cloudDelete;
  return record ? (
    <CloudDeleteState environment={environment} record={record} />
  ) : null;
}

function CloudDeleteState({
  environment,
  record,
}: {
  environment: Environment;
  record: EnvironmentDelete;
}) {
  const router = useRouter();
  const permission = usePermission({ environment: ["delete"] });
  const actions = useEnvironmentCloudDeleteActions(
    environment.environmentId,
    environment.projectId,
  );
  const [forgetting, setForgetting] = useState(false);
  // The cloud is the Deploy target's Cloud account's, as the plan card
  // names it, so a Delete left incomplete with nothing found on Google
  // Cloud is not worded as AWS; a role that may not read Cloud accounts
  // goes by what is left.
  const canReadClouds = usePermission({ cloudAccount: ["read"] });
  const cloudAccounts = useCloudAccounts({ enabled: canReadClouds.allowed });

  const busy = actions.retry.isPending || actions.forget.isPending;
  const refused = !permission.allowed;
  const awsLeft = record.left.filter(
    (one): one is AwsLeft => !isGoogleLeftover(one),
  );
  const googleLeft = record.left.filter((one): one is GoogleLeft =>
    isGoogleLeftover(one),
  );
  const google =
    googleLeft.length > 0 ||
    planCloudName(environment.deployTarget, cloudAccounts.data ?? []) ===
      CLOUD_NAMES.gcp;
  const cloudName = CLOUD_NAMES[google ? "gcp" : "aws"];
  const records = <DnsRecords records={record.dnsRecordsLeft} />;

  if (record.status === "deleting") {
    return (
      <Card className="border-warn-line">
        <Card.Header
          title={`Deleting ${environment.name}`}
          sub="Cloud runs are destroying what it has in its Cloud account."
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-3">
          <p className="text-body text-tx-2">
            Its cloud Services are deleted first, then its Environment network;
            on Google Cloud every Domain is taken off the network before that.
            Each run is a Deployment with its own log. Once the Cloud account is
            checked and nothing is left, the Environment goes. If anything is
            left, it stays here as Delete incomplete, listing what.
          </p>
          {records}
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
            <p className="text-body text-tx-2">{record.unfinished}</p>
          ) : null}
          <p className="text-body text-tx-2">
            What is left keeps its Infrastructure state. Retry deletes again
            from it.
          </p>
          {records}
          {refused ? (
            <p className="text-meta text-tx-2">{ENVIRONMENT_DELETE_REFUSAL}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={refused || busy}
              title={refused ? ENVIRONMENT_DELETE_REFUSAL : undefined}
              onClick={() =>
                void actions.retry
                  .mutateAsync()
                  .then(() =>
                    toast.done(`Deleting ${environment.name} again.`, {
                      description:
                        "New Cloud runs destroy what its states still hold.",
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
              title={refused ? ENVIRONMENT_DELETE_REFUSAL : undefined}
              onClick={() => setForgetting(true)}
            >
              Forget
            </Button>
          </div>
        </Card.Body>
        {awsLeft.length > 0 ? (
          <Card.Body flush>
            <DataTable
              label={`What the Delete of ${environment.name} left in AWS`}
              rows={awsLeft}
              columns={COLUMNS}
              getRowId={(row) => `${row.of}:${row.type}:${row.awsId}`}
            />
          </Card.Body>
        ) : null}
        {googleLeft.length > 0 ? (
          <Card.Body flush>
            <DataTable
              label={`What the Delete of ${environment.name} left in Google Cloud`}
              rows={googleLeft}
              columns={GOOGLE_COLUMNS}
              getRowId={(row) =>
                `${row.of}:${row.type}:${row.region}:${row.googleName}`
              }
            />
          </Card.Body>
        ) : null}
      </Card>

      <Modal open={forgetting} onOpenChange={setForgetting}>
        <Modal.Header
          title={`Forget ${environment.name}?`}
          description={`Cloudgate stops tracking what its Delete left in ${cloudName}.`}
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            {google
              ? GOOGLE_ENVIRONMENT_FORGET_WARNING
              : ENVIRONMENT_FORGET_WARNING}
          </p>
          {record.left.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-meta text-tx-2">
              {record.left.map((one) => {
                const name = isGoogleLeftover(one) ? one.googleName : one.awsId;
                return (
                  <li
                    key={`${one.of}:${one.type}:${one.region}:${name}`}
                    className="wrap-anywhere"
                  >
                    {one.of}: {one.type} {name} ({one.region})
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
                  toast.done(`${environment.name} forgotten.`, {
                    description: `What it left is listed in the audit log. Remove it in ${cloudName} to stop paying for it.`,
                  });
                  router.push(`/projects/${environment.projectId}`);
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
