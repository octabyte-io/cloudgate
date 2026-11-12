import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import type { Mount, MountType } from "@/lib/api/endpoints/mounts";

import type { ResourceSpec } from "./resource-spec";
import { example } from "@/components/console/form-spec";

/**
 * Volumes, bind mounts and file mounts — one table, three shapes.
 *
 * The row is polymorphic, and **which optional column matters for which `type`
 * is still unvalidated at the backend**: `createMountSchema` enforces none of
 * that pairing, and says so in its own comment. So a bind mount saved with no host path is accepted, stored, and then
 * fails at deploy time with a Docker error that names nothing on this screen.
 * The four presence refinements below are therefore not belt-and-braces — for
 * the polymorphic rule they are the only check there is.
 *
 * What is **not** left to this screen is the *content* of those paths. `filePath`
 * is held to a traversal rule at the backend DTO — `filePathSchema` in
 * `backend/src/mounts/dto/mount.dto.ts` (exported for two callers that
 * bypass the request pipe) — and `volumeName` to
 * Docker's object-name grammar by `volumeNameSchema` beside it. Neither is
 * mirrored here, deliberately: CODING_STANDARDS §2.4 puts validation in one
 * place, and a client-side copy of a security rule is the second copy that
 * section exists to forbid. A reader who wants to know what a `filePath` may be
 * has to read the DTO, and that is the intended answer.
 *
 * Three kinds, and the difference is worth stating on the screen because picking
 * the wrong one is a data-loss bug rather than a configuration one:
 *
 * - **volume** — a named Docker volume. Survives the container, is what a
 *   database or an uploads directory wants, and is what a volume backup can tar.
 * - **bind** — a path on the host. Ties the Application to one machine and
 *   whatever is at that path, which is fine for a socket and wrong for data.
 * - **file** — content this screen holds, written into the container at deploy.
 *   Encrypted at rest, and its host copy sits in a Service directory only
 *   root can open, so it can carry a credential.
 */

const TYPES = [
  { value: "volume", label: "Volume — a named Docker volume" },
  { value: "bind", label: "Bind — a path on the host" },
  { value: "file", label: "File — content written at deploy time" },
] as const;

const schema = z
  .object({
    type: z.enum(["bind", "volume", "file"]),
    // `mountPath` is the one field carrying a *shape* rule client-side, and the
    // reason it is not the copy §2.4 forbids: the leading slash is not a
    // security rule and has no counterpart at the backend to duplicate —
    // `createMountSchema`'s `mountPath` is `.min(1)` and a `.describe()` and
    // nothing more. It is a container-path fact the operator can be told about
    // before spending a round trip on it, at the field they would go and fix.
    // Everything below this line is presence, not shape.
    mountPath: z
      .string()
      .trim()
      .min(1, "A mount needs a path inside the container.")
      .startsWith("/", "The mount path has to start with a slash."),
    hostPath: z.string().trim(),
    volumeName: z.string().trim(),
    filePath: z.string().trim(),
    content: z.string(),
  })
  // Pathed onto the field each rule is about, so the message lands where the
  // person would go and change it rather than above the buttons.
  .refine((v) => v.type !== "volume" || v.volumeName !== "", {
    path: ["volumeName"],
    message: "A volume mount needs a volume name.",
  })
  .refine((v) => v.type !== "bind" || v.hostPath !== "", {
    path: ["hostPath"],
    message: "A bind mount needs a path on the host.",
  })
  .refine((v) => v.type !== "file" || v.filePath !== "", {
    path: ["filePath"],
    message: "A file mount needs a file name.",
  });

export type MountValues = z.infer<typeof schema>;

