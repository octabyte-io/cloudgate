import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { quote } from 'shell-quote';
import { findParentService, SERVICE_TABLES } from '../common/service-parent';
import type { ServiceParent } from '../common/service-parent';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import type { DrizzleDB } from '../db/drizzle.module';
import type {
  PermissionCtx,
  PermissionService,
} from '../rbac/permission.service';
import {
  withVolumeLock,
  isVolumeLockBusyError,
} from '../deployment-engine/volume-lock';
import { mount, mountServiceFk } from '../mounts/mount.schema';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { VOLUME_NAME_REGEX } from '../volume-backups/dto/volume-backup.dto';
import type { ServiceType, WorkloadServiceType } from './application.schema';

/**
 * The Application Delete's `?deleteVolumes=true`: the named volumes of
 * its own `volume`-type mounts, removed on its own Server, and every one it
 * would not or could not remove named in the response.
 *
 * **Which volumes.** Only `mount.type = 'volume'` rows of this Application —
 * `generateVolumeMounts` hands exactly `mount.volumeName` to Swarm as the
 * volume's `Source`, so that is the name on the daemon. A bind mount's
 * `hostPath` is the operator's own directory and a file mount's tree is
 * `reclaimFileMounts`' already; neither is touched here. **Which machine** is
 * `serverId`, the run Server, because a Swarm volume is created by the daemon
 * that runs the task (ADR-0018: each artifact on the machine that made it).
 *
 * **When a volume is kept rather than removed.** Three reasons, each a line in
 * the report rather than a failure of the Delete — a volume is data, and *"the
 * Application is gone but this volume is not"* is a state the operator can act
 * on, where a Delete refused over it would be the *forget this Application*
 * made uncompletable:
 *
 * 1. **Another Service on the same Server names it.** A mount row of any other
 *    Service, a managed database's own `<appName>-data`, or a Compose stack's
 *    `<appName>_…` project volume. The ticket named only the first; the other
 *    two are here because they are the cases where the removal would succeed —
 *    a stopped database or a stack that is down holds no container on its
 *    volume, so `docker volume rm` would destroy another Service's data without
 *    a word from Docker. The report names that Service when the caller could
 *    read it, and says only *"another Service"* otherwise: the platform host is
 *    shared by every Organization, and a name is not the caller's to learn.
 * 2. **Its Volume lock is held** — a backup, a restore or Remove containers is
 *    running on it. The removal takes the lock fail-fast like every other
 *    synchronous taker, so it neither waits out a `tar` nor removes a volume a
 *    restore is halfway through writing. The lock is the shell's (`flock` on a
 *    descriptor, or the `mkdir` fallback's EXIT trap), so it is released when
 *    the script ends on every path — success, a failed `rm`, or the refusal.
 * 3. **`docker volume rm` fails**, with Docker's own last line as the reason.
 *
 * **Why the script waits.** `docker service rm` returns while the task's
 * container is still stopping (Swarm's stop grace is 10 s), and a volume held
 * by a stopping container is refused `volume is in use` — `--force` does not
 * override that, which `databases/common/database-ops.ts` measured for a
 * rebuild. So the body polls the volume's holders until none are left or
 * its share of {@link VOLUME_RELEASE_TIMEOUT_MS} runs out, then
 * removes; a holder that outlasts it is Docker's refusal and reason 3. The
 * database helper is not reused: it polls from TypeScript with one exec per
 * read, and a Volume lock lives only as long as the one shell that took it, so
 * the wait has to be in the same script as the `rm` it guards. `--force` stays
 * for what it does do — a volume that was never created (an Application that
 * never deployed) exits 0 rather than being reported as left behind.
 */

/** How long the whole volume step may wait for a removed service's task to
 * let go of its volumes — the same minute a database rebuild allows,
 * shared across every volume of one Delete rather than granted to each.
 * Not the Application's alone: a database's data-volume Delete and an AI
 * model's weights volume wait the same minute. */
export const VOLUME_RELEASE_TIMEOUT_MS = 60_000;

/** The Application's own `volume`-type mounts' volume names, deduplicated. */
export async function applicationVolumeNames(
  db: DrizzleDB,
  applicationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ volumeName: mount.volumeName })
    .from(mount)
    .where(
      and(eq(mount.applicationId, applicationId), eq(mount.type, 'volume')),
    );
  return [
    ...new Set(rows.map((row) => row.volumeName).filter((name) => !!name)),
  ] as string[];
}

