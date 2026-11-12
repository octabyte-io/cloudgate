import { eq } from 'drizzle-orm';

import {
  DOMAIN_CERTIFICATES_OUTPUT,
  domainCertificateKey,
} from '../../cloud-accounts/aws/definitions/web-definition';
import type { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudPort,
  ForgetRequest,
} from '../../cloud-accounts/cloud.port';
import type { DrizzleDB } from '../../db/drizzle.module';
import { certificateDeletion, domain } from '../../db/schema';
import type { DnsRecord, Domain } from '../../db/schema';
import {
  stillInUseLine,
  tryDeletion,
  waitingOf,
} from '../../domains/certificate-deletions';
import { webDomainOf } from './deployed-domains';

/**
 * **A Domain run's ACM certificates on AWS**, whoever's state holds them: a
 * cloud `web`'s, a `static` site's (`CloudDomainRuns`) or a Stack VM's
 * stack's (`StackVmDomainRuns`, #1371). Each new certificate's ARN and
 * record written on its Domain, each attached one called live; the
 * certificates no Domain names any more taken out of the state before the
 * plan, and deleted once ACM lets go of them.
 */

/** The block of a Domain's certificates, in every state that holds them. */
export const DOMAIN_CERTIFICATE_BLOCK = 'aws_acm_certificate.domain';

/** Each new certificate's ARN and record, and each attached one live. */
export async function recordAwsCertificates(
  db: DrizzleDB,
  run: {
    domains: Domain[];
    outputs: Record<string, unknown>;
    log: (line: string) => Promise<void>;
    servedBy: string;
  },
): Promise<void> {
  const { domains, outputs, log, servedBy } = run;
  const answered = certificatesOf(outputs[DOMAIN_CERTIFICATES_OUTPUT]);
  const now = new Date().toISOString();
  for (const one of domains) {
    const certificate = answered.get(
      domainCertificateKey(webDomainOf(one, false)),
    );
    if (!certificate) {
      throw new Error(
        `OpenTofu did not answer the certificate of ${one.host}; run the Domain's change again`,
      );
    }
    if (certificate.arn !== one.acmCertificateArn) {
      await db
        .update(domain)
        .set({
          cloudCertificateStatus: 'waiting-for-dns',
          acmCertificateArn: certificate.arn,
          validationRecord: certificate.validation,
          certificateRequestedAt: now,
          certificateLastPolledAt: null,
          certificateIssuedAt: null,
          certificateFailure: null,
          validationRecordFound: false,
        })
        .where(eq(domain.domainId, one.domainId));
      await log(
        `🔐 Requested an ACM certificate for ${one.host}; it waits for its validation record at your DNS provider`,
      );
    } else if (
      one.certificateIssuedAt &&
      one.cloudCertificateStatus !== 'live'
    ) {
      await db
        .update(domain)
        .set({ cloudCertificateStatus: 'live', certificateFailure: null })
        .where(eq(domain.domainId, one.domainId));
      await log(`🔐 The certificate of ${one.host} is on ${servedBy}: live`);
    }
  }
}

/**
 * The certificates no Domain names any more, taken out of the state
 * before the plan, each recorded first for the poller to delete
 * once ACM lets go of it.
 */
export function forgetUnnamedCertificates(
  db: DrizzleDB,
  run: {
    account: AwsCloudAccount;
    stateId: string;
    domains: Domain[];
    log: (line: string) => Promise<void>;
  },
): ForgetRequest {
  const { account, stateId, domains, log } = run;
  return {
    resource: DOMAIN_CERTIFICATE_BLOCK,
    keep: domains.map((one) => domainCertificateKey(webDomainOf(one, false))),
    before: async (found) => {
      await db
        .insert(certificateDeletion)
        .values(
          found.map((one) => ({
            certificateArn: one.arn,
            cloudAccountId: account.cloudAccountId,
            region: one.region ?? regionOfArn(one.arn) ?? '',
            stateId,
            host: one.domainName,
          })),
        )
        .onConflictDoNothing();
      for (const one of found) {
        await log(
          `🔐 The certificate of ${one.domainName ?? one.arn} leaves Infrastructure state ${stateId}, so this run never waits on ACM to let go of it; Cloudgate deletes it once nothing serves it`,
        );
      }
    },
  };
}

/** One try at deleting each certificate the state let go of, now. */
export async function deleteForgottenCertificates(
  on: {
    db: DrizzleDB;
    cloud: AwsCloudPort;
    cloudAccounts: CloudAccountsService;
  },
  account: AwsCloudAccount,
  stateId: string,
  log: (line: string) => Promise<void>,
): Promise<void> {
  const rows = await waitingOf(on.db, stateId);
  if (rows.length === 0) return;
  const session = await on.cloudAccounts.deployRoleSession(account);
  for (const row of rows) {
    const tried = session.ok
      ? await tryDeletion(on.db, on.cloud, session.session, row)
      : null;
    const host = row.host ?? row.certificateArn;
    if (tried === 'deleted' || tried === 'gone') {
      await log(`🔐 The certificate of ${host} is deleted from ACM`);
    } else {
      await log(stillInUseLine(host));
    }
  }
}

/** The region an ARN names (`arn:aws:acm:<region>:…`), or `null`. */
export function regionOfArn(arn: string): string | null {
  return arn.split(':')[3] || null;
}

/** The Domain certificates `tofu output` answered, by key. */
function certificatesOf(
  value: unknown,
): Map<string, { arn: string; validation: DnsRecord | null }> {
  const found = new Map<
    string,
    { arn: string; validation: DnsRecord | null }
  >();
  if (!value || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const { arn, validation } = (entry ?? {}) as {
      arn?: unknown;
      validation?: unknown;
    };
    if (typeof arn !== 'string' || arn === '') continue;
    const first = Array.isArray(validation)
      ? (validation[0] as Partial<DnsRecord> | undefined)
      : undefined;
    found.set(key, {
      arn,
      validation:
        first?.name && first.type && first.value
          ? { name: first.name, type: first.type, value: first.value }
          : null,
    });
  }
  return found;
}