export function mountsSpec({
  applicationId,
  create,
  update,
  remove,
}: {
  applicationId: string;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (mountId: string, input: Record<string, unknown>) => Promise<unknown>;
  remove: (mountId: string) => Promise<unknown>;
}): ResourceSpec<Mount, MountValues> {
  return {
    noun: "mount",
    plural: "mounts",
    title: "Volumes and mounts",
    lede: "What this Application can read and write outside its own filesystem.",
    icon: "hdd",
    addLabel: "Add a mount",
    emptyTitle: "Nothing is mounted yet",
    emptyBody:
      "Add a mount to keep what this Application writes. Without one, it goes on every Deployment, when the container is replaced.",
    defaultSort: { id: "mountPath", dir: "asc" },
    getRowId: (row) => row.mountId,
    rowName: (row) => row.mountPath,

    columns: [
      {
        id: "mountPath",
        head: "Mount path",
        tone: "key",
        cell: (row) => <span className="font-mono text-meta">{row.mountPath}</span>,
        compare: (a, b) => a.mountPath.localeCompare(b.mountPath),
      },
      {
        id: "type",
        head: "Kind",
        cell: (row) => <Chip>{TYPE_WORD[row.type]}</Chip>,
        compare: (a, b) => a.type.localeCompare(b.type),
      },
      {
        id: "source",
        head: "Source",
        tone: "wrap",
        cell: (row) => {
          const source = sourceOf(row);
          return source ? (
            <span className="font-mono text-meta wrap-anywhere text-tx-2">
              {source}
            </span>
          ) : (
            // Not an em dash on its own: this is the column that says a mount
            // will fail at deploy time, and it has to carry the word.
            <Dash word="Not set" />
          );
        },
      },
    ],

    schema,
    fields: [
      {
        kind: "select",
        name: "type",
        label: "Kind",
        options: TYPES,
        hint: "A volume survives the container. A bind ties this Application to one host. A file is written from what you type here.",
      },
      {
        kind: "text",
        name: "mountPath",
        label: "Mount path",
        mono: true,
        placeholder: "/app/data",
        // One field serves all three kinds, and for a file it means something
        // narrower than the word suggests: `generateFileMounts` binds
        // the file *onto* this path — `Target` is the mount path verbatim — so
        // it is the file's own full path, not a directory it lands in. Said
        // here rather than by changing `Target` to `mountPath/filePath`,
        // because every file mount already stored was written to that meaning
        // (the API's own examples give `/app/config.json`), and re-reading them
        // would move each one's file on its next Deployment.
        hint: "Where it appears inside the container. For a file, the full path of the file itself, such as /etc/app/config.yml.",
      },
      {
        kind: "text",
        name: "volumeName",
        label: "Volume name",
        mono: true,
        placeholder: example("storefront-uploads"),
        when: (v) => v.type === "volume",
        hint: "The Docker volume. It is created on first use, and this is the name a volume backup tars.",
      },
      {
        kind: "text",
        name: "hostPath",
        label: "Host path",
        mono: true,
        placeholder: "/var/run/docker.sock",
        when: (v) => v.type === "bind",
        hint: "The path on the Server. This Application will only run where that path exists.",
      },
      {
        kind: "text",
        name: "filePath",
        label: "File name",
        mono: true,
        placeholder: "config.yml",
        when: (v) => v.type === "file",
        hint: "The name of the copy kept on the Server. The container sees the content at the mount path above, not under it.",
      },
      {
        kind: "textarea",
        name: "content",
        label: "Content",
        mono: true,
        rows: 8,
        optional: true,
        when: (v) => v.type === "file",
        hint: "Encrypted at rest, and the copy written for the container sits in a directory only root can open, so this is the right place for a config file that carries a credential.",
      },
    ],

    toDefaults: (row) => ({
      type: (row?.type ?? "volume") as MountType,
      mountPath: row?.mountPath ?? "",
      hostPath: row?.hostPath ?? "",
      volumeName: row?.volumeName ?? "",
      filePath: row?.filePath ?? "",
      content: row?.content ?? "",
    }),

    // Only the columns this kind owns carry a value; the other two are left
    // out of both bodies. On a create that lands them as `NULL`. On a `PATCH`
    // absent means *unchanged*, which used to be answered here by sending `""`
    // — and that broke: `updateMountSchema` stopped typing these as
    // `z.string()` when `volumeName` became `volumeNameSchema` (`.min(1)` and a
    // grammar) and `filePath` became `filePathSchema` (which refuses `''`), so
    // every edit of every kind of mount answered 400 and the dialog, whose
    // hidden fields the issues named, showed nothing.
    //
    // What `""` was there for is still needed: a volume mount switched to a
    // bind kept `volume_name=checkout-uploads` beside its new `host_path`, so
    // the row claimed two sources. That clear now happens **at the backend** —
    // `MountsService.update` nulls the old kind's columns when `type` changes
    // (`UNOWNED_BY` there says which those are). The two have to stay in step:
    // if this ever sends a column the new kind does not own, that map is what
    // decides whether it survives.
    // What `/mounts` asks of each write. The edit is `volume: ['create']`
    // too: that is what its `PATCH` names, and there is no `update` to ask for.
    permissions: {
      create: { volume: ["create"] },
      update: { volume: ["create"] },
      remove: { volume: ["delete"] },
    },
    create: (values) =>
      create({
        ...bodyOf(values),
        serviceType: "application",
        serviceId: applicationId,
      }),
    update: (row, values) => update(row.mountId, bodyOf(values)),
    remove: (row) => remove(row.mountId),

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.mountPath}</strong> stops
        being mounted on the next Deployment.{" "}
        {row.type === "volume"
          ? "The Docker volume itself is not deleted — its contents stay on the Server."
          : row.type === "bind"
            ? "Nothing on the host is touched."
            : "The file content held here is deleted with the mount."}
      </>
    ),
  };
}

const TYPE_WORD: Record<MountType, string> = {
  volume: "Volume",
  bind: "Bind",
  file: "File",
};

function sourceOf(row: Mount): string | null {
  if (row.type === "volume") return row.volumeName;
  if (row.type === "bind") return row.hostPath;
  return row.filePath;
}

/**
 * The body for one kind of mount: the kind, the mount path, and only the
 * columns that kind owns. The rest are `undefined`, which `JSON.stringify`
 * drops, so they are not in the request at all.
 */
function bodyOf(values: MountValues): Record<string, unknown> {
  return {
    type: values.type,
    mountPath: values.mountPath,
    volumeName: values.type === "volume" ? values.volumeName : undefined,
    hostPath: values.type === "bind" ? values.hostPath : undefined,
    filePath: values.type === "file" ? values.filePath : undefined,
    content: values.type === "file" ? values.content : undefined,
  };
}
