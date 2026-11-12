import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { EmptyState } from "@/components/console/empty-state";
import { menuRowClass } from "@/components/console/menu";
import { SearchInput } from "@/components/console/search-input";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { DirectoryEntry } from "@/lib/api/endpoints/patches";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { cn } from "@/lib/utils";

/**
 * The source repository, browsable — so a patch is written against a file
 * somebody has looked at rather than a path they remembered.
 *
 * **Cloning is a button, not a page load.** `POST /patches/repo/ensure` runs a
 * `git clone` on the Server and answers with the path it cloned to; that path is
 * the only thing the directory listing can be asked for, so nothing here works
 * until someone presses it. Doing it automatically would mean opening this tab
 * clones a repository over SSH, which is a surprising amount of work for a click
 * that might have been a mis-click.
 *
 * **A flat searchable list, not a tree.** The backend answers with
 * `git ls-tree -r` folded into a tree (`buildDirectoryTree`), and folding it back
 * out is the right call for what this is used for: someone opens this knowing
 * roughly what the file is called — `Dockerfile`, `next.config.ts`,
 * `nginx/default.conf` — and typing four characters beats expanding four
 * directories. It is also the reason `repository-picker.tsx` exists in F09, and
 * the same `MenuRow` is what both are built from.
 */
export function PatchBrowser({
  repoPath,
  entries,
  pending,
  error,
  cloning,
  onClone,
  onOpen,
  patchedPaths,
}: {
  repoPath: string | null;
  entries: DirectoryEntry[] | undefined;
  pending: boolean;
  error: unknown;
  cloning: boolean;
  onClone: () => Promise<unknown>;
  onOpen: (filePath: string) => void;
  /** Paths that already have a patch, so the list says which. */
  patchedPaths: Set<string>;
}) {
  const [filter, setFilter] = useState("");

  const files = flatten(entries ?? []);
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? files.filter((path) => path.toLowerCase().includes(needle))
    : files;

  return (
    <Card>
      <Card.Header
        title="Repository files"
        sub="The source this Application builds from, as the patch tree sees it."
        headingLevel={2}
        actions={
          <Button
            size="sm"
            disabled={cloning}
            aria-busy={cloning || undefined}
            onClick={async () => {
              try {
                await onClone();
                toast.done("Repository cloned.", {
                  description: "Its tracked files are listed below.",
                });
              } catch (caught) {
                toast.error(caught);
              }
            }}
          >
            <Icon name="refresh" size={14} />
            {repoPath ? "Clone again" : "Clone the source"}
          </Button>
        }
      />

      {repoPath === null ? (
        <Card.Body flush>
          <EmptyState icon="folder" title="The source has not been cloned yet">
            Clone the source to write patches against real files. It runs on
            the Server and takes as long as a{" "}
            <code className="font-mono">git clone</code> of this repository.
          </EmptyState>
        </Card.Body>
      ) : error ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(error)}</p>
        </Card.Body>
      ) : pending ? (
        <Card.Body>
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        </Card.Body>
      ) : (
        <>
          <Card.Body className="pb-2.5">
            <SearchInput
              label="Filter files"
              placeholder="Filter files"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </Card.Body>
          <Card.Body flush>
            {shown.length === 0 ? (
              <p className="px-4 py-6 text-center text-body text-tx-2">
                {files.length === 0
                  ? "The clone holds no tracked files. An empty repository, or a branch with nothing on it."
                  : `Nothing matches “${filter}”.`}
              </p>
            ) : (
              <ul className="max-h-96 overflow-auto p-1.5">
                {shown.map((path) => (
                  <li key={path}>
                    {/*
                      `menuRowClass` rather than `MenuRow`, which is what that
                      class is exported for: this row needs a second element
                      after the label, and `MenuRow` wraps its children in a
                      `truncate` span — which would clip the badge instead of the
                      path. Same height, same padding, same hover.
                    */}
                    <button
                      type="button"
                      onClick={() => onOpen(path)}
                      className={cn(menuRowClass, "w-full")}
                    >
                      <Icon name="panel" className="flex-none text-tx-3" />
                      <span
                        title={path}
                        className="min-w-0 flex-1 truncate text-left font-mono text-meta"
                      >
                        {path}
                      </span>
                      {patchedPaths.has(path) ? (
                        <Chip variant="brand" className="flex-none">
                          patched
                        </Chip>
                      ) : null}
                      <Icon name="chevR" className="flex-none text-tx-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card.Body>
          <Card.Footer>
            {shown.length === files.length
              ? `${files.length} tracked ${files.length === 1 ? "file" : "files"}.`
              : `Showing ${shown.length} of ${counted(files.length, "file", "files")}.`}
          </Card.Footer>
        </>
      )}
    </Card>
  );
}

/** The tree, back to the `git ls-tree -r` paths it was folded from. */
function flatten(entries: DirectoryEntry[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: DirectoryEntry[]) => {
    for (const node of nodes) {
      if (node.type === "file") paths.push(node.path);
      if (node.children) walk(node.children);
    }
  };
  walk(entries);
  return paths.sort((a, b) => a.localeCompare(b));
}
