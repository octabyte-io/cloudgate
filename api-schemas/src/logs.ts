import { z } from "zod";

/**
 * The reads `cloudgate logs` makes for a Service's Runtime log.
 *
 * **Only the fields logs reads**, as in `status.ts`: `GET /applications/:id`
 * carries the Application's decrypted `env`, `buildArgs` and `buildSecrets`,
 * and zod drops them here, so none can reach anything the CLI prints.
 */

/**
 * `GET /applications/:id`: where the Application runs (ADR-0035). A Cloud
 * account's runs there; otherwise the Server's, or the platform host's when
 * `serverId` is null. `appName` is its Swarm service's name.
 */
export const runtimeLogPlaceSchema = z.object({
  appName: z.string(),
  serverId: z.string().nullish(),
  cloudAccountId: z.string().nullish(),
});

/**
 * `GET /applications/:id/runtime-log?since=<ms>`, a Cloud-account Service's
 * Runtime log: every task's lines from `since`, merged by time, each
 * naming its task; the `since` of the next read; and whether lines were left
 * for it. Reads overlap a few seconds, so a line can come twice, with the
 * same `id`.
 */
export const runtimeLogReadSchema = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      /** Epoch milliseconds. */
      at: z.number(),
      task: z.string(),
      message: z.string(),
    }),
  ),
  next: z.number(),
  more: z.boolean(),
});

export type RuntimeLogPlace = z.infer<typeof runtimeLogPlaceSchema>;
export type RuntimeLogRead = z.infer<typeof runtimeLogReadSchema>;
