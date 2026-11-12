/**
 * Moved to `src/lib/forms/credentials.ts` by F16, and re-exported here so no
 * F06 call site changed.
 *
 * F06 put these beside the doors on the argument that "an auth screen's terminal
 * states are its own vocabulary", and that is still true of `auth-outcome` and
 * `challenge-closed`. It is not true of an email rule and a password floor:
 * F16's Account section changes a password and invites a member by email, which
 * makes it the second consumer, and the doc's own rule says what happens then.
 * The alternative was a console feature importing out of a route group's
 * private `_components` folder, which is the same coupling with none of the
 * visibility.
 */
export {
  emailField,
  currentPasswordField,
  newPasswordField,
  matchingPasswords,
} from "@/lib/forms/credentials";
