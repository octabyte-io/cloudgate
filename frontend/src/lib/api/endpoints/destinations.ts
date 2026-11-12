import { api } from "../client";

/**
 * `destinations.controller.ts` — the S3-compatible buckets backups are written
 * to, scoped to the Organization.
 *
 * F10 declared the read half to fill a volume backup's destination picker;
 * **F15 fills in the writes and the reachability check.**
 *
 * `secretAccessKey` never comes back — `destinations.service.ts` strips it
 * explicitly on the way out, which is the pattern
 * `ssh-keys` is missing. The type below reflects what actually arrives.
 *
 * **There are two reachability checks, and they answer different questions.**
 * `POST /destinations/test-connection` takes the whole payload, which is the
 * create case: a bucket you have not proved you can reach is a bucket you find
 * out about during a restore. `POST /:id/test-connection` takes the id and reads
 * the credentials off the row server-side
 * which is the
 * operational case — a bucket whose policy changed under you looks exactly like
 * one that still works.
 *
 * Neither answer can carry the secret: rclone's refusal really does quote the
 * credentials back, and the backend masks them before the message leaves it.
 *
 * `GET /:id/objects` **lists what is really in the bucket, bounded to the
 * Services the caller is entitled to**,
 * which is what
 * lets the volume restore flow offer a tarball to pick instead of asking for an
 * S3 key to be typed from memory.
 *
 * A Destination's bucket is Organization-wide, so this route used to hand every
 * Service's tarball and dump keys — and with them every other Service's
 * `appName`, cadence and retention — to anyone who could reach it. It is a
 * *filter* and not a refusal, the same shape `GET /backups/files` took under
 * Keys under a prefix owned by a Service the caller is not entitled to
 * drop out, a prefix **no** Service claims stays listed so disaster recovery
 * after a Service is destroyed and recreated still works, and every row the
 * picker offers is now one `POST /volume-backups/restore` will accept.
 */

export interface Destination {
  destinationId: string;
  name: string;
  provider: string | null;
  accessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
  createdAt: string;
  organizationId: string;
}

/**
 * `createDestinationSchema`. `region` and `endpoint` are **required strings that
 * may be empty** — an S3-compatible provider that has no concept of a region
 * still has to send the field.
 */
export interface DestinationInput {
  name: string;
  provider?: string | null;
  accessKey: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/**
 * One object in a destination's bucket. `key` is bucket-relative and is exactly
 * what `POST /volume-backups/restore` wants as its `backupFileName`.
 */
export interface DestinationObject {
  key: string;
  /** Bytes. */
  size: number;
  /** RFC 3339. */
  lastModified: string;
}

export const destinationsApi = {
  list: () => api.get<Destination[]>("/destinations"),

  findOne: (destinationId: string) =>
    api.get<Destination>(`/destinations/${destinationId}`),

  /**
   * What is in the bucket under `prefix`, newest first, at most 200. The
   * listing is **recursive**, so a volume backup's own directory
   * (`<appName>/`) returns its tarballs however deep the backup's prefix nests
   * them. An empty `prefix` lists the whole bucket.
   */
  listObjects: (
    destinationId: string,
    prefix?: string,
    /** The Server to list from; omitted, this Cloudgate host. */
    serverId?: string,
  ) =>
    api.get<DestinationObject[]>(`/destinations/${destinationId}/objects`, {
      query: serverId ? { prefix, serverId } : { prefix },
    }),

  create: (body: DestinationInput) =>
    api.post<Destination>("/destinations", body),

  /** Partial. Omitting `secretAccessKey` keeps the stored one. */
  update: (destinationId: string, body: Partial<DestinationInput>) =>
    api.patch<Destination>(`/destinations/${destinationId}`, body),

  remove: (destinationId: string) =>
    api.delete<Destination>(`/destinations/${destinationId}`),

  /**
   * Probes the bucket from a Server — or from the platform's own host when
   * `serverId` is omitted. Answers nothing useful on success; **what it is for
   * is the refusal**, which carries rclone's own words about what failed.
   */
  testConnection: (body: DestinationInput & { serverId?: string | null }) =>
    api.post<unknown>("/destinations/test-connection", body),

  /**
   * Probes the bucket **as it is saved** — the credentials come off the row, so
   * nothing has to be typed in.
   *
   * `serverId` is still a parameter rather than something read off the row,
   * because it is not a property of the destination: reachable from the
   * platform's own host and reachable from a particular Server are two different
   * answers, and which one you want is a question about where you are asking
   * from.
   */
  testSavedConnection: (destinationId: string, serverId?: string | null) =>
    api.post<unknown>(`/destinations/${destinationId}/test-connection`, {
      serverId,
    }),
};
