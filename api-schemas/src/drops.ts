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
