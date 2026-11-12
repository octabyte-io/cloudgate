import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { useEnvironments } from "@/features/environment/use-environments";
import { keptBucketsLine } from "@/lib/api/endpoints/teardown";

import { useDeleteProject } from "./use-projects";

/**
 * Delete a Project, and say first exactly what goes with it.
 *
 * The cascade is real and it is in the schema, not in this dialog's imagination:
 * `environment.projectId` is `onDelete: 'cascade'`, and every service hangs off
 * an Environment the same way. So the Environments are **named**, not counted —
 * "2 Environments" is a number someone can misread as a different Project's,
 * whereas "production, staging" is not.
 *
 * What it does not do is count the services inside them. It *could* now — each
 * Environment's read names them
 * — but that is one
 * request per Environment fired while somebody is deciding whether to destroy a
 * Project, and a count that arrives late, or not at all, in the sentence naming what
 * is about to be destroyed is worse than no count. "Everything deployed in them" is
 * true the moment the dialog opens, which is the property that matters here.
 *
 * Typing the name is the confirmation, and F19 moved the machinery behind it
 * into `ConfirmDeleteModal` — this file keeps the paragraph only it can write.
 */
export function DeleteProjectModal({
  projectId,
  projectName,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to go afterwards. The list stays put; a Project's own page cannot. */
  onDeleted?: () => void;
}) {
  const environments = useEnvironments(projectId);
  const remove = useDeleteProject();

  const rows = environments.data ?? [];

  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${projectName}`}
      confirmWord={projectName}
      mismatch="That does not match the Project's name."
      button="Delete Project"
      onConfirm={async () => {
        const answer = await remove.mutateAsync(projectId);
        toast.done(`Project ${projectName} deleted.`, {
          description: keptBucketsLine(answer),
        });
        onOpenChange(false);
        onDeleted?.();
      }}
    >
      <div className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
        {environments.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-2.75 w-3/4" />
            <Skeleton className="h-2.75 w-1/2" />
          </div>
        ) : environments.error ? (
          <p>
            Deleting {projectName} deletes every Environment under it and
            everything deployed in them. We could not read the list of
            Environments to name them here.
          </p>
        ) : rows.length === 0 ? (
          <p>
            {projectName} has no Environments. Deleting it removes the Project
            and its variables.
          </p>
        ) : (
          <p>
            Deleting {projectName} deletes its {rows.length}{" "}
            {rows.length === 1 ? "Environment" : "Environments"} —{" "}
            <strong className="font-medium">
              {rows.map((row) => row.name).join(", ")}
            </strong>{" "}
            — and everything deployed in {rows.length === 1 ? "it" : "them"},
            along with their variables.
          </p>
        )}
      </div>
    </ConfirmDeleteModal>
  );
}
