import { DiffView } from "@/components/console/diff-view";
import { Tabs } from "@/components/console/tabs";
import { Textarea } from "@/components/ui/textarea";
import { diffLines, hasChanges } from "@/lib/format/diff-lines";

type Rows = ReturnType<typeof diffLines>;

/**
 * The editor and **two diffs, which answer two different questions.**
 *
 * - **Changes** — what you are about to change, from what was loaded to what is in
 *   the editor. The question someone has open in front of them.
 * - **Against the repository** — what the *patch as a whole* replaces, from the
 *   repository's own copy to what is in the editor. This is the one that could not
 *   be drawn before:
 *   `GET /patches/repo/file` answered with the *patch's* content once one existed
 *   for a path, so for an `update` patch — the default — the original was
 *   unreachable and the effect of the patch was invisible.
 *
 * The second tab is **absent rather than empty when there is no original**, which is
 * a real and common state: a `create` patch is a file the repository does not have,
 * so `source=repo` 404s. Rendering the whole file as added would say the patch
 * rewrites something, when what it does is add it.
 *
 * Tabs rather than panes side by side, and the reason is width: a diff cannot wrap
 * without lying about its indentation (`DiffView` owns its own horizontal scroll for
 * exactly that), and two of them beside a textarea inside a dialog leaves each about
 * 200px on a laptop.
 *
 * `DiffView`'s scrollbar only exists if the dialog's grid item around these tabs
 * may shrink below a diff line's width, which is `patch-editor-modal.tsx`'s
 * `min-w-0` on `Modal.Body`. A class here cannot do it: these tabs are not
 * the grid item, so their minimum width does not size the dialog's column.
 */
export function PatchEditorTabs({
  filePath,
  draft,
  onDraft,
  rows,
  againstRepo,
}: {
  filePath: string;
  draft: string;
  onDraft: (next: string) => void;
  /** Loaded → editor: the change about to be saved. */
  rows: Rows;
  /** Repository → editor, or `null` when the repository has no such file. */
  againstRepo: Rows | null;
}) {
  const changed = hasChanges(rows);

  return (
    <Tabs defaultValue="edit">
      <Tabs.Bar aria-label="File and changes">
        <Tabs.Tab value="edit">Edit</Tabs.Tab>
        <Tabs.Tab value="diff">
          Changes{changed ? ` (${countChanges(rows)})` : ""}
        </Tabs.Tab>
        {againstRepo ? (
          <Tabs.Tab value="repo">
            Against the repository
            {hasChanges(againstRepo) ? ` (${countChanges(againstRepo)})` : ""}
          </Tabs.Tab>
        ) : null}
      </Tabs.Bar>

      <Tabs.Panel value="edit" className="pt-3">
        <Textarea
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          spellCheck={false}
          aria-label={`Contents of ${filePath}`}
          className="max-h-96 min-h-64 overflow-auto font-mono text-meta leading-log"
        />
      </Tabs.Panel>

      <Tabs.Panel value="diff" className="pt-3">
        {changed ? (
          <DiffView label={`What you are changing in ${filePath}`} rows={rows} />
        ) : (
          <p className="rounded-lg border border-line bg-panel-2 px-3 py-6 text-center text-body text-tx-2">
            Nothing has been changed yet.
          </p>
        )}
        <p className="mt-2.5 text-meta text-tx-2">
          This compares what was loaded against what is in the editor — the change
          you are about to save.{" "}
          {againstRepo ? (
            <>
              For what the patch replaces in your repository, see{" "}
              <strong className="font-medium text-tx-2">
                Against the repository
              </strong>
              .
            </>
          ) : (
            <>
              Your repository has no <span className="font-mono">{filePath}</span>,
              so this patch adds the file rather than replacing one — there is
              nothing to compare it against.
            </>
          )}
        </p>
      </Tabs.Panel>

      {againstRepo ? (
        <Tabs.Panel value="repo" className="pt-3">
          {hasChanges(againstRepo) ? (
            <DiffView
              label={`What this patch replaces in ${filePath}`}
              rows={againstRepo}
            />
          ) : (
            <p className="rounded-lg border border-line bg-panel-2 px-3 py-6 text-center text-body text-tx-2">
              Identical to the repository&rsquo;s copy, so this patch would change
              nothing at build time.
            </p>
          )}
          <p className="mt-2.5 text-meta text-tx-2">
            Your repository&rsquo;s own copy on the left, what the build will apply
            on the right — the whole effect of this patch, not just what you have
            typed.{" "}
            <strong className="font-medium text-tx-2">
              Your repository is never written to
            </strong>
            ; the patch is applied to Cloudgate&rsquo;s clone before each build.
          </p>
        </Tabs.Panel>
      ) : null}
    </Tabs>
  );
}

function countChanges(rows: Rows): number {
  return rows.filter((row) => row.kind !== "ctx").length;
}