/**
 * The shell program that removes one volume under its Volume lock, once no
 * container holds it or `waitSeconds` have passed.
 *
 * Every interpolation is `quote()`d (§2.9), and the name has already passed
 * {@link VOLUME_NAME_REGEX} — a leading letter or digit, so it can never read
 * as an option to `docker volume rm` or as a mount destination to `--filter
 * volume=`, which matches one for a value starting with `/`.
 */
export const removeApplicationVolumeCommand = (
  serverId: string | null,
  volumeName: string,
  waitSeconds: number,
): string =>
  withVolumeLock(
    { serverId, volumeNames: [volumeName], mode: 'fail-fast' },
    `waited=0
		while [ -n "$(docker ps -a -q --filter ${quote([`volume=${volumeName}`])})" ] && [ "$waited" -lt ${Math.max(0, Math.floor(waitSeconds))} ]; do
			sleep 1
			waited=$((waited + 1))
		done
		docker volume rm --force ${quote([volumeName])}`,
  );

/**
 * Removes this Application's volumes on its run Server, and answers with the
 * ones it kept. Never throws for a volume: each outcome is a report line.
 *
 * `serviceGone` is the presence read's `'absent'`. A forced Delete reaches here
 * with the Swarm service unconfirmed, and then no volume is touched — the
 * ticket's *"after the Swarm service is confirmed gone"* — and each is reported
 * as kept with that reason.
 */
export async function reclaimApplicationVolumes(
  deps: {
    db: DrizzleDB;
    remoteExec: RemoteExecService;
    /** Whether the caller may learn the name of the Service that shares a
     * volume; `false` makes the report say only "another Service". */
    canName: (
      owner: ServiceParent & { serviceType: ServiceType },
    ) => Promise<boolean>;
  },
  current: { applicationId: string; appName: string; serverId: string | null },
  volumeNames: readonly string[],
  serviceGone: boolean,
): Promise<UnreclaimedArtifact[]> {
  const kept = (path: string, reason: string): UnreclaimedArtifact => ({
    kind: 'volume',
    appName: current.appName,
    serverId: current.serverId,
    path,
    reason,
  });
  if (volumeNames.length === 0) return [];
  if (!serviceGone) {
    return volumeNames.map((name) =>
      kept(
        name,
        "Kept: the Application's Swarm service could not be confirmed gone, so no volume was touched",
      ),
    );
  }

  const claims = await otherServicesClaiming(
    deps,
    {
      serviceType: 'application',
      serviceId: current.applicationId,
      serverId: current.serverId,
    },
    volumeNames,
  );
  const deadline = Date.now() + VOLUME_RELEASE_TIMEOUT_MS;
  const report: UnreclaimedArtifact[] = [];
  for (const name of volumeNames) {
    const claim = claims.get(name);
    if (claim) {
      report.push(kept(name, claim));
      continue;
    }
    if (!VOLUME_NAME_REGEX.test(name)) {
      report.push(
        kept(
          name,
          'Kept: not a volume name Cloudgate will pass to docker volume rm',
        ),
      );
      continue;
    }
    const why = await removeVolumeOn(
      deps.remoteExec,
      current.serverId,
      name,
      deadline,
    );
    if (why) report.push(kept(name, why));
  }
  return report;
}

/**
 * Whether a Delete's volume report may name the Service that shares a volume:
 * only one in the caller's own Organization that the caller could read. The
 * platform host is every Organization's, so a Service there can be anyone's,
 * and a name is not the caller's to learn by deleting something. The
 * `canName` both the Application Delete and a database's data-volume Delete
 * hand {@link otherServicesClaiming}.
 */
