import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  volumeBackupsApi,
  type BackupMoment,
  type VolumeBackup,
} from "@/lib/api/endpoints/volume-backups";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { useDeploymentLog } from "@/lib/realtime/gateways";
import { timeExact } from "@/lib/format/time";

import { DeploymentLog } from "../../application/deploy/deployment-log";
import { RestoreRefusal } from "../../application/advanced/restore-modal";
import { useVolumeBackupRuns } from "../../application/advanced/use-advanced";
import { MOMENT_STEP_MARK, momentRestoreSteps } from "./moment-restore-steps";

/** How often the run history is read while the restore runs, to find its run. */
const RUN_POLL_MS = 1_500;

type Outcome = "running" | "done" | "failed";

/**
 * **Restore a moment** of a Stack backup (ADR-0092): every volume of one
 * moment together, in one confirm.
 *
 * Two halves. The first lists the moments the destination really holds
 * (`GET /volume-backups/:id/moments`, newest first) and asks for the stack's
 * name typed back — the bar the one-volume restore sets, because this
 * replaces every volume's contents with no copy of what was there. The
 * second shows the run: its steps, read off its log by
 * {@link momentRestoreSteps}, and the log itself.
 *
 * `POST /volume-backups/:id/restore-moment` answers only once the run has
 * ended, so the run is found while it goes by reading the backup's run
 * history for the Stack Restore that was not there at the press. The log
 * socket is the same Live log `DeploymentLog` below follows.
 */
export function MomentRestoreModal({
  backup,
  stackName,
  composeType,
  open,
  onOpenChange,
}: {
  backup: VolumeBackup;
  stackName: string;
  composeType: "docker-compose" | "stack";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { organizationId } = useActiveOrganizationId();
  const [chosen, setChosen] = useState<BackupMoment | null>(null);
  const [typed, setTyped] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The runs already recorded at the press: the restore's is the one after.
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);

  const moments = useQuery({
    queryKey: keys.volumeBackups.moments(organizationId, backup.volumeBackupId),
    queryFn: () => volumeBackupsApi.moments(backup.volumeBackupId),
    enabled: open && organizationId !== null,
  });
  const runs = useVolumeBackupRuns(open ? backup.volumeBackupId : null);
  const { refetch } = runs;

  useEffect(() => {
    if (outcome !== "running") return;
    const timer = setInterval(() => void refetch(), RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [outcome, refetch]);

  const run =
    seen !== null
      ? ((runs.data ?? []).find(
          (row) => row.title === "Stack Restore" && !seen.has(row.deploymentId),
        ) ?? null)
      : null;
  const stream = useDeploymentLog({
    deploymentId: run?.deploymentId,
    enabled: outcome === "running",
  });

  const confirmed = chosen !== null && typed.trim() === stackName;

  async function restore() {
    if (!chosen || !confirmed) return;
    setSeen(new Set((runs.data ?? []).map((row) => row.deploymentId)));
    setRefusal(null);
    setOutcome("running");
    try {
      await volumeBackupsApi.restoreMoment(
        backup.volumeBackupId,
        chosen.moment,
      );
      setOutcome("done");
    } catch (error) {
      setRefusal(errorMessage(error));
      setOutcome("failed");
    } finally {
      void refetch();
    }
  }

  return (
    <Modal wide open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Restore a moment of ${backup.name}`}
        description="Puts back every volume of one moment together, then starts the stack."
      />
      <Modal.Body>
        {outcome === null ? (
          <ChooseMoment
            moments={moments}
            chosen={chosen}
            onChoose={setChosen}
            stackName={stackName}
            composeType={composeType}
            typed={typed}
            onTypedChange={setTyped}
          />
        ) : chosen ? (
          <>
            <ol aria-label="Steps" className="grid gap-1.5">
              {momentRestoreSteps({
                composeType,
                volumes: chosen.volumes,
                lines: stream.lines,
                outcome,
              }).map((step) => (
                <li
                  key={step.name}
                  className="flex items-center justify-between gap-3 text-body text-tx"
                >
                  <span className="min-w-0 wrap-anywhere">{step.name}</span>
                  <StatusPill mark={MOMENT_STEP_MARK[step.state]} />
                </li>
              ))}
            </ol>
            {run ? (
              <DeploymentLog
                deployment={run}
                label="Restore output"
                subject={stackName}
              />
            ) : null}
            <RestoreRefusal message={refusal} />
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close
          render={
            <Button type="button">
              {outcome === null ? "Cancel" : "Close"}
            </Button>
          }
        />
        {outcome === null ? (
          <Button
            type="button"
            variant="dngr"
            aria-disabled={!confirmed || undefined}
            onClick={() => void restore()}
          >
            Restore this moment
          </Button>
        ) : null}
      </Modal.Footer>
    </Modal>
  );
}

function ChooseMoment({
  moments,
  chosen,
  onChoose,
  stackName,
  composeType,
  typed,
  onTypedChange,
}: {
  moments: ReturnType<typeof useQuery<BackupMoment[]>>;
  chosen: BackupMoment | null;
  onChoose: (moment: BackupMoment) => void;
  stackName: string;
  composeType: "docker-compose" | "stack";
  typed: string;
  onTypedChange: (value: string) => void;
}) {
  if (moments.error) {
    return (
      <p className="text-body text-tx-2">
        {errorMessage(moments.error)} No moment is offered until the destination
        can be read.
      </p>
    );
  }
  if (moments.isPending) {
    return (
      <div className="grid gap-2.5" aria-busy="true">
        <Skeleton className="h-row" />
        <Skeleton className="h-row" />
      </div>
    );
  }
  if (moments.data.length === 0) {
    return (
      <p className="text-body text-tx-2">
        Run this backup to write its first moment. Its destination holds none
        yet.
      </p>
    );
  }

  return (
    <>
      <PickGrid label="Moments">
        {moments.data.map((moment) => (
          <PickCard
            key={moment.moment}
            title={timeExact(moment.takenAt) ?? moment.moment}
            description={moment.volumes.join(", ")}
            meta={moment.moment}
            selected={chosen?.moment === moment.moment}
            onClick={() => onChoose(moment)}
          />
        ))}
      </PickGrid>

      {chosen ? (
        <>
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-body text-bad">
            {composeType === "stack"
              ? "The stack is stopped"
              : "The stack's containers are removed"}
            , then everything in{" "}
            <strong className="font-medium">{chosen.volumes.join(", ")}</strong>{" "}
            is replaced by this moment&rsquo;s copy, with no copy of what is
            there now, and the stack is started. If a volume fails, the restore
            stops there and the stack stays stopped.
          </p>
          <Field name="typed" label={`Type ${stackName} to confirm`} manual>
            <Input
              value={typed}
              onChange={(event) => onTypedChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-meta md:text-meta"
            />
          </Field>
        </>
      ) : null}
    </>
  );
}
