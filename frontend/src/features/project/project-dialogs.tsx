import type { Project } from "@/lib/api/endpoints/projects";

import { ManageTagsModal } from "@/features/tags/manage-tags-modal";
import { ProjectTagsModal } from "@/features/tags/project-tags-modal";

import { DeleteProjectModal } from "./delete-project-modal";
import { ProjectFormModal } from "./project-form-modal";

/** Which dialog the Projects screen has open. Exactly one, or none. */
export type ProjectDialog =
  | "none"
  | "new"
  | "rename"
  | "tags"
  | "delete"
  | "manage-tags";

/**
 * The four dialogs the Projects screen can open, in one place.
 *
 * They live here rather than inside a row, because a row is a thing the table
 * re-sorts: a dialog mounted in one would unmount mid-interaction the moment the
 * list refetched underneath it. And they are one component rather than four
 * conditionals in the screen, because the rule they share — one at a time,
 * always about `target` — is easier to keep true when it is written once.
 *
 * The `key` on the form modal is load-bearing. `useApiForm` reads
 * `defaultValues` once, so without a key that changes with the target, renaming
 * a second Project would open the dialog holding the first one's name.
 */
export function ProjectDialogs({
  dialog,
  target,
  onClose,
}: {
  dialog: ProjectDialog;
  /** The Project the dialog is about. `null` for "new" and "manage-tags". */
  target: Project | null;
  onClose: () => void;
}) {
  const close = (next: boolean) => {
    if (!next) onClose();
  };

  return (
    <>
      <ProjectFormModal
        key={`${dialog}-${target?.projectId ?? "new"}`}
        project={dialog === "rename" ? target : null}
        open={dialog === "new" || dialog === "rename"}
        onOpenChange={close}
      />
      {target ? (
        <>
          <ProjectTagsModal
            projectId={target.projectId}
            projectName={target.name}
            open={dialog === "tags"}
            onOpenChange={close}
          />
          <DeleteProjectModal
            projectId={target.projectId}
            projectName={target.name}
            open={dialog === "delete"}
            onOpenChange={close}
          />
        </>
      ) : null}
      <ManageTagsModal open={dialog === "manage-tags"} onOpenChange={close} />
    </>
  );
}
