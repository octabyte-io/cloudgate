import { APIError } from 'better-auth/api';

/** What the first Organization is called when the owner names none. */
export const DEFAULT_ORGANIZATION_NAME = 'My Organization';

/** The same ceiling `POST /organizations` and its rename put on a name. */
const MAX_ORGANIZATION_NAME = 255;

/**
 * The name the owner's sign-up gave its first Organization.
 *
 * The "Set up this instance" form sends it as `organizationName` beside the
 * account's own fields. better-auth's sign-up body admits extra keys and its
 * user parser ignores the ones it was not told about, so it reaches the
 * `user.create` hooks on `context.body` without becoming a user column.
 *
 * Missing, blank or not a string reads as no answer and keeps the default —
 * only the very first sign-up creates an Organization, and an invited one never
 * sends the field. A name over the ceiling is refused rather than cut short:
 * the `before` hook asks this too, so the refusal lands before any row exists.
 */
export function signUpOrganizationName(body: unknown): string {
  const raw =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).organizationName
      : undefined;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') return DEFAULT_ORGANIZATION_NAME;
  if (name.length > MAX_ORGANIZATION_NAME) {
    throw new APIError('BAD_REQUEST', {
      code: 'ORGANIZATION_NAME_TOO_LONG',
      message: `An Organization name is at most ${MAX_ORGANIZATION_NAME} characters`,
    });
  }
  return name;
}
