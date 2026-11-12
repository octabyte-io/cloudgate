import { z } from "zod";

import { GutterMark } from "@/components/console/gutter-mark";
import { RowTime } from "@/components/console/rows/cells";
import type { SourceType } from "@/lib/api/endpoints/applications";
import type { Patch, PatchType } from "@/lib/api/endpoints/patches";
import type { ChangeKey } from "@/lib/design/status";

import type { ResourceSpec } from "./resource-spec";

/**
 * Files this Application's build applies on top of its clone.
 *
 * A patch is not a diff — it is **a whole file plus what to do with it**, which
 * is the thing to get across on the list. `create` writes a file the repository
 * does not have, `update` replaces one it does, `delete` removes one.
 *
 * That three-way split is exactly what `GutterMark` is for, and this is the
 * console's second use of it: `+` creates, `⇆` changes, `−` destroys, each with
 * its word in an `sr-only` span because `+` and `−` are one pixel apart at 13px.
 * The `GUT` map is about what a plan does to a resource and a patch's `type` is
 * the same kind of statement, so the three map straight across.
 *
 * The form here edits a patch's **content directly**, which is the right control
 * for a patch someone is adjusting by hand. Writing one against a file you are
 * looking at is the editor, on the Patches panel — two doors to the same rows,
 * because `POST /patches/save-file` upserts by path, and so does
 * `POST /patches`, which is what makes the File hint below true.
 */

/**
 * What a patch can do for this Application's source, and there are three
 * answers rather than two, because the backend asks two separate questions:
 *
 * - **`never`**: a Docker image. `DeploymentEngineService` builds nothing for it
 *   and skips the patch step outright (`sourceType !== 'docker'`), so a patch
 *   is a row no build reads. The tab says so and offers neither Add nor Clone.
 * - **`no-repository`**: uploaded files. The build still runs and patches
 *   still apply to the extracted tree, but `CLONABLE_SOURCE_TYPES` has no
 *   repository to clone, and `POST /patches/repo/ensure` refuses with a 409.
 *   So Add stays and the file browser goes.
 * - **`applies`**: a git source. Everything works.
 *
 * Collapsing the first two into "not a git source" would hide Add from an
 * uploaded-files Application whose patches really do apply.
 */
export type PatchReach = "applies" | "no-repository" | "never";

export function patchReach(sourceType: SourceType): PatchReach {
  if (sourceType === "docker") return "never";
  if (sourceType === "drop") return "no-repository";
  return "applies";
}

const schema = z.object({
  filePath: z
    .string()
    .trim()
    .min(1, "A patch needs the path of the file it applies to.")
    .refine((value) => !value.startsWith("/"), {
      message: "The path is relative to the repository root, so it has no leading slash.",
    }),
  type: z.enum(["create", "update", "delete"]),
  content: z.string(),
  enabled: z.boolean(),
});

export type PatchValues = z.infer<typeof schema>;

/** A patch's type, as the change it makes. */
const CHANGE: Record<PatchType, ChangeKey> = {
  create: "create",
  update: "change",
  delete: "destroy",
};

const TYPE_WORD: Record<PatchType, string> = {
  create: "Creates this file",
  update: "Replaces this file",
  delete: "Removes this file",
};

export function patchesSpec({
  applicationId,
  create,
  update,
  remove,
}: {
  applicationId: string;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (patchId: string, input: Record<string, unknown>) => Promise<unknown>;
  remove: (patchId: string) => Promise<unknown>;
}): ResourceSpec<Patch, PatchValues> {
  return {
    noun: "patch",
    plural: "patches",
    title: "Patches",
    lede: "Files written over the clone before this Application is built.",
    icon: "pencil",
    addLabel: "Add a patch",
    emptyTitle: "No file is being patched",
    emptyBody:
      "Add a patch to change a file in the build without changing it in your repository — a lock file to pin, a Dockerfile line you cannot upstream yet.",
    defaultSort: { id: "filePath", dir: "asc" },
    getRowId: (row) => row.patchId,
    rowName: (row) => row.filePath,

    columns: [
      {
        id: "filePath",
        head: "File",
        tone: "key",
        truncate: true,
        cell: (row) => (
          <span className="flex min-w-0 items-baseline gap-2">
            <GutterMark change={CHANGE[row.type]} />
            <span
              title={row.filePath}
              className={
                // A disabled patch is skipped by the build. Struck through
                // *and* labelled in the next column — the line alone is a
                // visual convention, not a statement.
                row.enabled
                  ? "min-w-0 truncate font-mono text-meta"
                  : "min-w-0 truncate font-mono text-meta text-tx-3 line-through"
              }
            >
              {row.filePath}
            </span>
          </span>
        ),
        compare: (a, b) => a.filePath.localeCompare(b.filePath),
      },
      {
        id: "type",
        head: "What it does",
        tone: "wrap",
        cell: (row) => (
          <span className="text-tx-2">
            {TYPE_WORD[row.type]}
            {row.enabled ? "" : " — off, so the build skips it"}
          </span>
        ),
        compare: (a, b) => a.type.localeCompare(b.type),
      },
      {
        id: "updatedAt",
        head: "Changed",
        cell: (row) => <RowTime iso={row.updatedAt ?? row.createdAt} />,
        compare: (a, b) =>
          (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt),
      },
    ],

    schema,
    fields: [
      {
        kind: "text",
        name: "filePath",
        label: "File",
        mono: true,
        placeholder: "next.config.ts",
        hint: "Relative to the repository root. One patch per file — saving a second for the same path replaces the first.",
      },
      {
        kind: "select",
        name: "type",
        label: "What it does",
        options: [
          { value: "update", label: "Replace a file the repository has" },
          { value: "create", label: "Create a file the repository does not have" },
          { value: "delete", label: "Remove a file before the build" },
        ],
      },
      {
        kind: "textarea",
        name: "content",
        label: "Content",
        mono: true,
        rows: 12,
        optional: true,
        when: (values) => values.type !== "delete",
        hint: "The whole file, not a diff — this is written over the path above. Encrypted at rest, so a config carrying a credential belongs here rather than in the repository.",
      },
      {
        kind: "switch",
        name: "enabled",
        label: "Enabled",
        hint: "Turning it off leaves the patch in place and stops the build applying it.",
      },
    ],

    toDefaults: (row) => ({
      filePath: row?.filePath ?? "",
      type: (row?.type ?? "update") as PatchType,
      content: row?.content ?? "",
      enabled: row?.enabled ?? true,
    }),

    // What `/patches` asks of each write. The edit is `service: ['create']`
    // too, not `update`: that is what `PATCH /patches/:id` names, and a gate
    // asking for anything else could turn off an edit the route would allow.
    permissions: {
      create: { service: ["create"] },
      update: { service: ["create"] },
      remove: { service: ["delete"] },
    },
    create: (values) =>
      create({
        filePath: values.filePath,
        type: values.type,
        // A delete patch's content is meaningless and the service stores `''`
        // for one; sending whatever was typed before the type was switched
        // would leave a file's contents on a row that removes it.
        content: values.type === "delete" ? "" : values.content,
        enabled: values.enabled,
        applicationId,
      }),
    update: (row, values) =>
      update(row.patchId, {
        filePath: values.filePath,
        type: values.type,
        content: values.type === "delete" ? "" : values.content,
        enabled: values.enabled,
      }),
    remove: (row) => remove(row.patchId),

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.filePath}</strong> stops being
        patched, so the next build uses whatever your repository has at that path.
        Nothing in the repository changes.
      </>
    ),
  };
}
