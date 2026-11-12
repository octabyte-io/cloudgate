import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, gitProvider, project, server } from '../db/schema';
import { serviceScope } from '../deployments/service-scope';

/**
 * Where a piece of work lands, for the work that has no session to say whose
 * it is: a tick of a Cron service, a backup, an Uptime check, a
 * Server's metrics, a queued build, a cloud run, a webhook delivery. Each is
 * asked of the Organization that owns it.
 */
export type WorkPlace =
  | { organizationId: string }
  | { environmentId: string }
  /** Any Service: an Application, Compose stack, database or bucket. */
  | { serviceId: string }
  | { serverId: string }
  | { gitProviderId: string };

/**
 * The Organization that owns `place`, or `null` when the row is gone. One
 * answer for every reader of a {@link WorkPlace}: `FrozenOrganizationsService`'s
 * frozen check, and `OutboundAddressGuard`, which asks whose dial an Uptime check's Probe or a
 * Gitea connection's request is.
 */
export async function organizationOfPlace(
  db: DrizzleDB,
  place: WorkPlace,
): Promise<string | null> {
  if ('organizationId' in place) return place.organizationId;
  if ('serverId' in place) {
    const [row] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.serverId, place.serverId))
      .limit(1);
    return row?.organizationId ?? null;
  }
  if ('gitProviderId' in place) {
    const [row] = await db
      .select({ organizationId: gitProvider.organizationId })
      .from(gitProvider)
      .where(eq(gitProvider.gitProviderId, place.gitProviderId))
      .limit(1);
    return row?.organizationId ?? null;
  }
  if ('environmentId' in place) {
    const [row] = await db
      .select({ organizationId: project.organizationId })
      .from(environment)
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(eq(environment.environmentId, place.environmentId))
      .limit(1);
    return row?.organizationId ?? null;
  }
  const service = serviceScope(db);
  const [row] = await db
    .select({ organizationId: project.organizationId })
    .from(service)
    .innerJoin(
      environment,
      eq(environment.environmentId, service.environmentId),
    )
    .innerJoin(project, eq(project.projectId, environment.projectId))
    .where(eq(service.serviceId, place.serviceId))
    .limit(1);
  return row?.organizationId ?? null;
}
