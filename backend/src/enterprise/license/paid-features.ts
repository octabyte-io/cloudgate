import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { InstanceMode } from '../../instance-mode/instance-mode.service';

/**
 * The paid features' one refusal (ADR-0048, ADR-0054).
 *
 * SSO, SCIM, custom roles and forward auth each gate on
 * `LicenseService.hasValidLicense`, which answers from the license key on a
 * Self-hosted instance and, on the Hosted one, from whether the Organization
 * is on Business or Enterprise. What the refusal says follows the same split: a
 * Self-hosted owner is pointed at a license as before, word for word, and a
 * Hosted customer — who never sees a license key — at the Business plan, with
 * a code the console can branch on.
 */
export const BUSINESS_REQUIRED_CODE = 'BUSINESS_REQUIRED';

export const BUSINESS_REQUIRED_MESSAGE =
  'SSO, SCIM, custom roles and forward auth come with the Business plan. Choose Business under Settings > Billing';

export const LICENSE_REQUIRED_MESSAGE = 'Valid enterprise license required';

export function paidFeatureRefusal(mode: InstanceMode): ForbiddenException {
  return mode.isHosted
    ? new ForbiddenException({
        message: BUSINESS_REQUIRED_MESSAGE,
        code: BUSINESS_REQUIRED_CODE,
      })
    : new ForbiddenException(LICENSE_REQUIRED_MESSAGE);
}

/**
 * The refusal a member on a custom role gets for every permission-checked
 * action while the Organization has no paid features
 * (`PermissionService.resolveRole`). The role grants nothing and
 * nobody is moved off it; the wording follows the same split as
 * {@link paidFeatureRefusal}: a license on a Self-hosted instance, word for
 * word as before, and the Business plan on the Hosted one.
 */
export function customRoleRefusal(
  mode: InstanceMode,
  roleName: string,
): ForbiddenException {
  return mode.isHosted
    ? new ForbiddenException({
        message: `Your role "${roleName}" is a custom role, which comes with the Business plan. Until this Organization is on Business again it grants nothing — an owner can choose Business under Settings > Billing, or an owner or admin can move you to the admin or member role`,
        code: BUSINESS_REQUIRED_CODE,
      })
    : new ForbiddenException(
        `Your role "${roleName}" is a custom role, which needs a valid enterprise license to resolve. Until one is active it grants nothing — an owner can activate a license, or move you to the admin or member role.`,
      );
}

/**
 * The License routes on the Hosted instance: there is no key to activate, read
 * or release there, so each one is not found rather than a form that unlocks
 * nothing. `GET /license/status` stays, answering from the plan held.
 */
export const NO_LICENSE_KEY_ON_HOSTED_CODE = 'NO_LICENSE_KEY_ON_HOSTED';

/**
 * What stops on a Self-hosted instance when its license lapses, in the
 * words the `license-lapse` report lists them. One list, so the log warning and
 * every channel say the same thing, and so the console's lapsed bar
 * has one to share. The console mirrors it as `STOPPED_BY_LAPSE` in
 * `frontend/src/features/enterprise/license/license-expiry.ts`, and a test
 * there reads this array back, so a change here fails it until both agree.
 *
 * Each entry is the part that stops, not the feature's name, because nothing
 * is wiped: SSO providers, SCIM tokens, forward-auth gates, custom roles and
 * the saved branding all stay as they were and work again with a license. The
 * instance-wide entries follow `SettingsService.requireInstanceLicense`
 * (branding is still served, only the edit is refused),
 * `instanceFeatureLicensed` (both pools fall back to one in `concurrency.ts`)
 * and `OrganizationsService.create`'s one-Organization limit (ADR-0059: every
 * Organization stays, only a new one is refused).
 */
export const STOPPED_BY_LAPSE: readonly string[] = [
  'SSO sign-in',
  'Adding members through SCIM',
  'Changes to forward auth',
  'Custom roles',
  'Editing white-labelling (the saved branding stays)',
  'Parallel builds and Cloud runs (back to one at a time)',
  'Creating more Organizations',
];

export function noLicenseKeyOnHosted(): NotFoundException {
  return new NotFoundException({
    message:
      'The Hosted instance has no license key. SSO, SCIM, custom roles and forward auth come with the Business plan, under Settings > Billing',
    code: NO_LICENSE_KEY_ON_HOSTED_CODE,
  });
}
