/**
 * What the console calls a person.
 *
 * Settings → Account collects a first name and a last name and promises the
 * last name is "shown after your name wherever Cloudgate names you". At first
 * nothing did: six
 * components each wrote `user.name?.trim() || user.email` by hand, so there was
 * no one place to add the last name to, and the account menu read `name ??
 * email` without the trim — a blank first name rendered as nothing there and as
 * the address everywhere else. Every surface that names somebody goes through
 * here now, and `person-name.test.ts` fails on the next one written by hand.
 *
 * It lives in `lib/format/` because it renders nothing (§1.4's promotion rule);
 * the picture beside the name is `components/console/avatar.tsx`.
 */

/**
 * The fields a name is made from, in either of the two spellings the API uses:
 * better-auth's `name` (the session user, the member list's joined user), which
 * is the `firstName` column under another name, or `firstName` itself
 * (`GET /users/me`, a custom role's members).
 */
export type Person = {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
};

function parts(person: Person): string[] {
  return [person.firstName ?? person.name, person.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "");
}

/**
 * First name then last name, or `null` when neither is set — an account made
 * by an invitation has neither. For a surface where the address is already the
 * identity and the name is only an annotation beside it.
 */
export function fullName(person: Person): string | null {
  return parts(person).join(" ") || null;
}

/** First name then last name, or the address when there is no name at all. */
export function personName(person: Person): string {
  return fullName(person) ?? person.email;
}

/**
 * Up to two letters for an avatar with no picture: the first of each name, or
 * `null` when there is no name — the caller shows a glyph rather than a letter
 * of an email address, which reads as a monogram of the mail provider as often
 * as of the person.
 */
export function personInitials(person: Person): string | null {
  const letters = parts(person)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();
  return letters === "" ? null : letters;
}
