import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { anyBusiness, holdsBusiness } from '../../cloud/billing/enterprise';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { member } from '../../organizations/organizations.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { LICENSE_API } from './license-api';
import type { LicenseApi } from './license-api';
import { licenseKey } from './license.schema';
import type { LicenseKey, LicenseStatus } from './license.schema';
import { noLicenseKeyOnHosted } from './paid-features';

/** What `getEnterpriseSettings` returns to an owner. */
export interface EnterpriseSettings {
  enableEnterpriseFeatures: boolean;
  licenseKey: string;
}

/**
 * What `GET /license/status` reports. `licensed` is the answer the gates use;
 * `status` is what the row stores, and the two disagree on purpose once a
 * license has lapsed — expiry is derived, so nothing rewrites `status` when
 * `validUntil` passes, and a console can only tell "expired" from "refused" by
 * reading both.
 *
 * `enableEnterpriseFeatures` is the opt-in, which `status` does not reflect:
 * turning it off leaves the row `active` with its `validUntil`, so without it
 * a console could not tell "Enterprise features are off" from "the license is
 * running out" (the renewal bar is gone once they are off).
 *
 * None of these is a secret, so this stays readable by every member: an
 * expiring license affects all of them. The key itself stays on the owner-only
 * `settings` payload.
 */
export interface LicenseStatusReport {
  licensed: boolean;
  status: LicenseStatus;
  validUntil: string | null;
  features: string[];
  enableEnterpriseFeatures: boolean;
}

/**
 * Whether a stored row currently licenses its organization. Expiry is derived
 * here rather than stored, so a license lapses on its own.
 */
function isValid(row: LicenseKey | null): row is LicenseKey {
  if (!row?.enableEnterpriseFeatures || !row.key) return false;
  if (row.status !== 'active') return false;
  return !row.validUntil || row.validUntil.getTime() > Date.now();
}

/**
 * Enterprise licensing, one license per organization on the org-scoped
 * `license_key` table (see license.schema.ts for why): activation, validation
 * and deactivation against the remote license server, and the checks the
 * enterprise modules gate on.
 *
 * Gating, the same as the settings/ai/custom-roles modules: the role checked is
 * the caller's role in the organization, read off their member row — not the
 * admin plugin's *global* user role, which on a self-hosted instance is always
 * 'user', so an owner check against it would reject everyone.
 *
 * The member row is read directly rather than through PermissionService:
 * PermissionService injects this service to resolve custom roles, so going the
 * other way would close a cycle.
 *
 * **On the Hosted instance there is no license key (ADR-0048, ADR-0054).** The
 * same questions are answered from the plan held (`cloud/billing/enterprise.ts`):
 * `hasValidLicense` is "is this Organization on Business or Enterprise",
 * `hasAnyValidLicense` is "is any", and the key routes refuse as
 * not found. The install-wide features (white-labelling, parallel builds and
 * cloud runs) do not come through here in hosted mode at all: they are
 * Octabyte's, so their callers unlock them on `InstanceMode.isHosted`.
 */
