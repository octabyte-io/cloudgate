import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { provenDomain } from './proven-domain.schema';
import type { ProvenDomain } from './proven-domain.schema';
import { challengeRecordName, challengeRecordValue } from './proven-domains';
import { SsoService } from './sso.service';
import { normalizeDomains } from './sso.utils';

/**
 * Injectable TXT lookup, so no test reaches real DNS (`DNS_RESOLVER` in
 * `cdn.service.ts` is the precedent). Answers like `dns.resolveTxt`: one array
 * of chunks per record.
 */
export const TXT_RESOLVER = Symbol('TXT_RESOLVER');

export type TxtResolver = (name: string) => Promise<string[][]>;

export const txtResolverProvider = {
  provide: TXT_RESOLVER,
  useValue: ((name: string) => dns.resolveTxt(name)) as TxtResolver,
};

/** A Proven domain as the API shows it: its state and the record to publish. */
export interface ProvenDomainView {
  domain: string;
  proven: boolean;
  provenAt: string | null;
  createdAt: string;
  /** The TXT record's name and value, while there is a challenge to meet. */
  record: { type: 'TXT'; name: string; value: string };
}

export const NO_PROVEN_DOMAINS_ON_SELF_HOSTED_CODE =
  'NO_PROVEN_DOMAINS_ON_SELF_HOSTED';

const view = (row: ProvenDomain): ProvenDomainView => ({
  domain: row.domain,
  proven: row.provenAt !== null,
  provenAt: row.provenAt,
  createdAt: row.createdAt,
  record: {
    type: 'TXT',
    name: challengeRecordName(row.domain),
    value: challengeRecordValue(row.challenge),
  },
});

/**
 * An Enterprise Organization's Proven domains on the Hosted instance
 * (ADR-0051): adding one issues a TXT challenge, and checking it looks
 * the record up there and then — there is no background poll, so a domain is
 * proven the moment its owner asks and the record is in place.
 *
 * Hosted only. A Self-hosted instance has one operator owning every
 * Organization, so its SSO providers act for their listed domains as before and
 * these routes are not found. On the Hosted instance the gate is SSO's own:
 * an owner or admin of an Enterprise Organization.
 */
@Injectable()
export class ProvenDomainsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(TXT_RESOLVER) private readonly resolveTxt: TxtResolver,
    private readonly sso: SsoService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** Not found self-hosted, then SSO's owner/admin + Business gate. */
  private async ensureHostedEnterprise(ctx: PermissionCtx): Promise<void> {
    await this.ensureHostedManager(ctx);
    await this.sso.ensureEnterprise(ctx);
  }

  /**
   * Not found self-hosted, then SSO's owner/admin gate on any plan: listing
   * and removing a Proven domain stay open below Business, where the
   * SSO page shows them read-only.
   */
  private async ensureHostedManager(ctx: PermissionCtx): Promise<void> {
    if (!this.instanceMode.isHosted) {
      throw new NotFoundException({
        message:
          'Proven domains are on the Hosted instance only. Here an SSO provider acts for the domains it lists.',
        code: NO_PROVEN_DOMAINS_ON_SELF_HOSTED_CODE,
      });
    }
    await this.sso.ensureManager(ctx);
  }

  async list(ctx: PermissionCtx): Promise<ProvenDomainView[]> {
    await this.ensureHostedManager(ctx);
    const rows = await this.db
      .select()
      .from(provenDomain)
      .where(eq(provenDomain.organizationId, ctx.session.activeOrganizationId))
      .orderBy(asc(provenDomain.createdAt));
    return rows.map(view);
  }

  /**
   * Issues the challenge. Adding a domain already on the list hands back the
   * same row and challenge, so a second click cannot change the record the
   * owner is already publishing.
   */
  async add(ctx: PermissionCtx, domain: string): Promise<ProvenDomainView> {
    await this.ensureHostedEnterprise(ctx);
    const [normalized] = normalizeDomains([domain]);
    const organizationId = ctx.session.activeOrganizationId;
    await this.db
      .insert(provenDomain)
      .values({
        organizationId,
        domain: normalized,
        challenge: randomBytes(24).toString('base64url'),
      })
      .onConflictDoNothing({
        target: [provenDomain.organizationId, provenDomain.domain],
      });
    return view(await this.findRow(organizationId, normalized));
  }

  /**
   * Looks the TXT record up and marks the domain proven when it carries the
   * challenge. A lookup that finds nothing, or fails, leaves it unproven: the
   * answer is the domain's state, not an error. A proven domain stays proven.
   */
  async check(ctx: PermissionCtx, domain: string): Promise<ProvenDomainView> {
    await this.ensureHostedEnterprise(ctx);
    const [normalized] = normalizeDomains([domain]);
    const row = await this.findRow(
      ctx.session.activeOrganizationId,
      normalized,
    );
    if (row.provenAt) return view(row);

    const expected = challengeRecordValue(row.challenge);
    let records: string[][] = [];
    try {
      records = await this.resolveTxt(challengeRecordName(row.domain));
    } catch {
      records = [];
    }
    if (!records.some((chunks) => chunks.join('').trim() === expected)) {
      return view(row);
    }

    const [proven] = await this.db
      .update(provenDomain)
      .set({ provenAt: new Date().toISOString() })
      .where(eq(provenDomain.provenDomainId, row.provenDomainId))
      .returning();
    return view(proven);
  }

  /**
   * Takes a domain off the list. Its provider stops routing and accepting
   * sign-ins for it at once; the provider's own domain list is untouched.
   */
  async remove(ctx: PermissionCtx, domain: string): Promise<{ success: true }> {
    await this.ensureHostedManager(ctx);
    const [normalized] = normalizeDomains([domain]);
    const deleted = await this.db
      .delete(provenDomain)
      .where(
        and(
          eq(provenDomain.organizationId, ctx.session.activeOrganizationId),
          eq(provenDomain.domain, normalized),
        ),
      )
      .returning({ provenDomainId: provenDomain.provenDomainId });
    if (deleted.length === 0) throw this.notFound(normalized);
    return { success: true };
  }

  private async findRow(
    organizationId: string,
    domain: string | undefined,
  ): Promise<ProvenDomain> {
    const [row] = domain
      ? await this.db
          .select()
          .from(provenDomain)
          .where(
            and(
              eq(provenDomain.organizationId, organizationId),
              eq(provenDomain.domain, domain),
            ),
          )
          .limit(1)
      : [];
    if (!row) throw this.notFound(domain ?? '');
    return row;
  }

  private notFound(domain: string): NotFoundException {
    return new NotFoundException(
      `${domain} is not on this Organization's Proven domains`,
    );
  }
}
