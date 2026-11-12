import { z } from "zod";

/**
 * The hostname rule the console's forms share.
 *
 * Promoted out of `features/` the moment a second feature needed it (§1.4's
 * promotion rule): the Domain form has mirrored `hostSchema`, and
 * `POST /settings/assign-domain` holding the console's own host to the same rule
 * gave it a second caller. `lib/forms/credentials.ts` is the precedent and its
 * reasoning applies unchanged — one definition, because the moment each form
 * writes its own the same mistake gets a different sentence.
 *
 * It stays a copy of the backend's rule rather than a guess at one: the regex is
 * `VALID_HOSTNAME_REGEX` from `backend/src/domains/dto/domain.dto.ts` (RFC 1123
 * labels, at least two of them, underscores rejected), and the sentence
 * is the backend's own words. One `hostSchema` serves every host on the backend,
 * so one mirror here is the faithful shape — two would be the thing that drifts.
 *
 * **What the two sides agree on, and where they do not.** For every value a form
 * built here can *send*, the charset rule is the same regex and the refusal is
 * the same sentence, so a host this side accepts is not a host that side 400s on
 * and a host this side refuses is not one it would have taken. The field *text*
 * in front of that is a different question, and this module owns the answer
 * rather than leaving each form to arrive at its own (X11-5):
 *
 * - **Surrounding whitespace is normalised here, not refused.** `hostSchema`
 *   refuses it in words of its own — `'Domain name cannot have leading or
 *   trailing spaces'` — and a form does not, because `" api.example.com"` pasted
 *   out of a terminal is a hostname somebody got right and a refusal citing an
 *   invisible character is a dead end. So `hostnameField` trims *before* the
 *   rule applies and hands the trimmed value on: that arm of `hostSchema` is
 *   unreachable from these forms rather than contradicted by them. It is
 *   reachable from elsewhere and deliberately kept — another client, and
 *   `SettingsService.sweepConsoleHost` reading a stored value — which is why the
 *   asymmetry is stated here instead of being read as a rule nobody needs.
 * - **Length and emptiness stay each form's own, and both are named at their
 *   field.** Emptiness because it means opposite things — `''` unassigns the
 *   console domain (`removeConfig('cloudgate')` deletes `dynamic/cloudgate.yml`)
 *   and is a missing field on a Domain — so `hostnameField` takes the sentence
 *   rather than owning one. Length because the console's card carries a
 *   `max(255)` predating the rule and the backend carries none, so that one
 *   field refuses a 256-character host the route would accept: the single place
 *   this side is stricter, and the reason the paragraph above is scoped to the
 *   charset rather than claiming everything.
 */

/** Mirrors `VALID_HOSTNAME_REGEX` (`domains/dto/domain.dto.ts`). */
export const HOSTNAME =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * The refusal, with the example hostname the field in question should show.
 *
 * The example is the parameter rather than the whole message because that is the
 * only part that legitimately differs — a Domain's field says
 * `api.example.com` and the console's says `console.example.com`, and the rule
 * they are both refusing is identical. Sharing the sentence and varying the
 * example keeps the two from drifting into two different accounts of one rule.
 */
export const hostnameMessage = (example: string) =>
  `Use only letters, numbers, hyphens and dots — ${example}. Underscores are not allowed.`;

/**
 * What a field holding `value` sends: the text the rule was applied to.
 *
 * One line, and exported anyway, because the whitespace paragraph above is only
 * true while every reader of a host field applies the *same* normalisation. It
 * was three private `.trim()` calls — the schema's, the DNS-record preview's and
 * the Check DNS payload's — and three copies of a policy is how the fourth comes
 * out different.
 */
export const hostnameValue = (value: string) => value.trim();

/**
 * Whether a field's text is a host the rule accepts.
 *
 * The rule for the readers that are not the schema: something deciding what to
 * render or offer while a host is still being typed, with nothing submitted for
 * a resolver to have answered about. An empty box is not a hostname — a caller
 * asking this is asking whether it has something to work from, and `false` is
 * the cue to render nothing.
 */
export const isHostname = (value: string) =>
  HOSTNAME.test(hostnameValue(value));

/**
 * The rule as a form field applies it: whitespace off, then the charset, with
 * the example this field should show.
 *
 * `empty` is the whole emptiness policy — the sentence for a box that may not be
 * empty, its absence for a form where `''` is a state that means something. The
 * charset check steps over `''` for the reason `consoleHostSchema` short-circuits
 * it before reaching `hostSchema`: the charset has nothing to say about a box
 * nobody has filled in, and a second issue stacked under 'Add a hostname.' is one
 * field telling one story twice.
 */
export function hostnameField({
  example,
  empty,
}: {
  example: string;
  /** The refusal for an empty box, or omitted where `''` is a valid answer. */
  empty?: string;
}) {
  const text = z.string().trim();
  return (empty === undefined ? text : text.min(1, empty)).refine(
    (value) => value === "" || isHostname(value),
    { message: hostnameMessage(example) },
  );
}
