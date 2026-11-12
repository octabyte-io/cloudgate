import { Dash } from "@/components/console/dash";
import type { Column } from "@/components/console/data-table";
import { Button } from "@/components/ui/button";
import type { BackupFile } from "@/lib/api/endpoints/backups";
import { Icon } from "@/lib/design/icons";
import { readBytes } from "@/lib/format/units";

/**
 * One row per object in the bucket — and **a directory is a row, not noise.**
 *
 * Found by pointing this at a real bucket: `rclone lsjson` is **not recursive**,
 * so listing `<appName>/` when the dumps live at `<appName>/<prefix>/<file>`
 * returns one *directory* and no files. Filtering directories out — which is what
 * this did first — turned a folder full of dumps into "Nothing here yet", the exact
 * lie this codebase keeps warning about: a confident claim about the bucket made
 * because of how the route happens to page. So a directory is something you open,
 * and the search box is the path.
 */
export function backupFileColumns({
  onOpen,
  onRestore,
}: {
  onOpen: (file: BackupFile) => void;
  /** Offered per row when the restore flow can take it from here. */
  onRestore?: (file: BackupFile) => void;
}): Column<BackupFile>[] {
  return [
    {
      id: "name",
      head: "File",
      tone: "key",
      cell: (row) =>
        row.IsDir ? (
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="inline-flex items-center gap-2 font-mono text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            <Icon name="folder" size={14} className="flex-none" />
            {row.Name}/
          </button>
        ) : (
          <span className="font-mono">{row.Name}</span>
        ),
      compare: (a, b) => a.Name.localeCompare(b.Name),
    },
    {
      id: "path",
      head: "Key",
      tone: "wrap",
      className: "font-mono wrap-anywhere text-tx-3",
      cell: (row) => row.Path,
    },
    {
      id: "size",
      head: "Size",
      tone: "num",
      // A directory's size is `-1` from rclone, which is not a size.
      cell: (row) => (row.IsDir ? <Dash word="A folder" /> : readBytes(row.Size)),
      compare: (a, b) => a.Size - b.Size,
    },
    ...(onRestore
      ? [
          {
            id: "actions",
            head: <span className="sr-only">Actions</span>,
            className: "w-0",
            // Only a real file can be restored; a folder is a place to look,
            // not a dump.
            cell: (row: BackupFile) =>
              row.IsDir ? null : (
                <span className="inline-flex justify-end whitespace-nowrap">
                  <Button size="xs" variant="dngr" onClick={() => onRestore(row)}>
                    Restore
                  </Button>
                </span>
              ),
          },
        ]
      : []),
  ];
}
