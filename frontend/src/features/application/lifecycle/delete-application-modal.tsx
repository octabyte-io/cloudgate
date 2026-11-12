import { useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { Field } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import {
  TeardownReportModal,
  useTeardownReport,
} from "@/components/console/teardown-report-modal";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { TeardownReport } from "@/lib/api/endpoints/teardown";
import { onGoogleCloud } from "@/lib/api/endpoints/applications";

/**
 * Delete the Application, in the Compose and database deletes' shape:
 * a typed name, the consequences stated before the button, and the teardown
 * report when the delete could not reclaim everything.
 *
 * Two facts from `ApplicationsService.remove` shape what it says:
 *
 * 1. **A delete that cannot confirm the Swarm service is gone keeps the row.**
 *    Unlike a Compose stack's, where the row goes either way, the Application's
 *    teardown removes the service first and then asks the Server whether it is
 *    still there; `present` or `unknown` is a 409 and the Application stays.
 *    `ConfirmDeleteModal` shows that refusal in the dialog, so the dialog says
 *    beforehand that it can happen rather than promising the row will go —
 *    and then offers "Remove from Cloudgate anyway", the forced Delete, for a
 *    Server that is gone for good.
 * 2. **Docker volumes survive unless asked for**. The `rm -rf` names the
 *    Application's directory (`applications/<appName>` — its source tree and
 *    its file mounts); the named volumes its `volume` mounts use go only with
 *    "Delete its volumes too", off by default like the Compose dialog's. Even
 *    then a volume another Service uses, or one a backup or restore holds, is
 *    kept and comes back in the report with the reason, which is why the
 *    toast's "removed with it" is said only on a report-free answer.
 *
 * What the teardown did try and could not finish — a directory, the Traefik
 * file, a preserved image — comes back on the response, and
 * `useTeardownReport` holds it on screen before this navigates away.
 */
/**
 * The Delete dialog's line about the Runtime log: the
 * log group goes with a cloud Service, so its stored logs do too.
 */
export const CLOUD_DELETE_LOG_GROUP_LINE =
  "Its log group goes too, and with it every stored line of its Runtime log.";

/**
 * The line on logs for a Service on Cloud Run, the
 * backend's `GOOGLE_LOGS_STAY_LINE`: they are the project's, not
 * Cloudgate's, so they stay and expire there, and are not kept on purpose.
 */
export const CLOUD_RUN_LOGS_STAY_LINE =
  "Its logs stay in the project's own log store and expire after its retention (30 days unless changed).";

export function DeleteApplicationModal({
  application,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  application: ApplicationDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (deleteVolumes: boolean, force?: boolean) => Promise<TeardownReport>;
  /** Where to go afterwards. This screen cannot stay — its row is gone. */
  onDeleted: () => void;
}) {
  const [volumes, setVolumes] = useState(false);
  const teardown = useTeardownReport();

  async function finish(force: boolean) {
    const clean = await teardown.runDelete(() => remove(volumes, force));
    onOpenChange(false);
    if (!clean) {
      // The report modal is open now and holds the only copy of what was
      // left behind. Navigating would unmount it — `onDismissed` goes.
      return;
    }
    toast.done(`${application.name} deleted.`, {
      description: volumes
        ? "Its named volumes were removed with it."
        : "Its named volumes are still on the Server.",
    });
    onDeleted();
  }

  if (application.cloudPlace) {
    return (
      <CloudDeleteModal
        application={application}
        open={open}
        onOpenChange={onOpenChange}
        remove={() => remove(false)}
      />
    );
  }

  return (
    <>
      <ConfirmDeleteModal
        open={open}
        onOpenChange={(next) => {
          // The switch is part of the decision, so it resets with the typed name.
          if (!next) setVolumes(false);
          onOpenChange(next);
        }}
        title={`Delete ${application.name}`}
        confirmWord={application.name}
        mismatch="That does not match the Application's name."
        button="Delete Application"
        onConfirm={() => finish(false)}
        forceRemove={{
          onConfirm: () => finish(true),
          leftBehind: (
            <>
              Removing it anyway deletes this row and its history now, without
              confirming anything on the Server. Whatever is still there stays:
              the Swarm service{" "}
              <code className="font-mono">{application.appName}</code> may keep
              running and serving its domains with nothing in Cloudgate to stop
              it, and its directory and volumes may remain. Cloudgate then lists
              what it could not confirm, for you to remove on the Server.
            </>
          ),
        }}
      >
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
          Its Swarm service will be removed, its domains will stop being
          routed, and this row will go with it — its variables, domains,
          mounts, ports, redirects, basic-auth users, schedules, volume
          backups, patches, previews, rollbacks and Deployment history.
        </p>

        <KVList>
          <KVRow
            label="Will remove Swarm service"
            value={application.appName}
            mono
          />
          <KVRow
            label="Will delete directory"
            value={`applications/${application.appName}`}
            mono
          />
        </KVList>

        <Field
          name="deleteVolumes"
          label="Delete its volumes too"
          hint="Removes the Docker volumes its volume mounts name, on its Server, once the service is gone — and their data with them. A volume another Service also uses, or one a backup or restore is running on, is kept and listed. Bind-mounted host paths are never touched."
          orientation="horizontal"
          manual
        >
          <Switch
            checked={volumes}
            onCheckedChange={(next) => setVolumes(next)}
          />
        </Field>

        <p className="text-meta text-tx-2">
          If the Server cannot be reached, or the service is still there after
          the removal, the Application is kept and this dialog says why, then
          offers to remove it from Cloudgate anyway.
        </p>
      </ConfirmDeleteModal>

      <TeardownReportModal
        report={teardown.report}
        serviceName={application.name}
        open={teardown.open}
        onOpenChange={teardown.setOpen}
        onDismissed={onDeleted}
      />
    </>
  );
}

/**
 * Delete of a Service in a Cloud account (ADR-0038): a Cloud run that
 * only destroys, so the dialog queues it and stays. The Service reads
 * "Deleting" until the run ends; a clean finish drops it, and anything left
 * keeps it as Delete incomplete with Retry and Forget. A `static` site's
 * own bucket is emptied and destroyed with it, with no box to keep
 * its files: they are a copy of its build. On Google Cloud the run
 * first takes the Service's Domains off the Environment network, and its
 * logs stay in the project to expire; a static site's bucket there is
 * emptied the same way, after its Domains come off.
 */
function CloudDeleteModal({
  application,
  open,
  onOpenChange,
  remove,
}: {
  application: ApplicationDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: () => Promise<unknown>;
}) {
  const place = application.cloudPlace;
  const where = place
    ? `Cloud account ${place.cloudAccountName}, ${place.region}`
    : "its Cloud account";
  const google = onGoogleCloud(place);
  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${application.name}`}
      confirmWord={application.name}
      mismatch="That does not match the Application's name."
      button="Delete Application"
      onConfirm={async () => {
        await remove();
        onOpenChange(false);
        toast.done(`Deleting ${application.name}.`, {
          description: `A Cloud run destroys it in ${google ? "Google Cloud" : "AWS"}. It reads Deleting until the run ends, and goes once nothing is left.`,
        });
      }}
    >
      {google && application.cloudBucketName ? (
        <>
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
            A Cloud run first takes its Domains off the Environment
            network&apos;s load balancer, then empties its Cloud Storage bucket{" "}
            {application.cloudBucketName} in {where}, every file, then destroys
            it with its Cloud CDN backend bucket and the load balancer&apos;s
            read access to it. Its files are a copy of its build, so they are
            not kept.
          </p>
          <p className="text-meta text-tx-2">
            Afterwards Cloudgate searches Google Cloud by name for anything
            left. If the network step fails, nothing else is touched. If
            emptying stops partway, its backend bucket still goes, and the
            bucket is left partly emptied, holding the files that remain. The
            site then stays as Delete incomplete, listing it, until you retry or
            forget it.
          </p>
        </>
      ) : google ? (
        <>
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
            A Cloud run first takes its Domains off the Environment
            network&apos;s load balancer, then destroys everything Cloudgate
            made for it in {where}: its backend service, serverless NEG, Cloud
            Run service, Artifact Registry repository with every image, its
            secrets and its service account. {CLOUD_RUN_LOGS_STAY_LINE}
          </p>
          <p className="text-meta text-tx-2">
            Afterwards Cloudgate searches Google Cloud by name for anything
            left. If something is, or the network step fails, the Service stays
            as Delete incomplete, listing it, until you retry or forget it. Its
            build cache and source on this Cloudgate go as on a Server.
          </p>
        </>
      ) : application.cloudBucketName ? (
        <>
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
            A Cloud run empties its S3 bucket {application.cloudBucketName} in{" "}
            {where}, every file, old version and delete marker, then destroys it
            with its CloudFront distribution, Origin Access Control, function
            and certificates. Its files are a copy of its build, so they are not
            kept.
          </p>
          <p className="text-meta text-tx-2">
            Afterwards Cloudgate checks AWS for anything left. If emptying stops
            partway, its distribution still goes, and the bucket is left partly
            emptied, holding the files that remain. The site then stays as
            Delete incomplete, listing it, until you retry or forget it.
          </p>
        </>
      ) : (
        <>
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
            A Cloud run destroys everything Cloudgate made for it in {where}:
            its ECS service, load-balancer rule, target group, security group,
            certificates, variables, task role, and its ECR repository with
            every image. {CLOUD_DELETE_LOG_GROUP_LINE}
          </p>
          <p className="text-meta text-tx-2">
            Afterwards Cloudgate checks AWS for anything left. If something is,
            the Service stays as Delete incomplete, listing it, until you retry
            or forget it. Its build cache and source on this Cloudgate go as on
            a Server.
          </p>
        </>
      )}
    </ConfirmDeleteModal>
  );
}
