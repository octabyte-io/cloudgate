import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { checkServerAccess } from '../common/owned-server';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { generateAppName } from '../db/columns';
import { certificate } from '../db/schema';
import type { Certificate } from '../db/schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { TraefikWriterService } from '../traefik/traefik-writer.service';
import type {
  CreateCertificateDto,
  UpdateCertificateDto,
} from './dto/certificate.dto';

/** A certificate as exposed over the API — the key never leaves the server. */
export type SanitizedCertificate = Omit<Certificate, 'privateKey'>;

function stripPrivateKey(row: Certificate): SanitizedCertificate {
  const { privateKey, ...rest } = row;
  void privateKey;
  return rest;
}

/**
 * Custom TLS certificates: the rows and the PEM files Traefik serves them from.
 *
 * Every method opens with a `checkPermission` on the `certificate` resource.
 * It is `checkPermission` rather than the sibling creates'
 * `checkServiceAccess` because a certificate belongs to a Server and an
 * Organization, not to a Service — there is no serviceId to scope it by, and
 * `certificate.organizationId` is the whole of its tenancy.
 *
 * What that check actually gates, verified against
 * `PermissionService.checkPermission`: `certificate` is in
 * `enterpriseOnlyResources`, so an owner or an admin returns early and is
 * unaffected. Everyone else is authorized against their role's statements —
 * which means a licensed custom role is gated by what it holds, and the static
 * `memberRole` carries `certificate: []`, so a plain Member is now refused
 * where the absent check used to let them through.
 *
 * The controller already carried `@RequirePermission('certificate', …)` on all
 * five routes, with exactly these resource/action pairs, so `PermissionsGuard`
 * covered the HTTP surface and no route's behaviour changes. What was open is
 * the *service* seam: nothing gated an in-process caller, which is how
 * `TemplatesService` and `AiService` reach `MountsService` today and how the
 * next feature would reach this one. Every sibling create checks for itself
 * rather than trusting a decorator a new route can forget; duplicating the
 * guard for HTTP callers is that choice's accepted cost.
 */
