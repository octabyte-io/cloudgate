import { useMemo, useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";

import { PatchEditorTabs } from "./patch-editor-tabs";
import { diffLines } from "@/lib/format/diff-lines";

/**
 * Edit a file, and save the result as a patch.
 *
 * **There are two diffs here now, and they answer two different questions.**
 *
 * - **Changes** — what you are about to change, from what was loaded to what is in
 *   the editor. The question someone has open in front of them.
 * - **Against the repository** — what the *patch as a whole* replaces, from the
 *   repository's own copy of the file to what is in the editor. This is the one
 *   that could not be drawn before
 *   `GET /patches/repo/
 *   file` answered with the *patch's* content once one existed for a path, so for
 *   an `update` patch — the default type — the original was unreachable through
 *   the API and the effect of the patch was invisible. `source=repo` reads past
 *   that resolution, and `use-patches.ts` fetches both sides.
 *
 * The second tab is **absent rather than empty when there is no original**, which
 * is a real and common state: a `create` patch is a file the repository does not
 * have, so `source=repo` 404s and there is nothing to compare against. Rendering
 * the whole file as added would say the patch rewrites something, when what it
 * does is add it.
 *
 * Tabs rather than panes side by side, and the reason is width: a diff cannot wrap
 * without lying about its indentation (`DiffView` owns its own horizontal scroll
 * for exactly that), and two of them beside a textarea inside a dialog leaves each
 * about 200px on a laptop. Tabs give the whole measure to whichever is being read.
 *
 * **Mark for deletion is here, not on the list.** A `delete` patch is written by
 * a different route (`POST /patches/mark-for-deletion`), it is the one action
 * whose effect is invisible in the editor, and it belongs beside the file it
 * removes rather than in a menu two screens away.
 */
export function PatchEditorModal({
  filePath,
  loaded,
  original,
  pending,
  error,
  open,
  onOpenChange,
  save,
  markForDeletion,
}: {
  filePath: string | null;
  /** `source=patch` — what the next build will apply for this path. */
  loaded: string | undefined;
  /**
   * `source=repo` — the repository's own copy, or `undefined` when it has none.
   * Absent is normal for a `create` patch and hides the second diff.
   */
  original: string | undefined;
  pending: boolean;
  error: unknown;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: (input: { filePath: string; content: string }) => Promise<unknown>;
  markForDeletion: (filePath: string) => Promise<unknown>;
}) {
  /**
   * `null` until something is typed, and then the edit.
   *
   * The file arrives *after* the dialog opens, so the obvious shape — a `draft`
   * string seeded from `loaded` in an effect — is a `setState` inside an effect,
   * which cascades a render and which this project's lint rules refuse outright.
   * Deriving it needs no effect and has the better behaviour anyway: until
   * someone types, the editor shows whatever the query currently holds, so a
   * refetch is not silently overwritten by a stale seed.
   */
  const [edit, setEdit] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draft = edit ?? loaded ?? "";
  const rows = useMemo(() => diffLines(loaded ?? "", draft), [loaded, draft]);

  // The whole patch's effect, repository → editor. Only computable when
  // the repository has the file at all; `undefined` is a `create` patch.
  const againstRepo = useMemo(
    () => (original === undefined ? null : diffLines(original, draft)),
    [original, draft],
  );

  if (!filePath) return null;

  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title={filePath}
        description="Saved as a patch, applied to the clone before every build. The file in your repository is untouched."
      />
      {/*
        `min-w-0` is what lets a long diff line scroll inside `DiffView` rather
        than widen the dialog and push Save off-screen. The dialog is a
        one-column grid whose `auto` column is at least its items' content-based
        minimum, and a `whitespace-pre` line makes that minimum the line. Measured
        in Chrome with a 300-character line: this class here takes the dialog
        from 2259/860 (scrollWidth/clientWidth) to 860/860; the same class on
        `DiffView`, the tab panel or the tabs root changed nothing, because none
        of them is the grid item. Rejected: adding it to `ModalBody` in `modal.tsx`,
        which would change every dialog in the console for one that needed it.
      */}
      <Modal.Body className="min-w-0">
        {error ? (
          <p className="text-body text-tx-2">{errorMessage(error)}</p>
        ) : pending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-48" />
          </div>
        ) : (
          <PatchEditorTabs
            filePath={filePath}
            draft={draft}
            onDraft={setEdit}
            rows={rows}
            againstRepo={againstRepo}
          />
        )}

        <FormError message={refusal ?? undefined} />
      </Modal.Body>

      <Modal.Footer>
        <Button
          type="button"
          variant="dngr"
          disabled={busy}
          onClick={async () => {
            setRefusal(null);
            setBusy(true);
            try {
              await markForDeletion(filePath);
              toast.done(`${filePath} will be removed before the build.`, {
                description: "Recorded as a delete patch. Your repository is untouched.",
              });
              onOpenChange(false);
            } catch (caught) {
              setRefusal(errorMessage(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="trash" size={14} />
          Remove this file at build time
        </Button>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button
          type="button"
          variant="pri"
          disabled={busy || pending}
          aria-busy={busy || undefined}
          onClick={async () => {
            setRefusal(null);
            setBusy(true);
            try {
              await save({ filePath, content: draft });
              toast.done(`Patch saved for ${filePath}.`, {
                description: "It is applied to the clone before the next build.",
              });
              onOpenChange(false);
            } catch (caught) {
              setRefusal(errorMessage(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save as a patch
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
