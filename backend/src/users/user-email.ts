/**
 * The one form `user.email` is stored in: trimmed and lower-cased.
 *
 * Not a style preference — it is the form better-auth *reads*. Its
 * `internalAdapter.findUserByEmail` looks a user up by `email.toLowerCase()`,
 * an exact match against the column, and every write better-auth makes itself
 * (sign-up, `changeEmail`, `updateUserByEmail`) lower-cases on the way in. So a
 * row written in any other case is a row sign-in and password reset can never
 * find: `PATCH /users/me` stored `Jane.Doe@Company.com` as typed, answered
 * "Your profile is saved.", and the account could not be signed into again.
 *
 * Every write of `user.email` that does not go through better-auth has to pass
 * through here. `test/coding-standards/user-email-writes.spec.ts` is the census
 * that holds that: it parses `src` for writes to the `user` table and refuses
 * any that sets `email` from anything but a call to this function.
 *
 * The trim is better-auth's rule too, one step earlier: its sign-in and sign-up
 * refuse an address with surrounding space outright, so a stored one would be
 * as unreachable as a capital letter.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
