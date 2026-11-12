import { and, inArray, isNull } from 'drizzle-orm';

import type { TofuFailure, TofuShow } from '../../cloud-accounts/cloud.port';
import type { DrizzleDB } from '../../db/drizzle.module';
import { domain } from '../../db/schema';
import type { Domain } from '../../db/schema';

/**
 * A Domain run's own plan check, remembered, so its stop (Drift, a hand
 * change, more than the Domain's blocks) is told apart from the cloud's
 * refusal. Only the cloud refusing the run's plan or apply fails a Domain;
 * the run's own stop, a failure before its plan (`init`, the workspace,
 * recording what it would forget), the lock, an interrupt (cancel, time
 * limit, restart) or a state Cloudgate cannot read is the run's problem and
 * stays on its Deployment.
 */
export function domainRunCheck(check: (show: TofuShow) => TofuFailure | null): {
  beforeApply: (show: TofuShow) => TofuFailure | null;
  refusedByCloud: (applied: TofuFailure) => boolean;
} {
  let stop: TofuFailure | null = null;
  return {
    beforeApply: (show) => (stop = check(show)),
    refusedByCloud: (applied) =>
      applied.reason === 'failed' &&
      applied.failedAt !== undefined &&
      stop === null,
  };
}

/** The column a Domain's certificate is named by, once its run made it. */
export type MadeBy = 'googleCertificateName' | 'acmCertificateArn';

/**
 * The error a Domain run that did not apply ends in, `run.refusal`. When the
 * cloud refused it, each Domain whose certificate the run could not make is
 * Failed in those very words first, so the Domain and its Deployment say the
 * same thing; a stop of the run's own leaves every Domain as it is.
 */
export async function domainRunError(
  db: DrizzleDB,
  run: {
    check: ReturnType<typeof domainRunCheck>;
    applied: TofuFailure;
    domains: Domain[];
    madeBy: MadeBy;
    refusal: string;
    log: (line: string) => Promise<void>;
  },
): Promise<Error> {
  if (run.check.refusedByCloud(run.applied)) await failUnmade(db, run);
  return new Error(run.refusal);
}

/**
 * Each Domain of a run the cloud refused whose certificate the run could
 * not make is Failed with the run's refusal. A Domain made before is left as
 * it is. Ask again, a new host, or a later run that makes it brings it back
 * to waiting for DNS.
 */
async function failUnmade(
  db: DrizzleDB,
  refusedRun: {
    domains: Domain[];
    madeBy: MadeBy;
    refusal: string;
    log: (line: string) => Promise<void>;
  },
): Promise<void> {
  const { domains, madeBy, refusal, log } = refusedRun;
  const unmade = domains.filter((one) => one[madeBy] === null);
  if (unmade.length === 0) return;
  await db
    .update(domain)
    .set({ cloudCertificateStatus: 'failed', certificateFailure: refusal })
    .where(
      and(
        inArray(
          domain.domainId,
          unmade.map((one) => one.domainId),
        ),
        isNull(domain[madeBy]),
      ),
    );
  for (const one of unmade) await log(`🔐 ${one.host}: ${refusal}`);
}
