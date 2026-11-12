import { ConflictException } from '@nestjs/common';

/**
 * The `code` of a 409 refusing container work for a Service in a Cloud
 * account, so the console and the MCP tools can tell it from any other
 * refusal (ADR-0005).
 */
export const CLOUD_SERVICE_HAS_NO_CONTAINER_CODE =
  'CLOUD_SERVICE_HAS_NO_CONTAINER';

/** Which work a refusal names. */
export type CloudServiceHostWork =
  'volumeBackups' | 'mounts' | 'commandSchedules' | 'backups';

/**
 * The work that needs a Service's own container or volume, each with what it
 * is called and where a Service in a Cloud account keeps its equivalent.
 */
const HOST_WORK: Readonly<
  Record<
    CloudServiceHostWork,
    {
      readonly what: string;
      readonly instead: string;
      /** Replaces "so it has no container or volume…" where that is untrue. */
      readonly why?: string;
    }
  >
> = {
  volumeBackups: {
    what: 'Volume backups are',
    instead:
      "Keep its files in a Bucket, or its data in a database in that Cloud account, whose backups are its provider's own.",
  },
  mounts: {
    what: 'File and volume mounts are',
    instead:
      'Give it its settings as Environment variables, or keep its files in a Bucket.',
  },
  commandSchedules: {
    what: 'Command schedules are',
    instead:
      'Run a command on a timetable as a Cron service, which runs in that Cloud account.',
  },
  // A dump Backup and its restore run where the Service's `serverId` says,
  // and a Compose stack on its own Stack VM (ADR-0070) has `serverId: null`
  // like any Service in a Cloud account, so either would run on the platform
  // host, with the Destination's endpoint and keys.
  backups: {
    why: "so its Backups would run on this Cloudgate's own host rather than where it runs.",
    what: 'Backups and restores to a Destination are',
    instead:
      "A Compose stack there keeps its volumes on its Stack VM's data disk, which its cloud snapshots daily; a database there keeps its provider's own backups.",
  },
};

/** The fields of a Service the refusal reads (`ServiceParent` has both). */
export interface PlacedService {
  readonly name: string;
  /** Set when the Service runs in a Cloud account; null on a Server or the
   *  platform host, and for every kind no Cloud account can run. */
  readonly cloudAccountId: string | null;
}

/**
 * Whether a Service runs in a Cloud account, and so has no container and no
 * volume on any machine Cloudgate manages.
 *
 * Such a Service's `serverId` is `null`, and every exec dispatcher reads
 * `null` as the platform host. So any work that follows "the Service's
 * place" through `serverId` would land on the platform host, as root, for a
 * Service that does not run there. Asked by the sites that skip such
 * work rather than refuse it; `test/coding-standards/cloud-service-exec-census.spec.ts`
 * holds every exec site to this or to {@link refuseCloudServiceHostWork}.
 */
export function isCloudService(service: PlacedService): boolean {
  return Boolean(service.cloudAccountId);
}

/**
 * Refuses work that runs in a Service's own container or on its own volume,
 * for a Service in a Cloud account, with a 409 that says where that Service's
 * equivalent lives. In every instance mode: on a Self-hosted instance the work
 * would run on the platform host, which is not where the Service is either.
 *
 * Asked at create and update, so no such row is saved, and again at every
 * run, so a row saved before this refusal cannot run.
 *
 * A database in a Cloud account is refused a volume backup before this, by
 * `refuseCloudDatabaseDump`, with its own code; this covers every other kind
 * a Cloud account can run (an Application, a Bucket) and every surface.
 */
export function refuseCloudServiceHostWork(
  service: PlacedService,
  work: CloudServiceHostWork,
): void {
  if (!isCloudService(service)) return;
  const {
    what,
    instead,
    why = 'so it has no container or volume on a machine Cloudgate manages.',
  } = HOST_WORK[work];
  throw new ConflictException({
    message: `${service.name} runs in a Cloud account, ${why} ${what} Server-only. ${instead}`,
    code: CLOUD_SERVICE_HAS_NO_CONTAINER_CODE,
  });
}
