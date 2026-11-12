import { eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { dnsChallenge } from './dns-challenge.schema';
import type { DnsChallenge } from './dns-challenge.schema';

/**
 * The DNS-01 setup of one machine — a Server, or the platform host when
 * `serverId` is null — or null when it has none. The one read every
 * consumer goes through: the settings routes, Traefik's env on recreation,
 * the Previews switch's admission and `previewUrl`.
 */
export async function dnsChallengeOn(
  db: DrizzleDB,
  serverId: string | null | undefined,
): Promise<DnsChallenge | null> {
  const [row] = await db
    .select()
    .from(dnsChallenge)
    .where(
      serverId
        ? eq(dnsChallenge.serverId, serverId)
        : isNull(dnsChallenge.serverId),
    )
    .limit(1);
  return row ?? null;
}
