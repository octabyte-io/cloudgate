import { parse } from 'shell-quote';

/**
 * The value the shell-injection tests feed into every command builder. `$(…)`
 * rather than a backtick on purpose: `shell-quote`'s `parse` reports an
 * unquoted `$(` as an *operator* and a quoted one as an ordinary character, so
 * it is the one payload whose fate a parse can actually decide (a backtick
 * comes back as a plain character either way).
 */
export const SHELL_PAYLOAD = 'a$(id)';

/**
 * Asserts that `value` reached `command` as one inert word.
 *
 * Deliberately not a literal-string comparison: the acceptance shape asks for
 * the *outcome*, so a later change from `'a$(id)'` to `a\$\(id\)` — both
 * correct, both what `shell-quote` emits for different inputs — must not fail
 * this. What it pins is the property that matters: the word the shell would
 * hand the program still carries the stored value, and the value introduced no
 * expansion or command-substitution operator anywhere in the command.
 *
 * `parse` is the assertion rather than a regex because a regex over the emitted
 * string cannot tell `'a$(id)'` from `a$(id)` — a quoted payload still
 * *contains* the payload — which is exactly the mistake this helper exists to
 * stop a test from making.
 *
 * `substitutions` is for the builders that legitimately contain one:
 * `buildScheduleCommandScript` opens with `CONTAINER_ID=$(<containerSearch>)`,
 * where the substitution is the contract rather than an injection.
 */
export const expectQuotedInCommand = (
  // `string | null` because the strategy interfaces return null for a command
  // that does not apply to a source type, and a null there would otherwise pass
  // silently as "nothing unquoted".
  command: string | null,
  value = SHELL_PAYLOAD,
  substitutions = 0,
): void => {
  expect(typeof command).toBe('string');
  const words = parse(command as string);
  const literals = words.filter(
    (word): word is string => typeof word === 'string',
  );
  // `includes` rather than equality: a `k=v` word quotes the value and keeps
  // the literal key, so the payload arrives inside a larger single word.
  expect(literals.some((word) => word.includes(value))).toBe(true);
  const substituted = words.filter(
    (word) => typeof word !== 'string' && 'op' in word && word.op === '(',
  );
  expect(substituted).toHaveLength(substitutions);
};

/**
 * The value the separator tests feed in — `$(…)` **and** a `;` **and** a space,
 * where {@link SHELL_PAYLOAD} carries only the first (H-34).
 *
 * H-12 is why the second and third are here: `SHELL_UNSAFE` carried `$` and a
 * backtick and not `;`, so a payload made only of a substitution said a word
 * was safe when a separator walked straight through it. A payload that
 * separates *and* substitutes cannot be passed by a sink that stops one and not
 * the other. Deliberately not run through the mint the value has in production
 * — the claim is that the command builder is safe on its own.
 */
export const SEPARATOR_PAYLOAD = 'a$(id); touch /tmp/h34-pwn #';

/** The same value with nothing in it a shell reacts to — the control arm of
 * {@link expectValueIsInert}. */
export const INERT_VALUE = 'inert';

/**
 * Asserts that a value changed the *words* of a command and none of its
 * **syntax** (H-34) — given the command built with {@link SEPARATOR_PAYLOAD}
 * and the same command built with {@link INERT_VALUE}.
 *
 * Two arms rather than one, because a single-command assertion is only as
 * strong as the count it hard-codes. `expectQuotedInCommand` above pins the
 * number of substitutions, which is right for a builder whose own `$( … )` is a
 * fixed part of its contract and wrong for one that wraps its steps in
 * `( … )` — `shell-quote` reports that subshell as the same operator. And a
 * "some word carries the payload" check passes as soon as *one* of a builder's
 * ten redirects is quoted, which is the mistake this pair exists to stop a test
 * from making: the control arm makes every operator the payload introduced
 * anywhere in the command a failure, and mapping each word to a placeholder
 * makes a word-split one too.
 *
 * The second expectation is what stops the first from being satisfied by a
 * sink that drops the value: it has to still be there, whole, in one word.
 */
export const expectValueIsInert = (
  poisonedCommand: string,
  inertCommand: string,
  value = SEPARATOR_PAYLOAD,
): void => {
  const syntax = (command: string) =>
    parse(command).map((word) => (typeof word === 'string' ? '<word>' : word));
  expect(syntax(poisonedCommand)).toEqual(syntax(inertCommand));
  const literals = parse(poisonedCommand).filter(
    (word): word is string => typeof word === 'string',
  );
  expect(literals.some((word) => word.includes(value))).toBe(true);
};
