import { z } from "zod";

/**
 * The field rules the auth screens share.
 *
 * One definition each, because four forms ask for an email and three ask for a
 * password, and the moment they each write their own the same mistake gets four
 * different sentences.
 *
 * Every message says what a good value looks like rather than delivering a
 * verdict: "Enter the email address you signed up with" is actionable, "Invalid
 * email" is not. They are written as sentences because `useApiForm` puts the
 * backend's own field messages through `sentence()` to match them — the two
 * voices end up beside each other under the same input.
 */

/**
 * The empty case and the malformed case get different sentences, and the guard is
 * what keeps them from both firing on an empty field: without it, a blank input
 * reports "not an email address" as well, and react-hook-form shows whichever
 * came first.
 */
export const emailField = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .refine((value) => value === "" || z.email().safeParse(value).success, {
    error: "That does not look like an email address — check for a typo.",
  });

/** On the way in, any non-empty string. The backend decides if it is right. */
export const currentPasswordField = z.string().min(1, "Enter your password.");

/**
 * On the way *out* — choosing a new one — the floor is better-auth's own
 * `minPasswordLength` of 8. Saying it here means someone learns it while typing
 * rather than from a refusal after they submit.
 */
export const newPasswordField = z
  .string()
  .min(1, "Choose a password.")
  .min(8, "Use at least 8 characters.")
  .max(128, "Use 128 characters or fewer.");

/**
 * "Both passwords have to match" belongs on the *second* field, which is the one
 * someone would go and change. A form-level error would sit above the buttons,
 * away from either input.
 */
export function matchingPasswords<T extends { password: string; confirm: string }>(
  schema: z.ZodType<T>,
) {
  return schema.refine((values) => values.password === values.confirm, {
    error: "These two do not match.",
    path: ["confirm"],
  });
}
