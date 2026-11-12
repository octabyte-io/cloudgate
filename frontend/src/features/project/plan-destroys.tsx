import type { PlanStep } from "@/lib/api/endpoints/project-config";

import {
  BucketFilesLine,
  ComposeVolumesLine,
  DeleteFilesBox,
  ExistingLeftLine,
} from "./plan-bucket-files";
import { ConfirmByName } from "./plan-confirm";
import { DeleteDataBox, FinalSnapshotLine } from "./plan-final-snapshot";
import { PlanSection } from "./plan-section";
import { StepRow } from "./plan-step-row";

export type Destroy = Extract<
  PlanStep,
  { action: "destroy" | "network-remove" }
>;

/**
 * What a destroy's confirmation is keyed and sent by: a Service's Config
 * name, or an Environment network removal's `confirmName`.
 */
export function confirmKey(step: Destroy): string {
  return step.action === "destroy" ? step.configName : step.confirmName;
}

/** What the operator types: a Service's name, or the network's `confirmName`. */
export function confirmWord(step: Destroy): string {
  return step.action === "destroy" ? step.name : step.confirmName;
}

/**
 * A Plan's Destroys, in red: each the Delete an operator
 * already knows, with what it leaves or takes — a Compose stack's volumes,
 * a bucket's files, an existing
 * database left as it was (ADR-0033), a cloud database's final snapshot
 * — and, while the plan can be applied, its "also delete" tick and
 * its name to type.
 */
export function DestroysSection({
  destroys,
  serverNames,
  cloudAccountNames,
  confirming,
  typed,
  matches,
  onType,
  ticked,
  onTick,
}: {
  destroys: readonly Destroy[];
  serverNames: Readonly<Record<string, string>>;
  cloudAccountNames: Readonly<Record<string, string>>;
  confirming: boolean;
  typed: Readonly<Record<string, string>>;
  matches: (step: Destroy) => boolean;
  onType: (key: string, value: string) => void;
  ticked: ReadonlySet<string>;
  onTick: (configName: string, checked: boolean) => void;
}) {
  return (
    <PlanSection
      title="Destroys"
      className="rounded-lg border border-bad-line bg-bad-tint p-3 text-bad"
    >
      <p className="text-meta">
        Applying deletes these Services, as Delete does. A rename or a kind
        change in the config is a destroy and a create. An Environment network
        nothing uses any more is removed after them.
      </p>
      {destroys.map((step) => (
        <div key={`destroy-${confirmKey(step)}`} className="grid gap-2">
          <StepRow
            step={step}
            serverNames={serverNames}
            cloudAccountNames={cloudAccountNames}
          />
          {step.action === "destroy" && step.kind === "bucket" && step.files ? (
            <BucketFilesLine files={step.files} />
          ) : null}
          {step.action === "destroy" && step.stackVm ? (
            <p aria-label="Stack VM removed" className="text-meta text-tx-2">
              {step.stackVm.lines[0]}
            </p>
          ) : null}
          {step.action === "destroy" &&
          step.kind === "compose" &&
          step.volumes !== undefined ? (
            <ComposeVolumesLine
              volumes={step.volumes}
              keptInSnapshot={
                step.finalSnapshot?.of === "data-disk" &&
                !ticked.has(step.configName)
              }
            />
          ) : null}
          {step.action === "destroy" && step.existing ? (
            <ExistingLeftLine
              kind={step.kind}
              identifier={step.existing.identifier}
            />
          ) : null}
          {confirming &&
          step.action === "destroy" &&
          step.kind === "bucket" &&
          // An existing bucket's files are never Cloudgate's.
          !step.existing ? (
            <DeleteFilesBox
              configName={step.configName}
              checked={ticked.has(step.configName)}
              onCheckedChange={(checked) => onTick(step.configName, checked)}
            />
          ) : null}
          {step.action === "destroy" && step.finalSnapshot ? (
            <FinalSnapshotLine
              snapshot={step.finalSnapshot}
              deleteData={ticked.has(step.configName)}
            />
          ) : null}
          {confirming && step.action === "destroy" && step.finalSnapshot ? (
            <DeleteDataBox
              configName={step.configName}
              cloud={step.finalSnapshot.cloud}
              dataDisk={step.finalSnapshot.of === "data-disk"}
              checked={ticked.has(step.configName)}
              onCheckedChange={(checked) => onTick(step.configName, checked)}
            />
          ) : null}
          {confirming ? (
            <ConfirmByName
              confirmKey={confirmKey(step)}
              word={confirmWord(step)}
              value={typed[confirmKey(step)] ?? ""}
              matches={matches(step)}
              mismatch={
                step.action === "destroy" ? undefined : "That does not match."
              }
              onChange={(value) => onType(confirmKey(step), value)}
            />
          ) : null}
        </div>
      ))}
    </PlanSection>
  );
}
