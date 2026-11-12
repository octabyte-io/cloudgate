import { Card } from "@/components/console/card";
import type { MovePreview, Plan } from "@/lib/api/endpoints/project-config";

import { PlanView } from "./plan-view";

/** Each Environment's plan against its copy, as the move would leave it open. */
export function MovePreviewList({
  preview,
  serverNames,
}: {
  preview: MovePreview;
  serverNames: Readonly<Record<string, string>>;
}) {
  if (preview.environments.length === 0) {
    return (
      <p className="text-body text-tx-3">
        This Project has no Environments yet, so there is nothing to plan.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <p className="text-body text-tx-2">
        What each Environment&apos;s plan would be after the move. Nothing is
        applied until you apply a plan.
      </p>
      {preview.environments.map((environment) => (
        <Card key={environment.environmentId}>
          <Card.Header
            title={environment.name}
            sub={readLine(environment.branch, environment.commitSha)}
            actions={
              environment.fileUrl ? (
                <a
                  href={environment.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  Open the file
                </a>
              ) : null
            }
          />
          <Card.Body>
            <PlanView
              plan={previewPlan(environment)}
              serverNames={serverNames}
            />
          </Card.Body>
        </Card>
      ))}
    </div>
  );
}

/** `Branch main at c0ffee1`. */
export function readLine(
  branch: string | null,
  commitSha: string | null,
): string | undefined {
  if (branch === null) return undefined;
  return commitSha
    ? `Branch ${branch} at ${commitSha.slice(0, 7)}`
    : `Branch ${branch}`;
}

/** A preview's steps as a plan `PlanView` shows: never open, so never applied. */
function previewPlan(environment: MovePreview["environments"][number]): Plan {
  return {
    planId: `preview-${environment.environmentId}`,
    environmentId: environment.environmentId,
    source: "move",
    textHash: "",
    commitSha: environment.commitSha,
    branch: environment.branch,
    baseTextHash: "",
    settingsFingerprint: "",
    steps: environment.steps,
    notes: environment.notes,
    status: environment.steps.length > 0 ? "superseded" : "unchanged",
    results: null,
    requestedBy: null,
    createdAt: "",
    appliedBy: null,
    appliedAt: null,
    dismissedBy: null,
    dismissedAt: null,
  };
}
