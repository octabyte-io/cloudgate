import { z } from 'zod';

/**
 * The upload half of a deploy from a folder: `POST
 * /applications/:id/drop`, a multipart request whose `zip` part is the
 * archive. Deploying it stays `POST /applications/:id/deployments`, a second
 * call (CLI spec, Server changes).
 */

/**
 * The upload's non-file fields. Multipart fields are always strings;
 * `dropBuildPath` is the folder in the archive the build starts in, `/` when
 * omitted. `cloudgate deploy` always lands the folder at the build root.
 */
export const uploadApplicationDropSchema = z.object({
  dropBuildPath: z.string().min(1).optional(),
});

/**
 * The upload's answer, as far as the CLI reads it: the updated Application
 * row, whose source is now uploaded files. Only these fields — the row also
 * carries the Application's decrypted variables, which nothing the CLI prints
 * may hold.
 */
export const uploadedDropSchema = z.object({
  applicationId: z.string(),
  sourceType: z.literal('drop'),
});

export type UploadedDrop = z.infer<typeof uploadedDropSchema>;

/**
 * Uploading only what changed, beside the full upload above (spec #10): two
 * multipart routes whose `files` part is the folder's file list as JSON, a
 * {@link dropFileListSchema}.
 *
 * - `POST /applications/:id/drop/compare` takes `files` alone and answers a
 *   {@link DropComparison}: which of the listed files the build host is
 *   missing or holds different, and how many it holds already and will
 *   delete.
 * - `POST /applications/:id/drop/apply` takes `files`, a `zip` part holding
 *   only the files compare asked for, and the {@link uploadApplicationDropSchema}
 *   fields. It answers what `/drop` answers, an {@link UploadedDrop}, or a
 *   409 {@link UPLOAD_CONFLICT_CODE} when the tree it built did not match the
 *   list, leaving the previous one in place, or the apply failed.
 *
 * The list is a file part rather than a field or a JSON body: the
 * application-wide JSON parser stops at 100 kB and a multipart field at 1 MB,
 * which a big folder's list passes.
 */

/**
 * One file of the folder: its path, slash-separated and relative to the
 * folder in its plain form (no `./`, no `..`, no leading `/`), and the SHA-256
 * of its contents as 64 lowercase hex digits.
 */
export const dropFileSchema = z.object({
  path: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex digits'),
});

export type DropFile = z.infer<typeof dropFileSchema>;

/** Every file of the folder, each path once. */
export const dropFileListSchema = z.array(dropFileSchema);

/** What compare answers. */
export const dropComparisonSchema = z.object({
  /** The listed paths whose file the build host lacks or holds different. */
  missing: z.array(z.string()),
  /** How many listed files the build host already holds as they are. */
  unchanged: z.number().int(),
  /** How many files on the build host are not in the list, so go on apply. */
  deleted: z.number().int(),
});

export type DropComparison = z.infer<typeof dropComparisonSchema>;

/**
 * The `code` of the 409 an apply earns when the tree it built does not match
 * the list, or the apply failed: the build host's tree changed since the
 * comparison, the upload did not land whole, or the build host could not be
 * reached. The message says which; `cloudgate deploy` prints it and compares
 * again once.
 */
export const UPLOAD_CONFLICT_CODE = 'UPLOAD_CONFLICT';

/**
 * The `code` of the 409 an upload earns while a build of the Application is
 * pending or running: an upload first deletes the tree that build
 * reads. `cloudgate deploy` waits for the build and uploads again.
 */
export const DEPLOYMENT_IN_PROGRESS_CODE = 'DEPLOYMENT_IN_PROGRESS';

/**
 * A build pending or running for longer than this is taken as stuck (CLI
 * spec, "very old"): it no longer holds the tree, so the server takes an
 * upload and `cloudgate deploy` goes ahead with a warning rather than wait
 * on it forever. Shared so both sides draw the line at the same minute.
 */
export const STUCK_DEPLOYMENT_MINUTES = 60;
