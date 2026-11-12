/**
 * The one ban rule, and the one sentence it is refused in.
 *
 * It lived in `auth.service.ts` while the credential paths were its only
 * readers. H-08 gave it a third: better-auth's own `/api/auth` surface, which
 * `AuthController` mounts whole and which never passes through
 * `AuthService.resolveCaller` — so `auth.config.ts` has to ask the same
 * question. `auth.service.ts` imported `hasInstanceOwner` from
 * `auth.config.ts` then (it is in `sign-up-state.ts` now), so leaving
 * the predicate where it was would have made the two files require each other. A third module both import is the answer
 * `socket-peer.ts` gives to the same shape of problem, and it is the only one
 * that keeps §1.4's rule here: writing the `banned && banExpires` test a second
 * time where it was needed is precisely the defect once filed, and the ban
 * fix's docblocks name that drift twice.
 */

/**
 * Whether a ban on this row is in force *now* — better-auth's own rule, read
 * from the columns instead of from a route.
 *
 * `banExpires` is the half both original readers missed. The admin plugin clears
 * an elapsed ban inside its `session.create.before` hook
 * (`better-auth/dist/plugins/admin/admin.mjs:37-43`) and nowhere else, so a
 * temporary ban that has passed still reads `banned = true` on every row whose
 * owner has not signed in since — and refusing on the column alone makes a
 * 24-hour ban permanent for a credential that never creates a session, which is
 * exactly an api key.
 *
 * Nothing is written back. Clearing the columns stays the plugin's job on the
 * next sign-in: a read path that repairs rows is a read path anyone who can make
 * it read can make write.
 *
 * Both columns are optional as well as nullable, because the three rows this is
 * asked of spell them differently: the drizzle `user` row has `null`,
 * better-auth's `AuthSession['user']` has them optional, and the user on
 * `ctx.context.session` is typed without them at all — the admin plugin adds
 * them to the *schema* rather than to the base type, so they arrive at runtime
 * and are invisible to the compiler. One predicate over all three is the point —
 * the whole lesson was two ban checks drifting.
 *
 * Exported for `test/auth/ban-in-force.spec.ts`.
 */
export function banInForce(row: {
  banned?: boolean | null;
  banExpires?: Date | null;
}): boolean {
  if (!row.banned) return false;
  return !row.banExpires || row.banExpires.getTime() > Date.now();
}

/**
 * What a banned account is told, on every path that turns one down.
 *
 * One string rather than one per reader: the sentence is the only part of a
 * refusal an operator reads, and the lesson was two ban checks drifting
 * apart while both looked right on their own. `OWNER_REFUSALS.BANNED` in
 * `auth.service.ts` deliberately keeps its *own* wording — it names the account
 * behind an **api key**, which is a different fact — and pins it in
 * `test/auth/api-key-refusal.e2e-spec.ts`.
 *
 * H-29 made "every path" true. The admin plugin's `bannedUserMessage` was left
 * at better-auth's default, so **sign-in** answered *"You have been banned from
 * this application. Please contact support if you believe this is an error."*
 * while `/get-session` a second later answered this — one fact, two sentences,
 * on the same surface to the same person. `auth.config.ts` now passes this as
 * `bannedUserMessage`, and the upstream default was the one that went, for two
 * reasons beyond its being longer. It breaks §2.5's rule for a wire message
 * (sentence case, no trailing period, name the entity), and its advice is
 * wrong for this product: a self-hosted Cloudgate instance has no support desk,
 * it has an owner. **The person who has just lost access is not the reader of
 * this string** — the console renders `BANNED_USER` through its own sentence
 * (`frontend/src/lib/auth/auth-error.ts`), which is where "what to do next"
 * belongs and where it says to ask an owner. This one is read by whoever reads
 * the log or the raw body, and §2.5 is written for them.
 */
export const BANNED_MESSAGE = 'This account is banned';

/**
 * The code that refusal carries on **both** surfaces, and it is better-auth's
 * rather than Cloudgate's on purpose (H-08, H-26).
 *
 * A browser cannot tell a refusal Cloudgate raised inside `/api/auth/*` from
 * one the admin plugin raised: both arrive as the same JSON on the same origin
 * from the same client. The plugin already publishes `BANNED_USER` when it
 * refuses a banned account a *new* session (`admin.mjs:44-48`), which is the
 * refusal the sign-in screen sees, so a second spelling for the same fact would
 * make the console handle two codes to learn one thing.
 *
 * `OWNER_REFUSALS`'s `USER_BANNED` is *not* that code and is not renamed to
 * match: it is logged rather than published (`CredentialRejection.code`), it is
 * better-auth's api-key vocabulary rather than its session vocabulary, and
 * `NAMED_API_KEY_REFUSALS` is keyed on it so that the plugin moving its own
 * check onto the verify path stays a version bump.
 *
 * H-26 is the other half of the same argument. Cloudgate's own routes refuse a
 * banned cookie through `AuthGuard`, and their error body carried no code at
 * all — so the console, which has one sentence for a 403, told a banned
 * operator their **role** was the problem. `OWNER_REFUSALS.SESSION_BANNED`
 * therefore publishes *this* constant as its `publishedCode`, beside rather
 * than instead of the api-key `code`. String-matching `BANNED_MESSAGE` in the
 * console would have worked and was rejected: `auth-error.ts` records a ticket
 * as having been filed to delete exactly that, and a sentence is allowed to
 * change — H-29 replaced better-auth's spelling of this very refusal in the
 * same commit that would have started matching it.
 */
export const BANNED_CODE = 'BANNED_USER';