@Injectable()
export class CertificatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly traefikWriter: TraefikWriterService,
  ) {}

  /**
   * Creates a certificate, scoped to the session's active organization:
   * materialize the certificate's files in the Traefik certs dir, then insert
   * the row.
   *
   * The insert is deliberately last. It used to come first, so a certs
   * dir that could not take the PEM pair answered 500 with the row committed —
   * a certificate the console lists, `remove` will try to delete files for, and
   * Traefik will never serve. `certificatePath` is minted here rather than left
   * to the column's `$defaultFn` because the write names the directory and has
   * to happen before the row exists; the `$defaultFn` stays as the safety net
   * for any other writer. `certificateId` is *not* minted with it — unlike
   * the backup schedule's `scheduleId`, which the materialized script printed, nothing before
   * the insert names it.
   *
   * No transaction: a host-side write cannot join one, and §2.3
   * forbids holding one open across it. When the write succeeds and the insert
   * then fails, the residue is a directory under the certs dir and its
   * `dynamic/certificate+<certificatePath>.yml` fragment that no row
   * points at — Traefik will load the fragment for material nothing
   * references, which is the same state a certificate deleted outside the app
   * leaves. It is deliberately not swept: a compensating `rm -rf` is the same
   * unreliable second write that ruled out the compensating-delete shape, and
   * its bad day would be deleting a live certificate.
   *
   * A caller without `certificate: ['create']` is refused before either — the
   * gate comes ahead of `checkServerAccess` so a caller who may not create at
   * all is not told whether a serverId resolves, matching the order in
   * `databases/common/database-service.ts`'s createDatabase. An unknown or
   * unowned `serverId` is then refused 404; nullish is the platform host.
   *
   * **And a nullish `serverId` — the platform host — takes instance authority
   * on top of it. The decision, since ADR-0013 records the surfaces it
   * enumerated and not this one.** An earlier fix closed the *named* Server: an id in
   * another organization is a 404 before any PEM material is written. What was
   * left is the host branch, and the resource behind it is instance-wide by
   * construction in exactly ADR-0013's sense — one Traefik, one certs dir, one
   * merged `tls.certificates`, which terminates TLS for **every**
   * organization's gated Domain. `TraefikWriterService.writeCertificate` lands
   * a `tls.certificates` fragment per row, and Traefik picks a certificate for an
   * incoming SNI by the SANs *inside* the material, not by which row asked: so
   * material naming a hostname another organization serves is selected for that
   * organization's traffic. The realistic damage is their HTTPS rather than
   * interception — a caller cannot mint a publicly-trusted certificate for a
   * name they do not control — and a cross-organization outage on the shared
   * ingress is still the shape H-51 refused.
   *
   * `certificate: ['create']` cannot carry it, and that is ADR-0013's third
   * consequence rather than a judgement made here: *"a licensed custom role can
   * be granted it"* — which is why `POST /settings/traefik/file`, behind the
   * grantable `traefikFiles:write`, needed a host branch of its own. Every
   * organization's owner and admin holds this one outright.
   *
   * **What it costs a legitimate operator, which is more than the patch-repos
   * clean it landed beside and is why it is written down.** A Service
   * defaults to the platform host, so a tenant on a multi-organization install
   * whose Domain terminates there can no longer install their own certificate
   * for it: they take the resolver-issued certificate, or ask the instance's
   * operator to install the material. That is a real refusal of a normal
   * request, accepted because the alternative is a tenant able to shadow
   * another tenant's hostname on the ingress they share, and because the two
   * cheaper answers are worse — a `letsencrypt` Domain needs nothing from this
   * route, and a per-Server certificate on the tenant's own Server is
   * untouched. It is a no-op on the single-organization install
   * `deploy/install.sh` produces.
   *
   * **Rejected: validating the material's SANs against the organization's own
   * Domains**, which is the structural answer — it would let a tenant install a
   * certificate for a hostname they demonstrably serve and refuse one for
   * anybody else's, with no appeal to a role at all. It needs a certificate
   * parser, a rule for wildcards, and an answer for material added before its
   * Domain, so it is a decision of its own rather than a line in this one; the
   * authority check is what holds the surface until then.
   *
   * `remove` deliberately keeps organization authority: `certificatePath` is
   * minted here and unique per row, so `removeCertificate` deletes only the
   * directory this row created, and `findRow` is organization-scoped — nothing
   * shared is reachable. So an organization can always withdraw its own host
   * certificate, including one created before this check existed.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateCertificateDto,
  ): Promise<SanitizedCertificate> {
    await this.permissions.checkPermission(ctx, { certificate: ['create'] });
    // Ahead of `checkServerAccess` for the same reason the statement is: the
    // host branch resolves no id, so there is nothing for this check to learn
    // from the lookup, and nothing for a refused caller to learn from it either.
    if (!data.serverId) {
      await this.permissions.checkInstanceAuthority(ctx);
    }
    // Nothing else here reads serverId: the row is org-scoped by
    // organizationId, and its serverId went straight to a foreign key that
    // answered 500 for an id in another organization or none. It also decides
    // which host writeCertificate materializes the PEM on, so an unowned id
    // was a write attempt against another organization's machine, not only a
    // 500.
    await checkServerAccess(this.db, ctx, data.serverId);

    const values = {
      ...data,
      // Normalized rather than left undefined: `writeCertificate` reads it to
      // choose local disk or SSH, and the column stores null for the platform
      // host.
      serverId: data.serverId ?? null,
      certificatePath: generateAppName('certificate'),
      organizationId: ctx.session.activeOrganizationId,
    };
    await this.traefikWriter.writeCertificate(values);

    const [created] = await this.db
      .insert(certificate)
      .values(values)
      .returning();
    return stripPrivateKey(created);
  }

  /** The organization's certificates, newest first, keys stripped. */
  async list(ctx: PermissionCtx): Promise<SanitizedCertificate[]> {
    await this.permissions.checkPermission(ctx, { certificate: ['read'] });

    const rows = await this.db
      .select()
      .from(certificate)
      .where(eq(certificate.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(certificate.createdAt));
    return rows.map(stripPrivateKey);
  }

  /** One certificate of the organization — key stripped. */
  async findOne(
    ctx: PermissionCtx,
    certificateId: string,
  ): Promise<SanitizedCertificate> {
    await this.permissions.checkPermission(ctx, { certificate: ['read'] });

    return stripPrivateKey(await this.findRow(ctx, certificateId));
  }

  /**
   * Persists the changed fields; when the PEM material moves, rewrites the
   * files so Traefik picks up the new pair.
   *
   * Row first, then the write — the opposite of `create`, and not an oversight.
   * The host-write fix scoped itself to the three creates and named `remove` and the
   * consistency sweep as non-goals; the failure here is a different one (a row
   * advertising material the certs dir still holds the previous version of),
   * and it needs its own decision rather than this one applied by analogy.
   *
   * **The host-side write takes instance authority, and the row does not.**
   * {@link create} carries the decision and the argument. Here it is
   * asked of the *material*: `writeCertificate` runs only when
   * `certificateData` or `privateKey` moves, and that is the write into the
   * platform host's shared certs dir — new material for a hostname the caller
   * may not serve is the same act as creating it there. A rename is a write to
   * an organization-scoped row (`findRow`) that touches no file, so it stays
   * organization-gated; that split is deliberate, and it is what keeps an
   * organization able to tidy a host certificate it created before this rule rather
   * than being locked out of its own row.
   *
   * The check runs before the `update`, not before the `writeCertificate` it
   * guards: a caller refused here must not leave a row behind claiming material
   * the certs dir never took, which is the failure named in `create`.
   */
  async update(
    ctx: PermissionCtx,
    certificateId: string,
    data: UpdateCertificateDto,
  ): Promise<SanitizedCertificate> {
    await this.permissions.checkPermission(ctx, { certificate: ['update'] });
    const current = await this.findRow(ctx, certificateId);
    if ((data.certificateData || data.privateKey) && !current.serverId) {
      await this.permissions.checkInstanceAuthority(ctx);
    }

    const [updated] = await this.db
      .update(certificate)
      .set(data)
      .where(eq(certificate.certificateId, current.certificateId))
      .returning();

    if (data.certificateData || data.privateKey) {
      await this.traefikWriter.writeCertificate(updated);
    }
    return stripPrivateKey(updated);
  }

  /**
   * Drops the cert's directory from the Traefik certs dir, then deletes the
   * row.
   */
  async remove(
    ctx: PermissionCtx,
    certificateId: string,
  ): Promise<SanitizedCertificate> {
    await this.permissions.checkPermission(ctx, { certificate: ['delete'] });
    const current = await this.findRow(ctx, certificateId);

    await this.traefikWriter.removeCertificate(
      current.certificatePath,
      current.serverId,
    );

    const [removed] = await this.db
      .delete(certificate)
      .where(eq(certificate.certificateId, current.certificateId))
      .returning();
    return stripPrivateKey(removed);
  }

  /** The full org-scoped row including the decrypted key, for internal use. */
  private async findRow(
    ctx: PermissionCtx,
    certificateId: string,
  ): Promise<Certificate> {
    const [found] = await this.db
      .select()
      .from(certificate)
      .where(
        and(
          eq(certificate.certificateId, certificateId),
          eq(certificate.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Certificate not found');
    return found;
  }
}
