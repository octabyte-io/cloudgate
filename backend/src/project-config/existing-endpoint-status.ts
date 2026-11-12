import { eq } from 'drizzle-orm';

import { existingEndpointName } from '../cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { NOT_FOUND } from '../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import type { ExistingEndpointStatus } from '../databases/postgres/existing-database.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { existingDatabase } from '../db/schema';

/** The status of an endpoint whose forwarding rule Google no longer has. */
export const ENDPOINT_GONE = 'NOT_FOUND' satisfies ExistingEndpointStatus;

/** The status of an endpoint the instance took: the only one that connects. */
export const ENDPOINT_ACCEPTED = 'ACCEPTED' satisfies ExistingEndpointStatus;

/**
 * Reads an Existing database's manual endpoint's acceptance through the
 * Google client port and keeps it for its page (ADR-0033 as amended): after the
 * Cloud run that made it, and at each plan.
 * Nothing waits on it and nothing is refused for it — linked Services
 * deploy regardless — so a read Google does not answer leaves the last one
 * as it was. Answers what it read, or `null`.
 */
export async function readEndpointStatus(
  db: DrizzleDB,
  google: GoogleCloudPort,
  token: GoogleAccessToken,
  place: {
    readonly existingDatabaseId: string;
    readonly projectId: string;
    readonly region: string;
    /** The postgres's or the mysql's id, which names its endpoint. */
    readonly serviceId: string;
  },
): Promise<ExistingEndpointStatus | null> {
  let status: ExistingEndpointStatus | null = null;
  try {
    const answer = await google.pscEndpointStatus(token, {
      projectId: place.projectId,
      region: place.region,
      name: existingEndpointName(place.serviceId),
    });
    status = answer.ok
      ? answer.value
      : answer.code === NOT_FOUND
        ? ENDPOINT_GONE
        : null;
  } catch {
    status = null;
  }
  if (status === null) return null;
  await db
    .update(existingDatabase)
    .set({
      endpointStatus: status,
      endpointCheckedAt: new Date().toISOString(),
    })
    .where(eq(existingDatabase.existingDatabaseId, place.existingDatabaseId));
  return status;
}

/**
 * What an Existing database's page says while its endpoint is not
 * accepted, or `null` once it is, and before one is made.
 */
export function endpointSentence(
  identifier: string,
  status: ExistingEndpointStatus | null,
): string | null {
  if (status === null || status === ENDPOINT_ACCEPTED) return null;
  if (status === ENDPOINT_GONE) {
    return `Cloudgate's endpoint to ${identifier} is gone from Google Cloud; Check for changes, then Apply to make it again`;
  }
  return `Cloudgate's endpoint to ${identifier} is not accepted (${status}), so linked Services cannot reach it yet. Check that this Environment's project is on the instance's allowed consumer projects; Check for changes reads it again`;
}
