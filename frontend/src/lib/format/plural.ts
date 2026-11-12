/**
 * Words that agree with a count.
 *
 * Written because a toast read **"1 variables are now set here"**
 * the count was
 * computed and the sentence around it was not. The console's prevailing idiom is
 * an inline `count === 1 ? … : …` beside the number, which is fine for one word
 * and is exactly what gets forgotten when a sentence needs *two* words to agree
 * — a noun and its verb. Both go through here instead.
 *
 * It lives in `lib/format/` rather than beside the toast because agreement is
 * formatting rather than a feature, and because the second caller would
 * otherwise copy it (§1.4's promotion rule).
 */

/**
 * Whichever of two words agrees with `count`.
 *
 * `agreeing(1, "is", "are")` → `"is"`. Both words are the caller's, because
 * English does not derive them: `is`/`are`, `has`/`have`, `it`/`them`.
 */
export function agreeing(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * A count and its noun, agreeing: `counted(1, "variable", "variables")` →
 * `"1 variable"`.
 *
 * **The plural is required, and defaulting it to `${noun}s` was tried and
 * rejected.** `design-system.md` records that derivation failing twice — F09's
 * source providers and F11's resource specs both spell their plurals out
 * because `${noun}s` printed **"repositorys"** on screen. A default would put
 * the trap back and make the safe form the opt-in, which is the wrong way round
 * for a helper whose whole purpose is that the words agree.
 */
export function counted(count: number, noun: string, plural: string): string {
  return `${count} ${agreeing(count, noun, plural)}`;
}
