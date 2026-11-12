import type { IncomingHttpHeaders } from 'node:http';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { callAuthApi, toWebHeaders } from '../../auth/auth-api.util';
import type { Auth } from '../../auth/auth.config';
import { AUTH } from '../../auth/auth.constants';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { LicenseService } from '../license/license.service';
import { paidFeatureRefusal } from '../license/paid-features';
import { scimProvider } from './scim.schema';

/** The provider id a new SCIM token is issued for. */
export interface GenerateScimTokenInput {
  providerId: string;
}

/** The provider projection — the token itself is never listed back. */
const providerColumns = {
  id: scimProvider.id,
  providerId: scimProvider.providerId,
  organizationId: scimProvider.organizationId,
  lastRefusedAddAt: scimProvider.lastRefusedAddAt,
  lastRefusedAddEmail: scimProvider.lastRefusedAddEmail,
};

/** SCIM provider management: list, issue a token, delete. */
@Injectable()
export class ScimService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly permissions: PermissionService,
    private readonly license: LicenseService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * The gate every method rides: an owner/admin caller.
   *
   * The role checked is the caller's role in the organization, not the admin
   * plugin's global user role, which on a self-hosted instance is always 'user'
   * (the settings/ai/custom-roles/forward-auth/sso precedent).
   */
  private async ensureManager(ctx: PermissionCtx): Promise<void> {
    const memberRecord = await this.permissions.findMember(ctx);
    if (memberRecord.role !== 'owner' && memberRecord.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can manage SCIM providers',
      );
    }
  }

  /**
   * The gate for adding a provider: {@link ensureManager} and an organization
   * that passes the paid-feature check (the license key Self-hosted, Business
   * or Enterprise Hosted).
   *
   * Only issuing a token asks it (ADR-0054): below the paid features an
   * owner can still see the providers SCIM was set up with, and the add each
   * last refused, and can still delete a provider, because removing is always
   * allowed. The IdP-facing pushes have their own check in the auth layer,
   * `scim-plan-gate.ts`.
   *
   * This is the only gate on issuance: the plugin is registered without a
   * `beforeSCIMTokenGenerated` hook, since licences live on the organization
   * (phase 49) rather than on a user row a hook could read, and with
   * `/scim/generate-token` disabled every caller reaching the plugin has
   * already come through here.
   */
  private async ensureEnterprise(ctx: PermissionCtx): Promise<void> {
    await this.ensureManager(ctx);
    const licensed = await this.license.hasValidLicense(
      ctx.session.activeOrganizationId,
    );
    if (!licensed) throw paidFeatureRefusal(this.instanceMode);
  }

  /**
   * The organization's providers, ordered by provider id, each with the last
   * create or reactivation it pushed that was refused for want of the paid
   * features (`lastRefusedAddAt` / `lastRefusedAddEmail`, both null when none
   * was). Readable on any plan.
   */
  async listProviders(ctx: PermissionCtx) {
    await this.ensureManager(ctx);
    return this.db
      .select(providerColumns)
      .from(scimProvider)
      .where(eq(scimProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(asc(scimProvider.providerId));
  }

  /**
   * Registers a provider and issues its token. The plugin owns the write,
   * because the bearer token it hands back is derived from the row it creates —
   * the stored secret is only half of it.
   */
  async generateToken(
    ctx: PermissionCtx,
    headers: IncomingHttpHeaders,
    input: GenerateScimTokenInput,
  ): Promise<{ scimToken: string; providerId: string }> {
    await this.ensureEnterprise(ctx);
    // The collision pre-check, and the reason token issuance cannot just be left
    // to the plugin: its own generate-token *replaces* a colliding row, which
    // silently revokes a token an IdP is already provisioning with. The scan is
    // instance-wide because `providerId` is globally unique — it names the
    // `account.providerId` a provisioned user is linked by.
    const [existing] = await this.db
      .select({ id: scimProvider.id })
      .from(scimProvider)
      .where(eq(scimProvider.providerId, input.providerId))
      .limit(1);
    if (existing) {
      throw new BadRequestException(
        'A SCIM provider with this ID already exists',
      );
    }

    const result = await callAuthApi(() =>
      this.auth.api.generateSCIMToken({
        body: {
          providerId: input.providerId,
          organizationId: ctx.session.activeOrganizationId,
        },
        headers: toWebHeaders(headers),
      }),
    );
    return { scimToken: result.scimToken, providerId: input.providerId };
  }

  /**
   * Deletes a provider by dropping the row directly rather than going through
   * the plugin — deleting the row is what invalidates the token, and a provider
   * in another organization reads as absent. Allowed on any plan: removing is
   * always allowed.
   */
  async deleteProvider(
    ctx: PermissionCtx,
    providerId: string,
  ): Promise<{ success: true }> {
    await this.ensureManager(ctx);
    const deleted = await this.db
      .delete(scimProvider)
      .where(
        and(
          eq(scimProvider.providerId, providerId),
          eq(scimProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .returning({ id: scimProvider.id });

    if (deleted.length === 0) {
      throw new NotFoundException(
        'SCIM provider not found or you do not have permission to delete it',
      );
    }
    return { success: true };
  }
}
