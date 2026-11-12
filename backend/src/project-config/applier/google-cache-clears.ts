import { and, eq } from 'drizzle-orm';

import type {
  GoogleAccessToken,
  GoogleCloudPort,
} from '../../cloud-accounts/google-cloud.port';
import type { DrizzleDB } from '../../db/drizzle.module';
import { environmentNetwork } from '../../db/schema';
import type { Application } from '../../db/schema';

/**
 * **A static site's cache clear on Google Cloud** (the Google Cloud buckets spec
 * "Deploy and rollback" step 3, "Toggling `spa`"): once per Domain, by
 * host, on the Environment network's one URL map, so every Domain of the
 * site sees what was just made live at once and every other host on the
 * map keeps its cache. Each takes about 2 seconds and is a line of its own.
 * A deploy runs it after its copy into `live/`; a `spa` change's network
 * run at its end.
 *
 * A refusal stops at that host, naming it: what is live is already live,
 * but that host may serve what its edge cached before for up to a day. A
 * Deployment's clears stop alike at its 30-minute cap (`capped`),
 * naming the hosts not cleared.
 */
export async function clearSiteCache(
  google: GoogleCloudPort,
  token: () => Promise<GoogleAccessToken>,
  on: { readonly projectId: string; readonly urlMap: string },
  hosts: readonly string[],
  log: (line: string) => Promise<void>,
  capped: () => boolean = () => false,
): Promise<void> {
  for (const [index, host] of hosts.entries()) {
    if (capped()) {
      const left = hosts.slice(index);
      throw new Error(
        `The Deployment reached its 30-minute cap before the cache was cleared for ${left.join(', ')}. The live site serves this version, but ${left.length === 1 ? 'that Domain' : 'those Domains'} may serve what Cloud CDN cached before for up to a day; deploy again to clear it`,
      );
    }
    const answer = await google.invalidateCache(await token(), {
      projectId: on.projectId,
      urlMap: on.urlMap,
      host,
    });
    if (!answer.ok) {
      throw new Error(
        `Google refused to clear the cache for ${host}: ${answer.code}: ${answer.message}. ${host} may serve what Cloud CDN cached before for up to a day; deploy again to clear it`,
      );
    }
    await log(`🌐 [Clear] Cleared the cache for ${host}`);
  }
}

/**
 * The URL map of the Environment network a Service is in, once made; `null`
 * while there is none, so nothing of the Service is on a load balancer.
 */
export async function urlMapOf(
  db: DrizzleDB,
  app: Pick<Application, 'environmentId' | 'cloudAccountId' | 'region'>,
): Promise<string | null> {
  const [found] = await db
    .select({ urlMapName: environmentNetwork.urlMapName })
    .from(environmentNetwork)
    .where(
      and(
        eq(environmentNetwork.environmentId, app.environmentId),
        eq(environmentNetwork.cloudAccountId, app.cloudAccountId ?? ''),
        eq(environmentNetwork.region, app.region ?? ''),
        eq(environmentNetwork.status, 'ready'),
      ),
    );
  return found?.urlMapName ?? null;
}