export async function callerMayName(
  permissions: PermissionService,
  ctx: PermissionCtx,
  owner: { serviceId: string; organizationId: string },
): Promise<boolean> {
  if (owner.organizationId !== ctx.session.activeOrganizationId) return false;
  try {
    await permissions.checkServiceAccess(ctx, owner.serviceId, 'read');
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes one volume on `serverId` once its task lets go or `deadline` (an
 * epoch-ms instant shared by every volume of one Delete) has passed, and
 * answers `null`, or the report's reason it was kept. Never throws. Shared by
 * the operator's own volumes above and an AI model's weights volume
 * (`ai-models/weights-volume.ts`).
 */
export async function removeVolumeOn(
  remoteExec: RemoteExecService,
  serverId: string | null,
  volumeName: string,
  deadline: number,
): Promise<string | null> {
  const waitSeconds = Math.ceil(Math.max(0, deadline - Date.now()) / 1000);
  try {
    await execOnServer(
      remoteExec,
      serverId,
      removeApplicationVolumeCommand(serverId, volumeName, waitSeconds),
    );
    return null;
  } catch (error) {
    return isVolumeLockBusyError(error)
      ? 'Kept: its Volume lock is held — a volume backup, a restore or Remove containers is running on it. Remove it once that finishes'
      : `Kept: docker volume rm failed — ${failureLine(error)}`;
  }
}

/** Docker's last line of complaint, or the exec layer's message without one. */
function failureLine(error: unknown): string {
  const { stderr, message } = (error ?? {}) as {
    stderr?: string;
    message?: string;
  };
  const line = (stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return (line ?? message ?? 'unknown error').slice(0, 300);
}

/**
 * For each volume another Service on the same Server claims, the report's
 * sentence naming it. Three kinds of claim, the file docblock's reason 1.
 * `current` is the Service being deleted, whose own claims do not count:
 * an Application here, or a managed database removing its `<appName>-data`
 * (`databases/common/database-service.ts`), which would otherwise be its own
 * claimant.
 */
export async function otherServicesClaiming(
  deps: {
    db: DrizzleDB;
    canName: (
      owner: ServiceParent & { serviceType: ServiceType },
    ) => Promise<boolean>;
  },
  current: {
    serviceType: WorkloadServiceType;
    serviceId: string;
    serverId: string | null;
  },
  volumeNames: readonly string[],
): Promise<Map<string, string>> {
  const ownFk = mountServiceFk[current.serviceType];
  const { db } = deps;
  const candidates: {
    volumeName: string;
    serviceType: ServiceType;
    serviceId: string;
  }[] = [];

  // Another Service's own mount row naming the volume.
  const mountRows = await db
    .select({
      volumeName: mount.volumeName,
      serviceType: mount.serviceType,
      ...mountServiceFk,
    })
    .from(mount)
    .where(
      and(
        eq(mount.type, 'volume'),
        inArray(mount.volumeName, [...volumeNames]),
        or(isNull(ownFk), ne(ownFk, current.serviceId)),
      ),
    );
  for (const row of mountRows) {
    const serviceType = row.serviceType;
    const serviceId = row[serviceType];
    if (row.volumeName && serviceId) {
      candidates.push({ volumeName: row.volumeName, serviceType, serviceId });
    }
  }

  // A managed database's own data volume, `<appName>-data`.
  const engines: ServiceType[] = [
    'postgres',
    'mysql',
    'mariadb',
    'mongo',
    'redis',
    'libsql',
  ];
  const dataOwners = volumeNames
    .filter((name) => name.endsWith('-data'))
    .map((name) => ({
      volumeName: name,
      appName: name.slice(0, -'-data'.length),
    }));
  // A Compose stack's project volume, `<appName>_<volume>`.
  const stackOwners = volumeNames.flatMap((name) =>
    [...name.matchAll(/_/g)].map((match) => ({
      volumeName: name,
      appName: name.slice(0, match.index),
    })),
  );
  const byAppName: [
    ServiceType[],
    { volumeName: string; appName: string }[],
  ][] = [
    [engines, dataOwners],
    [['compose'], stackOwners],
  ];
  for (const [types, owners] of byAppName) {
    if (owners.length === 0) continue;
    for (const serviceType of types) {
      const columns = SERVICE_TABLES[serviceType];
      const rows = (await db
        .select({ serviceId: columns.id, appName: columns.appName })
        .from(columns.table)
        .where(
          inArray(
            columns.appName,
            owners.map((o) => o.appName),
          ),
        )) as {
        serviceId: string;
        appName: string;
      }[];
      for (const row of rows) {
        for (const owner of owners.filter((o) => o.appName === row.appName)) {
          candidates.push({
            volumeName: owner.volumeName,
            serviceType,
            serviceId: row.serviceId,
          });
        }
      }
    }
  }

  const claims = new Map<string, string>();
  for (const { volumeName, serviceType, serviceId } of candidates) {
    if (claims.has(volumeName)) continue;
    if (
      serviceType === current.serviceType &&
      serviceId === current.serviceId
    ) {
      continue;
    }
    let owner: ServiceParent;
    try {
      owner = await findParentService(db, null, serviceId, serviceType);
    } catch {
      continue;
    }
    // A volume is node-local: the same name on another Server is another
    // volume, and this Delete's `docker volume rm` never reaches it.
    if (owner.serverId !== current.serverId) continue;
    claims.set(
      volumeName,
      (await deps.canName({ ...owner, serviceType }))
        ? `Kept: also used by the ${serviceType} Service '${owner.name}' (${owner.appName}) on the same Server`
        : 'Kept: also used by another Service on the same Server',
    );
  }
  return claims;
}
