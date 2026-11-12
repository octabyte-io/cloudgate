import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/api/error-message";

import { useProjectTagList, useSetProjectTag, useTags } from "./use-tags";

/**
 * Which Tags this Project carries.
 *
 * A checkbox per Organization Tag, and **each one commits on the spot** — there
 * is no Save. `POST /tags/:id/projects/:projectId` and its `DELETE` twin are one
 * assignment each, so a batch button would have to fan out into several requests
 * and then decide what "half of them worked" means. Ticking a box is one
 * request, one refusal, one place to say so.
 *
 * The Tag list and the assignment list are two different reads — there is no
 * `tags` array on a `project` row — so the dialog waits for both before it can
 * tell an unticked box from one it has not heard about yet.
 */
export function ProjectTagsModal({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const all = useTags();
  const mine = useProjectTagList(projectId);
  const set = useSetProjectTag(projectId);

  const assigned = new Set((mine.data ?? []).map((tag) => tag.tagId));
  const error = all.error ?? mine.error;
  const pending = all.isPending || mine.isPending;

  async function toggle(tagId: string, name: string, on: boolean) {
    try {
      await set.mutateAsync({ tagId, on });
      toast.done(
        on
          ? `${name} added to ${projectName}.`
          : `${name} removed from ${projectName}.`,
      );
    } catch (thrown) {
      toast.error(thrown);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Tags on ${projectName}`}
        description="Tick a tag to put it on this Project. Changes are saved as you make them."
      />
      <Modal.Body>
        {error ? (
          <FormError message={errorMessage(error)} />
        ) : pending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-ctl" />
            <Skeleton className="h-ctl" />
          </div>
        ) : (all.data ?? []).length === 0 ? (
          <p className="text-body text-tx-2">
            No tags yet. Add one from Manage tags on the Projects screen, then
            tick it here.
          </p>
        ) : (
          <ul className="flex flex-col rounded-lg border border-line">
            {(all.data ?? []).map((tag) => (
              <li
                key={tag.tagId}
                className="flex items-center gap-2.5 border-b border-line px-3 py-2.25 last:border-b-0"
              >
                <Checkbox
                  id={`tag-${tag.tagId}`}
                  checked={assigned.has(tag.tagId)}
                  disabled={set.isPending}
                  onCheckedChange={(next) =>
                    toggle(tag.tagId, tag.name, next === true)
                  }
                />
                <label
                  htmlFor={`tag-${tag.tagId}`}
                  className="min-w-0 flex-1 cursor-pointer truncate text-body text-tx"
                >
                  {tag.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button variant="pri">Done</Button>} />
      </Modal.Footer>
    </Modal>
  );
}
