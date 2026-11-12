import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ServiceType } from '../applications/application.schema';
import { SERVICE_TABLES } from '../common/service-parent';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment } from '../environments/environment.schema';
import { organization } from '../organizations/organizations.schema';
import { project } from '../projects/project.schema';
import { checkRecordedMode } from './instance-mode';
import type { InstanceModeName } from './instance-mode';
import {
  RECORDED_INSTANCE_MODE_ID,
  recordedInstanceMode,
} from './instance-mode.schema';

/**
 * The recorded mode (ADR-0049): the boot comparison against the row,
 * and the change the `set-instance-mode` command makes. The pure comparison
 * is `checkRecordedMode` in `./instance-mode.ts`; this file is the reads and
 * writes around it.
 */

/** The mode the database recorded, or null before the first start has. */
export async function readRecordedMode(
  db: DrizzleDB,
): Promise<InstanceModeName | null> {
  const [row] = await db
    .select({ mode: recordedInstanceMode.mode })
    .from(recordedInstanceMode)
    .where(eq(recordedInstanceMode.id, RECORDED_INSTANCE_MODE_ID))
    .limit(1);
  return row?.mode ?? null;
}

/**
 * What a start does with the recorded mode: the first records the configured
 * one, every later one must match it or refuses (`InstanceModeBootError`),
 * naming both. Insert-first, so two backends starting at once on an empty
 * table record one mode between them and the loser is compared against it.
 *
 * Returns whether this start was the one that recorded it.
 */
export async function recordInstanceModeAtBoot(
  db: DrizzleDB,
  configured: InstanceModeName,
): Promise<'recorded' | 'matched'> {
  const inserted = await db
    .insert(recordedInstanceMode)
    .values({ id: RECORDED_INSTANCE_MODE_ID, mode: configured })
    .onConflictDoNothing()
    .returning({ mode: recordedInstanceMode.mode });
  if (inserted.length > 0) return 'recorded';
  checkRecordedMode(configured, await readRecordedMode(db));
  return 'matched';
}

/** A Service whose place is the platform host, as the mode command lists it. */
export interface ServiceOnPlatformHost {
  kind: ServiceType;
  name: string;
  serviceId: string;
  environmentName: string;
  projectName: string;
  organizationName: string;
}

/**
 * Every Service whose place is the platform host: no run Server and, for the
 * kinds a Cloud account can run, no Cloud account (CONTEXT.md, Deploy
 * target). Every Organization's, sorted so the list reads by Organization.
 */
export async function servicesOnPlatformHost(
  db: DrizzleDB,
): Promise<ServiceOnPlatformHost[]> {
  const found: ServiceOnPlatformHost[] = [];
  for (const [kind, columns] of Object.entries(SERVICE_TABLES) as Array<
    [ServiceType, (typeof SERVICE_TABLES)[ServiceType]]
  >) {
    const rows = await db
      .select({
        name: sql<string>`${columns.name}`,
        serviceId: sql<string>`${columns.id}`,
        environmentName: environment.name,
        projectName: project.name,
        organizationName: organization.name,
      })
      .from(columns.table)
      .innerJoin(
        environment,
        eq(columns.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .innerJoin(organization, eq(project.organizationId, organization.id))
      .where(
        and(
          isNull(columns.serverId),
          ...(columns.cloudAccountId ? [isNull(columns.cloudAccountId)] : []),
        ),
      );
    found.push(...rows.map((row) => ({ kind, ...row })));
  }
  return found.sort(
    (a, b) =>
      a.organizationName.localeCompare(b.organizationName) ||
      a.projectName.localeCompare(b.projectName) ||
      a.environmentName.localeCompare(b.environmentName) ||
      a.name.localeCompare(b.name),
  );
}

/** Turning hosted mode on while Services still have the platform host as their place. */
export class ServicesOnPlatformHostRefusal extends Error {
  constructor(readonly services: ServiceOnPlatformHost[]) {
    super(
      `Refusing to turn hosted mode on: ${services.length} ` +
        `${services.length === 1 ? 'Service runs' : 'Services run'} on the ` +
        'platform host, which the Hosted instance never runs Services on. ' +
        'Move or delete each one first.',
    );
    this.name = 'ServicesOnPlatformHostRefusal';
  }
}

/** Serialises `set-instance-mode` runs (any fixed key). */
const MODE_CHANGE_LOCK = 0x1191;

export type ModeChange =
  | { changed: true; from: InstanceModeName | null; to: InstanceModeName }
  | { changed: false; to: InstanceModeName };

/**
 * Sets the recorded mode to `to`, the `set-instance-mode` command's write.
 * Turning hosted on refuses ({@link ServicesOnPlatformHostRefusal}) while any
 * Service has the platform host as its place (ADR-0049, ADR-0053), and writes
 * nothing. One transaction under an advisory lock, so two runs cannot
 * interleave.
 */
export async function changeRecordedMode(
  db: DrizzleDB,
  to: InstanceModeName,
): Promise<ModeChange> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MODE_CHANGE_LOCK})`);
    const [row] = await tx
      .select({ mode: recordedInstanceMode.mode })
      .from(recordedInstanceMode)
      .where(eq(recordedInstanceMode.id, RECORDED_INSTANCE_MODE_ID));
    const from = row?.mode ?? null;
    if (from === to) return { changed: false, to };

    if (to === 'hosted') {
      const onHost = await servicesOnPlatformHost(tx as unknown as DrizzleDB);
      if (onHost.length > 0) throw new ServicesOnPlatformHostRefusal(onHost);
    }

    await tx
      .insert(recordedInstanceMode)
      .values({
        id: RECORDED_INSTANCE_MODE_ID,
        mode: to,
        changedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: recordedInstanceMode.id,
        set: { mode: to, changedAt: new Date().toISOString() },
      });
    return { changed: true, from, to };
  });
}
