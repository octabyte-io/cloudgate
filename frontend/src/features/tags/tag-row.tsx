import { useState } from "react";

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Tag } from "@/lib/api/endpoints/tags";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { useDeleteTag, useUpdateTag } from "./use-tags";

/**
 * One Tag, with the two things you can do to it.
 *
 * Both renaming and deleting happen **in the row**, not in a second dialog.
 * This list already lives inside a modal, and a dialog over a dialog is a focus
 * trap over a focus trap — Base UI will do it, and the way out stops being
 * obvious. Renaming swaps the row for a field; deleting swaps it for the
 * sentence about what deleting does, and the confirmation is the second press.
 */
export function TagRow({ tag }: { tag: Tag }) {
  const [mode, setMode] = useState<"rest" | "rename" | "confirm">("rest");
  const [name, setName] = useState(tag.name);
  const rename = useUpdateTag();
  const remove = useDeleteTag();
  // `PATCH /tags/:id` is `tag: ['update']` and `DELETE` is `tag: ['delete']`
  // — neither in the base member's grants.
  const canRename = usePermission({ tag: ["update"] });
  const canDelete = usePermission({ tag: ["delete"] });

  function close() {
    setMode("rest");
  }

  async function saveName() {
    const next = name.trim();
    if (next === "" || next === tag.name) return close();
    try {
      await rename.mutateAsync({ tagId: tag.tagId, input: { name: next } });
      toast.done(`Tag renamed to ${next}.`);
      close();
    } catch (error) {
      toast.error(error);
    }
  }

  async function confirmRemove() {
    try {
      await remove.mutateAsync(tag.tagId);
      toast.done(`Tag ${tag.name} deleted.`, {
        description: "It has been taken off every Project that carried it.",
      });
      close();
    } catch (error) {
      toast.error(error);
    }
  }

  const pending = rename.isPending || remove.isPending;

  return (
    // Keyed on the mode so the confirm state fades in where the row was: an
    // inline swap, opacity only. Rename does not fade, since it is left by
    // Enter or Escape and a keyboard action never waits on motion.
    <li
      key={mode}
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-2 last:border-b-0",
        mode === "confirm" && "animate-fade",
      )}
    >
      {mode === "rename" ? (
        <>
          <Input
            value={name}
            autoFocus
            aria-label={`Rename ${tag.name}`}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveName();
              }
              if (event.key === "Escape") {
                setName(tag.name);
                close();
              }
            }}
            className="min-w-0 flex-[1_1_160px]"
          />
          <Button size="sm" variant="pri" disabled={pending} onClick={saveName}>
            Save
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              setName(tag.name);
              close();
            }}
          >
            Cancel
          </Button>
        </>
      ) : mode === "confirm" ? (
        <>
          <span className="min-w-0 flex-[1_1_180px] text-ui wrap-anywhere text-tx-2">
            Delete <strong className="font-medium text-tx">{tag.name}</strong>?
            It comes off every Project that carries it.
          </span>
          <Button
            size="sm"
            variant="dngr"
            disabled={pending || !canDelete.allowed}
            title={canDelete.allowed ? undefined : DELETE_REFUSAL}
            aria-busy={pending || undefined}
            onClick={confirmRemove}
          >
            Delete
          </Button>
          <Button size="sm" disabled={pending} onClick={close}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span
            className="min-w-0 flex-1 truncate text-body text-tx"
            title={tag.name}
          >
            {tag.name}
          </span>
          <Button
            size="xs"
            disabled={!canRename.allowed}
            title={canRename.allowed ? undefined : RENAME_REFUSAL}
            onClick={() => canRename.allowed && setMode("rename")}
          >
            <Icon name="pencil" size={14} />
            Rename
          </Button>
          <Button
            size="xs"
            disabled={!canDelete.allowed}
            title={canDelete.allowed ? undefined : DELETE_REFUSAL}
            onClick={() => canDelete.allowed && setMode("confirm")}
          >
            <Icon name="trash" size={14} />
            Delete
          </Button>
        </>
      )}
    </li>
  );
}

const RENAME_REFUSAL = roleRefusal("rename a tag");
const DELETE_REFUSAL = roleRefusal("delete a tag");
