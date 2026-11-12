import { asc } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  REQUESTED_PREVIEW_MAX_TTL_DEFAULT_MINUTES,
  webServerSettings,
} from './settings.schema';

/**
 * The instance maximum TTL of a Requested preview, in minutes.
 *
 * **A plain select, not `SettingsService.getWebServerSettings`**, for two
 * reasons. That method *creates* the singleton when it is missing, and a
 * preview request must not be what writes the instance's settings row. And
 * `PreviewDeploymentsModule` would have to import `SettingsModule` for it,
 * which reaches Traefik, the queue and the licence for one integer —
 * `deployment-queue/builds-concurrency.provider.ts` reads `buildsConcurrency`
 * the same way for the same reason. No row yet reads as the column's default.
 *
 * The writer is `SettingsService.updateRequestedPreviewMaxTtl`, under instance
 * authority like Concurrent builds.
 */
export async function requestedPreviewMaxTtlMinutes(
  db: DrizzleDB,
): Promise<number> {
  const [row] = await db
    .select({ minutes: webServerSettings.requestedPreviewMaxTtlMinutes })
    .from(webServerSettings)
    .orderBy(asc(webServerSettings.createdAt))
    .limit(1);
  return row?.minutes ?? REQUESTED_PREVIEW_MAX_TTL_DEFAULT_MINUTES;
}
