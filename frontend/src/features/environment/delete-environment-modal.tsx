import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { toast } from "@/components/console/toast";
import { keptBucketsLine } from "@/lib/api/endpoints/teardown";

import { countVariables } from "@/lib/format/env-blob";

import { dnsRecordLine } from "@/components/console/dns-records";
import { useDeleteEnvironment } from "./use-environments";

/**
 * Delete an Environment, and say first what goes with it.
 *
 * Same shape as the Project one and the same reasoning: the cascade is in the
 * schema, so the sentence has to be. What it can name here is the **variables**,
 * because those are on the row the caller already holds.
 *
 * It still does not name a service **count**, and the reason moved rather than
 * went away. `GET /environments/:id` carries the services now
 * but this dialog is
 * opened from the Environments table, whose rows come from
 * `GET /environments?projectId=` — the *list* route, which does not. Naming a
 * count would mean a detail read per row of that table, to fill in a number
 * nobody has asked for yet. "Everything deployed in it" is still the honest
 * phrase; the Services tab is where the actual list is.
 *
 * Typing the name is the confirmation, for the same reason as the Project's:
 * this is not recoverable, and a `dngr` button on its own is one mis-aimed
 * click. F19 moved that machinery into `ConfirmDeleteModal`.
 */
export function DeleteEnvironmentModal({
  environmentId,
  environmentName,
  projectId,
  env,
  open,
  onOpenChange,
  onDeleted,
  onCloudDeleting,
}: {
  environmentId: string;
  environmentName: string;
  projectId: string;
  /** The Environment's variable blob, for the count in the warning. */
  env: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
  /** A Delete in a Cloud account began, and the Environment stays meanwhile. */
  onCloudDeleting?: () => void;
}) {
  const remove = useDeleteEnvironment(projectId);
  const variables = countVariables(env);

  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${environmentName}`}
      confirmWord={environmentName}
      mismatch="That does not match the Environment's name."
      button="Delete Environment"
      onConfirm={async () => {
        const removed = await remove.mutateAsync(environmentId);
        onOpenChange(false);
        // In a Cloud account the Delete runs in Cloud runs, and the
        // Environment stays, Deleting, until AWS is clean.
        if (removed.cloudDelete) {
          const records = removed.dnsRecordsLeft ?? [];
          toast.done(`Deleting ${environmentName} in its Cloud account.`, {
            description:
              records.length > 0
                ? `Cloudgate never writes DNS, so remove these records at your DNS provider: ${records.map(dnsRecordLine).join("; ")}`
                : "Its cloud Services go first, then its Environment network.",
          });
          onCloudDeleting?.();
          return;
        }
        toast.done(`Environment ${environmentName} deleted.`, {
          description: keptBucketsLine(removed),
        });
        onDeleted?.();
      }}
    >
      <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
        Deleting {environmentName} deletes everything deployed in it — its
        Applications, databases and Compose stacks, and their volumes
        {variables > 0 ? (
          <>
            {" "}
            — along with the{" "}
            <strong className="font-medium">{variables}</strong>{" "}
            {variables === 1 ? "variable" : "variables"} set on it
          </>
        ) : null}
        . The Project keeps its other Environments.
      </p>
      <p className="text-body text-tx-2">
        In a Cloud account, its Services there are deleted first, then its
        Environment network, each in a Cloud run; it reads Deleting until AWS is
        clean, and anything left keeps it as Delete incomplete.
      </p>
      <p className="text-meta text-tx-2">
        A bucket that holds files is kept, its volume with it, and named when
        the Delete ends; an empty one is removed. Deleting an Environment never
        deletes a bucket&apos;s files.
      </p>
    </ConfirmDeleteModal>
  );
}
