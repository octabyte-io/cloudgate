import { eq } from 'drizzle-orm';

import type { AwsCloudPort, AwsCredential } from '../cloud-accounts/cloud.port';
import type { DrizzleDB } from '../db/drizzle.module';
import { certificateDeletion } from './certificate-deletion.schema';
import type { CertificateDeletion } from './certificate-deletion.schema';

/** What one try at deleting a waiting certificate came to. */
export type DeletionTry =
  | 'deleted'
  | 'gone'
  | 'in-use'
  | { refused: { code: string; message: string } };

/**
 * Asks ACM to delete a certificate waiting for it to let go. A
 * deleted or gone one's row goes; any other answer keeps it, its last try
 * now, for the Domain poller to try again.
 */
export async function tryDeletion(
  db: DrizzleDB,
  cloud: AwsCloudPort,
  session: AwsCredential,
  row: CertificateDeletion,
  now: Date = new Date(),
): Promise<DeletionTry> {
  const answer = await cloud.acmDeleteCertificate(session, {
    region: row.region,
    certificateArn: row.certificateArn,
  });
  const where = eq(certificateDeletion.certificateArn, row.certificateArn);
  if (answer.ok && answer.value !== 'in-use') {
    await db.delete(certificateDeletion).where(where);
    return answer.value;
  }
  await db
    .update(certificateDeletion)
    .set({ lastTriedAt: now.toISOString() })
    .where(where);
  return answer.ok
    ? 'in-use'
    : { refused: { code: answer.code, message: answer.message } };
}

/** The certificates an Infrastructure state let go of, still waiting. */
export function waitingOf(
  db: DrizzleDB,
  stateId: string,
): Promise<CertificateDeletion[]> {
  return db
    .select()
    .from(certificateDeletion)
    .where(eq(certificateDeletion.stateId, stateId));
}

/**
 * How often a waiting certificate is tried: about once a minute for the
 * hour ACM's in-use record can trail CloudFront, then about every 10
 * minutes.
 */
export function deletionDue(row: CertificateDeletion, now: Date): boolean {
  if (!row.lastTriedAt) return true;
  const since = now.getTime() - Date.parse(row.lastTriedAt);
  const age = now.getTime() - Date.parse(row.forgottenAt);
  return since >= (age < 60 * 60_000 ? 60_000 : 10 * 60_000);
}

/** The line a run logs for a waiting certificate ACM still holds. */
export function stillInUseLine(host: string): string {
  return `🔐 ACM still calls the certificate of ${host} in use, as it does for up to an hour after CloudFront or a load balancer drops one. Cloudgate deletes it once ACM lets go, outside this run`;
}
