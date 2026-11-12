import { Card } from "@/components/console/card";
import { CodeWell } from "@/components/console/code-well";
import { CopyButton } from "@/components/console/copy-button";
import { DiffView } from "@/components/console/diff-view";
import { Skeleton } from "@/components/console/skeleton";
import { Tabs } from "@/components/console/tabs";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { diffLines, hasChanges } from "@/lib/format/diff-lines";

import { useConvertedCompose, wasRefused } from "../use-compose";

/**
 * The rewritten file, from the platform's own copy of the rewrite.
 *
 * Two views behind `Tabs`, which is the shape `patch-editor-modal.tsx` settled on
 * for the same problem: a diff cannot wrap without lying about its indentation, so
 * two panes side by side inside a card leaves each too narrow to read. Tabs give
 * the whole measure to whichever one is being read.
 *
 * **The diff is only offered for a `raw` source**, and that is the honest half of
 * this card rather than a limitation of it: the "before" side is the stored
 * `composeFile`, and for the five git source types that column is empty because
 * the file lives in the repository. Diffing against `""` would render the entire
 * file as added, which reads as *the platform wrote all of this* — the confidently
 * wrong statement this tab exists to avoid.
 */
export function ConvertedFileCard({ compose }: { compose: ComposeDetail }) {
  const converted = useConvertedCompose(compose.composeId);
  const raw = compose.sourceType === "raw";
  const file = converted.data ?? "";
  const rows = diffLines(raw ? compose.composeFile : "", file);
  const changed = hasChanges(rows);

  return (
    <Card>
      <Card.Header
        title="The file this stack deploys"
        sub="Read from the platform, out of the same rewrite the deploy runs — not generated here."
        headingLevel={2}
        actions={
          converted.data ? (
            <CopyButton value={converted.data} label="converted file" />
          ) : null
        }
      />
      <Card.Body>
        {converted.error ? (
          /**
           * A 4xx is the stack's own configuration and reads as a finding; a 5xx
           * or a dropped connection means the read did not complete, which is a
           * different sentence. `wasRefused`'s distinction, applied to a read.
           */
          <p className="max-w-copy text-body text-tx-2">
            {errorMessage(converted.error)}{" "}
            {wasRefused(converted.error) ? (
              <>
                That is the rewrite refusing, and the deploy refuses in exactly the
                same place — so this is what a deploy would say now. The card above
                names which of the three it is.
              </>
            ) : (
              <>
                For a stack whose file is in its repository, this reads the clone on
                the build Server, so it answers nothing until the stack has been
                deployed once.
              </>
            )}
          </p>
        ) : converted.isPending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-plot w-full" />
          </div>
        ) : !raw ? (
          <>
            <CodeWell
              content={file}
              label={`${compose.name}'s compose file, as the deploy applies it`}
            />
            <p className="mt-2.5 max-w-copy text-meta text-tx-2">
              No diff for this stack:{" "}
              <strong className="font-medium text-tx-2">
                its file is in its repository
              </strong>
              , so Cloudgate holds the rewritten version and not the original.
              Comparing it against nothing would mark every line as added.
            </p>
          </>
        ) : (
          <Tabs defaultValue="file">
            <Tabs.Bar aria-label="The converted file and what the rewrite changed">
              <Tabs.Tab value="file">Converted file</Tabs.Tab>
              <Tabs.Tab value="diff">
                Changes{changed ? ` (${countChanges(rows)})` : ""}
              </Tabs.Tab>
            </Tabs.Bar>

            <Tabs.Panel value="file" className="pt-3">
              <CodeWell
                content={file}
                label={`${compose.name}'s compose file, as the deploy applies it`}
              />
            </Tabs.Panel>

            <Tabs.Panel value="diff" className="pt-3">
              {changed ? (
                <DiffView
                  label={`What the rewrite changes in ${compose.name}'s compose file`}
                  rows={rows}
                />
              ) : (
                <p className="rounded-lg border border-line bg-panel-2 px-3 py-6 text-center text-body text-tx-2">
                  The rewrite leaves this file exactly as it is.
                </p>
              )}
              {/* One column with a signed gutter, which is what `DiffView`
                  renders. This used to say "the stored file on the left, the
                  deploy's version on the right" — a description of a two-pane
                  layout that has never been on this card. */}
              <p className="mt-2.5 max-w-copy text-meta text-tx-2">
                One column: a &minus; line is in the file you store, a + line is
                in the version the deploy applies, and the rest is in both.
                Editing the file is the Overview tab; nothing here writes.
              </p>
            </Tabs.Panel>
          </Tabs>
        )}
      </Card.Body>
    </Card>
  );
}

function countChanges(rows: ReturnType<typeof diffLines>): number {
  return rows.filter((row) => row.kind !== "ctx").length;
}
