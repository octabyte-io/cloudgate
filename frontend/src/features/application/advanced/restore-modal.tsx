import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Stepper } from "@/components/console/stepper";
import { toast } from "@/components/console/toast";
import type { Destination } from "@/lib/api/endpoints/destinations";
import type { RestoreVolumeBackupInput } from "@/lib/api/endpoints/volume-backups";
import { errorMessage } from "@/lib/api/error-message";

import {
  ChooseTarballStep,
  ConfirmVolumeStep,
  ReplaceContentsStep,
} from "./restore-steps";
import { useVolumeRestoreFlow } from "./use-volume-restore";
import { VolumeRestoreFooter } from "./volume-restore-footer";

/**
 * Restore a volume from a tarball. **Three steps, and the third one is named.**
 *
 * `POST /volume-backups/restore` is the most destructive call in this phase and
 * the least symmetrical: it is not "restore this backup row". Any tarball in a
 * destination the caller is entitled to can go into any volume, so the object,
 * the volume and the
 * destination are all chosen here — which means all three can be chosen wrongly,
 * and only one of the three mistakes is visible afterwards.
 *
 * **Step one picks a tarball that is really there.** It used to ask for an S3
 * key to be typed, because nothing listed a destination's objects
 * — so a typo was
 * indistinguishable from a missing object until the restore had already stopped
 * the service. `GET /destinations/:id/objects` closed that, and the step now
 * reads the bucket newest-first, which is the ordering the decision is actually
 * made on.
 *
 * The confirmation is **typed**, unlike every other delete on F10's screens, and
 * the difference is recoverability: removing a mount or a schedule is a row you
 * can add back in seconds, and unpacking a tarball over a volume destroys
 * whatever was in it with no copy anywhere. That is the same bar F08 set for
 * deleting a Project.
 */

const STEPS = [
  { id: "choose", label: "Choose the tarball" },
  { id: "target", label: "Confirm the volume" },
  { id: "confirm", label: "Replace its contents" },
];

/**
 * The refusal a restore comes back with — with as many lines as the backend
 * wrote it in.
 *
 * `POST /volume-backups/restore` does not answer in a sentence. Its abort is a
 * **block**: an `❌` headline naming what failed, then continuation lines the
 * script indents by three spaces (`volume-backup-commands.ts`'s
 * `replaceVolumeCommand`) saying what the volume holds now and where the
 * downloaded copy went, then the cleanup line the exit trap prints last. Both
 * the `\n`s and the indent are authored — it is a hanging indent under the
 * headline, and it is what makes the block four sentences instead of one.
 *
 * `FormError` alone renders them as one. Its `<p>` inherits
 * `white-space: normal`, so every `\n` collapses to a space, and the first
 * collapse is the one that costs something: *"…the archive would not extract
 * Volume 'x11-vol-a' has already been removed and re-created…"* reads as though
 * the volume were the object of "extract". So this element preserves the
 * whitespace the message arrived with.
 *
 * **`pre-wrap`, not `pre-line`**, for two reasons that agree. It is what this
 * tree already does with multi-line tool output — `explain-log.tsx`'s model
 * answer, every line of `log-well.tsx` — and `whitespace-pre-line` appears
 * nowhere in it. And `pre-line` collapses runs of spaces, which would drop the
 * script's own indentation: that is rewriting the backend's words rather than
 * rendering them, and ADR-0012 §18's rule about surfacing a tool's own words
 * verbatim holds here in spirit. `wrap-anywhere` stays for the reason it was
 * put there — an S3 key or a volume name has no word boundary in it.
 */
export function RestoreRefusal({ message }: { message: string | null }) {
  return (
    <FormError message={message ?? undefined} className="whitespace-pre-wrap" />
  );
}