@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(LICENSE_API) private readonly api: LicenseApi,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * Owner only. The license server is asked to activate the key and,
   * unless it refuses, the key is stored as this organization's active license.
   * `validUntil` and `features` are taken from its answer when it supplies them.
   */
  async activate(ctx: PermissionCtx, key: string): Promise<{ success: true }> {
    this.assertSelfHosted();
    await this.assertOwner(ctx, 'activate a license key');
    const organizationId = ctx.session.activeOrganizationId;
    const row = await this.findRow(organizationId);

    if (!row?.enableEnterpriseFeatures) {
      throw new BadRequestException(
        'Please activate enterprise features to activate license key',
      );
    }

    await this.reactivate(organizationId, key);

    return { success: true };
  }

  /**
   * Owner only: "I've renewed, check now". Re-runs activate with the
   * stored key, so a renewal made with Octabyte reaches the instance without
   * the key being pasted again, and reports the status that results.
   *
   * It is an activate, not a `validate`, because only activate answers with
   * the current `validUntil`; and like activate it writes nothing when the
   * license server refuses or cannot be reached, so a failed check leaves the
   * license as it was.
   */
  async checkNow(ctx: PermissionCtx): Promise<LicenseStatusReport> {
    this.assertSelfHosted();
    await this.assertOwner(ctx, 'check a license key');
    const organizationId = ctx.session.activeOrganizationId;
    const row = await this.findRow(organizationId);
    const stored = row?.key;

    if (!stored) {
      throw new BadRequestException('No license key found');
    }

    if (!row.enableEnterpriseFeatures) {
      throw new BadRequestException(
        'Please activate enterprise features to check the license key',
      );
    }

    await this.reactivate(organizationId, stored);
    return this.getStatus(organizationId);
  }

  /**
   * Asks the license server to activate `key` and stores its answer as the
   * organization's active license: `validUntil` and `features` as it gives
   * them. A new `validUntil` re-arms the lapse report on its own
   * (`lapseReportedFor`). Throws, writing nothing, when the server refuses.
   *
   * **No role check**: `activate` and `checkNow` check the owner before
   * calling it, and the daily re-check (`LicenseRecheckService`) has no
   * caller to check.
   */
  async reactivate(organizationId: string, key: string): Promise<void> {
    const activation = await this.callRemote(() => this.api.activate(key));

    await this.db
      .update(licenseKey)
      .set({
        key,
        status: 'active',
        validUntil: activation.validUntil
          ? new Date(activation.validUntil)
          : null,
        features: activation.features ?? [],
      })
      .where(eq(licenseKey.organizationId, organizationId));
  }

  /**
   * Owner only. Re-asks the license server about the stored key.
   *
   * Both answers are written: a `false` marks the license invalid, not only a
   * `true` active. Nothing else revalidates a stored key, so a revoked key
   * would otherwise stay enabled forever.
   */
  async validate(ctx: PermissionCtx): Promise<boolean> {
    this.assertSelfHosted();
    await this.assertOwner(ctx, 'validate a license key');
    const organizationId = ctx.session.activeOrganizationId;
    const row = await this.findRow(organizationId);
    const stored = row?.key;

    if (!stored) {
      throw new BadRequestException('No license key found');
    }

    if (!row.enableEnterpriseFeatures) {
      throw new BadRequestException(
        'Please activate enterprise features to validate license key',
      );
    }

    const valid = await this.callRemote(() => this.api.validate(stored));

    await this.db
      .update(licenseKey)
      .set({ status: valid ? 'active' : 'invalid' })
      .where(eq(licenseKey.organizationId, organizationId));

    return valid;
  }

  /**
   * Owner only. Releases the key with the license server, then clears it
   * locally. A remote failure is logged and swallowed — the local deactivation
   * must happen either way, or an owner whose license server is unreachable
   * could never detach the key.
   *
   * The opt-in is deliberately left alone: only the key, status, expiry and
   * features are cleared.
   *
   * The role is checked before the stored key is looked for, so a non-owner
   * cannot learn whether a license exists.
   */
  async deactivate(ctx: PermissionCtx): Promise<{ success: true }> {
    this.assertSelfHosted();
    await this.assertOwner(ctx, 'deactivate a license key');
    const organizationId = ctx.session.activeOrganizationId;
    const row = await this.findRow(organizationId);

    if (!row?.key) {
      throw new BadRequestException('No license key found');
    }

    try {
      await this.api.deactivate(row.key);
    } catch (error) {
      this.logger.error('Failed to deactivate license key remotely:', error);
    }

    await this.db
      .update(licenseKey)
      .set({ key: null, status: 'inactive', validUntil: null, features: [] })
      .where(eq(licenseKey.organizationId, organizationId));

    return { success: true };
  }

  /**
   * Whether this organization's enterprise features are unlocked: the opt-in is
   * on, a key is stored and active, and it has not lapsed. On the Hosted
   * instance: whether it is on Business or Enterprise (ADR-0054).
   */
  async isEnterpriseEnabled(organizationId: string): Promise<boolean> {
    if (this.instanceMode.isHosted)
      return holdsBusiness(this.db, organizationId);
    return isValid(await this.findRow(organizationId));
  }

  /**
   * The same question `isEnterpriseEnabled` answers, plus the stored state
   * behind the answer. An organization with no license row at all reports the
   * column defaults, which is the state it is in: inactive, no expiry, no
   * features.
   */
  async getStatus(organizationId: string): Promise<LicenseStatusReport> {
    if (this.instanceMode.isHosted) {
      // No key: Business or Enterprise is what licenses the Organization, and
      // the console reads `licensed` the same way either way.
      const licensed = await holdsBusiness(this.db, organizationId);
      return {
        licensed,
        status: licensed ? 'active' : 'inactive',
        validUntil: null,
        features: [],
        enableEnterpriseFeatures: licensed,
      };
    }
    const row = await this.findRow(organizationId);
    return {
      licensed: isValid(row),
      status: row?.status ?? 'inactive',
      validUntil: row?.validUntil?.toISOString() ?? null,
      features: row?.features ?? [],
      enableEnterpriseFeatures: row?.enableEnterpriseFeatures ?? false,
    };
  }

  /**
   * Whether a valid license grants one named feature. A license server may
   * answer `{ valid }` and nothing else, so a key that enumerates no features
   * licenses the enterprise modules (which gate on `hasValidLicense`) without
   * granting any feature by name.
   */
  async hasFeature(organizationId: string, feature: string): Promise<boolean> {
    if (this.instanceMode.isHosted) return false;
    const row = await this.findRow(organizationId);
    return isValid(row) && row.features.includes(feature);
  }

  /**
   * Whether *any* organization on this instance holds a valid license.
   *
   * The deployment queue's concurrency resolver (phase 22) asks this: its
   * partitions are servers, and the local partition belongs to no organization,
   * so parallel builds are an instance-level capability rather than a per-tenant
   * one.
   */
  async hasAnyValidLicense(): Promise<boolean> {
    if (this.instanceMode.isHosted) return anyBusiness(this.db);
    const [row] = await this.db
      .select({ id: licenseKey.id })
      .from(licenseKey)
      .where(
        and(
          eq(licenseKey.enableEnterpriseFeatures, true),
          eq(licenseKey.status, 'active'),
          isNotNull(licenseKey.key),
          or(
            isNull(licenseKey.validUntil),
            gt(licenseKey.validUntil, new Date()),
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * The name phases 06/22/48 and the enterprise modules call. Same question as
   * `isEnterpriseEnabled`, which is the name the surface exposes.
   */
  hasValidLicense(organizationId: string): Promise<boolean> {
    return this.isEnterpriseEnabled(organizationId);
  }

  /**
   * Owner only: the opt-in toggle and the stored key. `licenseKey` is '' when
   * none is stored.
   */
  async getEnterpriseSettings(ctx: PermissionCtx): Promise<EnterpriseSettings> {
    this.assertSelfHosted();
    await this.assertOwner(ctx, 'get enterprise settings');
    const row = await this.findRow(ctx.session.activeOrganizationId);
    return {
      enableEnterpriseFeatures: !!row?.enableEnterpriseFeatures,
      licenseKey: row?.key ?? '',
    };
  }

  /**
   * Owner only: sets the opt-in toggle. Upserts: the toggle is the
   * precondition for activating a key, so it has to be settable before any
   * license row exists.
   */
  async updateEnterpriseSettings(
    ctx: PermissionCtx,
    input: { enableEnterpriseFeatures: boolean },
  ): Promise<boolean> {
    this.assertSelfHosted();
    await this.assertOwner(ctx, 'update enterprise settings');
    const organizationId = ctx.session.activeOrganizationId;

    await this.db
      .insert(licenseKey)
      .values({
        organizationId,
        enableEnterpriseFeatures: input.enableEnterpriseFeatures,
      })
      .onConflictDoUpdate({
        target: licenseKey.organizationId,
        set: { enableEnterpriseFeatures: input.enableEnterpriseFeatures },
      });

    return true;
  }

  /**
   * A license-server failure surfaced as a 400 carrying the message
   * `LicenseApiClient` built, not a 500: a refused key is caller error.
   *
   * The other two classes are 400s too, and that is still right — the status is
   * not what tells them apart, **the message is**. `LicenseApiClient` names
   * which of the three happened (refused / license-server error with its status
   * / unreachable), and this passes that sentence through unchanged so it
   * reaches the field or the toast that asked. Before it did there was only one
   * HTTP-level sentence and this docblock's claim that "the message says which
   * it was" held for the network class alone.
   *
   * **Nothing is written on this path.** Every caller runs its `update` after
   * `callRemote` returns, so a throw here leaves the stored row exactly as it
   * was — which is what `validate`'s confirmation dialog promises when a check
   * fails rather than refuses.
   */
  private async callRemote<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'License request failed',
      );
    }
  }

  /** The key routes do not exist on the Hosted instance. */
  private assertSelfHosted(): void {
    if (this.instanceMode.isHosted) throw noLicenseKeyOnHosted();
  }

  private async findRow(organizationId: string): Promise<LicenseKey | null> {
    const [row] = await this.db
      .select()
      .from(licenseKey)
      .where(eq(licenseKey.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * 403 unless the caller is the owner of the active organization. `action`
   * completes the message, e.g. 'activate a license key'.
   */
  private async assertOwner(ctx: PermissionCtx, action: string): Promise<void> {
    const [memberRecord] = await this.db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, ctx.user.id),
          eq(member.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);

    if (memberRecord?.role !== 'owner') {
      throw new ForbiddenException(`You are not authorized to ${action}`);
    }
  }
}