export function RestoreModal({
  serviceId,
  serviceType = "application",
  serviceName,
  destinations,
  destinationsPending,
  suggestedVolume,
  suggestedPrefix,
  serverId = null,
  open,
  onOpenChange,
  restore,
}: {
  serviceId: string;
  /** An Application's volume, or a Server bucket's, whose Garage the restore
   * stops and starts again itself. */
  serviceType?: "application" | "bucket";
  serviceName: string;
  destinations: Destination[];
  destinationsPending: boolean;
  /** The volume of the backup this was opened from, if it was. */
  suggestedVolume: string;
  /** `<appName>/<prefix>/` — where this Service's tarballs are written. */
  suggestedPrefix: string;
  /** The Server the Service runs on, which the tarball listing reads from on
   * the Hosted instance. `null` is this Cloudgate host. */
  serverId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restore: (input: RestoreVolumeBackupInput) => Promise<unknown>;
}) {
  const flow = useVolumeRestoreFlow({
    destinations,
    suggestedVolume,
    suggestedPrefix,
    serverId,
    open,
  });
  const {
    step,
    setStep,
    destinationId,
    prefix,
    backupFileName,
    volumeName,
    typed,
    refusal,
    pending,
    destination,
    objects,
    tarball,
    canLeaveChoose,
    canLeaveTarget,
    confirmed,
  } = flow;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        flow.setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title="Restore a volume"
        description="Unpacks a tarball from a destination over a volume's current contents."
      />
      <Modal.Body>
        <Stepper
          label="Restore a volume"
          steps={STEPS.map((item, index) => ({
            ...item,
            done: index < STEPS.findIndex((s) => s.id === step),
          }))}
          currentId={step}
        />

        {step === "choose" ? (
          <ChooseTarballStep
            destinations={destinations}
            destinationsPending={destinationsPending}
            destinationId={destinationId}
            onDestinationChange={flow.chooseDestination}
            objects={objects.data}
            objectsPending={objects.isPending && destinationId !== ""}
            objectsError={objects.error}
            objectsFetching={objects.isFetching}
            onRefreshObjects={() => void objects.refetch()}
            prefix={prefix}
            onPrefixChange={flow.setPrefix}
            bucket={destination?.bucket}
            backupFileName={backupFileName}
            onChooseTarball={(object) => flow.setBackupFileName(object.key)}
          />
        ) : null}

        {step === "target" ? (
          <ConfirmVolumeStep
            volumeName={volumeName}
            onVolumeNameChange={flow.setVolumeName}
            serviceName={serviceName}
            tarball={tarball}
            backupFileName={backupFileName}
          />
        ) : null}

        {step === "confirm" ? (
          <ReplaceContentsStep
            volumeName={volumeName}
            serviceName={serviceName}
            tarball={tarball}
            backupFileName={backupFileName}
            typed={typed}
            onTypedChange={flow.setTyped}
          />
        ) : null}

        <RestoreRefusal message={refusal} />
      </Modal.Body>

      <VolumeRestoreFooter
        step={step}
        canLeaveChoose={canLeaveChoose}
        canLeaveTarget={canLeaveTarget}
        confirmed={confirmed}
        pending={pending}
        volumeName={volumeName}
        onBack={() => setStep(step === "confirm" ? "target" : "choose")}
        onNext={() => setStep(step === "choose" ? "target" : "confirm")}
        onRestore={async () => {
          if (!confirmed) return;
          flow.setRefusal(null);
          flow.setPending(true);
          try {
            await restore({
              serviceId,
              serviceType,
              volumeName: volumeName.trim(),
              backupFileName,
              destinationId,
            });
            toast.done(`Restoring ${volumeName}.`, {
              description:
                serviceType === "bucket"
                  ? "The bucket is stopped, the tarball unpacked over its volume on the Server, and the bucket started again."
                  : "The tarball is being unpacked over the volume on the Server.",
            });
            onOpenChange(false);
          } catch (error) {
            flow.setRefusal(errorMessage(error));
          } finally {
            flow.setPending(false);
          }
        }}
      />
    </Modal>
  );
}
