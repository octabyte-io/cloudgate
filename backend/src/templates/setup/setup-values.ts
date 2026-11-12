import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { askedValueProblem, referencesIn } from '../check';
import type { InputRule, TemplateReference } from '../check';

/**
 * A Template's values, made once at setup (ADR-0064): every generated value
 * from a cryptographically secure source, every asked value checked against
 * its format or pattern, and every fixed value with its `{{NAME}}`
 * references filled in. The old `generatePassword` (`Math.random`,
 * lowercased) is deliberately not used: it was the weakness ADR-0064 names.
 *
 * Pure but for the random source, which a caller may hand in so a test can
 * pin it. Nothing here reads a database, the network or the clock.
 */

/** How a value is made, as a Plan shows it in place of the value. */
export type MadeAs =
  | 'generated (password, 32 characters)'
  | 'generated (hex, 64 characters)'
  | 'generated (base64, 32 bytes)'
  | 'generated (uuid)'
  | 'generated (jwt, HS256)'
  | 'asked'
  | 'fixed';

/** The random source values are drawn from: `node:crypto` unless a test pins it. */
export interface RandomSource {
  /** `n` random bytes. */
  bytes(n: number): Buffer;
  /** A random integer in [0, max). */
  below(max: number): number;
  uuid(): string;
}

export const CRYPTO_RANDOM: RandomSource = {
  bytes: (n) => randomBytes(n),
  below: (max) => randomInt(max),
  uuid: () => randomUUID(),
};

const PASSWORD_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 32;
const HEX_BYTES = 32;
/** The owner's ruling: 32 bytes, as ADR-0064's list says (its 64 is a typo). */
const BASE64_BYTES = 32;

/** The Plan's line for an input: how its value is made, never the value. */
export function madeAs(rule: InputRule): MadeAs {
  if ('generate' in rule) {
    switch (rule.generate) {
      case 'password':
        return 'generated (password, 32 characters)';
      case 'hex':
        return 'generated (hex, 64 characters)';
      case 'base64':
        return 'generated (base64, 32 bytes)';
      case 'uuid':
        return 'generated (uuid)';
      case 'jwt':
        return 'generated (jwt, HS256)';
    }
  }
  return 'ask' in rule ? 'asked' : 'fixed';
}

/** Whether a value is a secret: shown as present, never as itself. */
export function isSecretInput(rule: InputRule): boolean {
  if ('ask' in rule) return rule.ask.secret === true;
  // A fixed value can spell out a password (`postgres://u:{{PW}}@…`), so
  // it is treated as one: presence is all a screen needs of it.
  return true;
}

/**
 * What a setup's form answered: an asked value by input name. A Domain's
 * URL or host, by `{{domains.<name>.…}}` name, from the hosts the setup
 * picked; `null` when it picked none for that name.
 */
export interface SetupAnswers {
  readonly asked: Readonly<Record<string, string>>;
  readonly domain: (name: string, part: 'url' | 'host') => string | null;
}

export type MadeValues =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problems: readonly ValueProblem[] };

/** Why one input has no value: named by the input, read by the form. */
export interface ValueProblem {
  readonly input: string;
  readonly message: string;
}

/**
 * Every input's value, or every problem with what was asked. Asked values
 * are checked before anything is generated, so a bad email costs no secret.
 * The Template check has already refused a loop, an unknown reference and a
 * jwt signed with no input, so filling in only follows references.
 */
export function makeValues(
  inputs: Readonly<Record<string, InputRule>>,
  answers: SetupAnswers,
  random: RandomSource = CRYPTO_RANDOM,
): MadeValues {
  const problems: ValueProblem[] = [];
  for (const name of Object.keys(answers.asked)) {
    const rule = inputs[name] as InputRule | undefined;
    if (!rule || !('ask' in rule)) {
      problems.push({
        input: name,
        message: `${name} is not a value this template asks for`,
      });
    }
  }
  for (const [name, rule] of Object.entries(inputs)) {
    if (!('ask' in rule)) continue;
    const given = answers.asked[name];
    const value = given ?? rule.ask.default ?? '';
    if (value === '') {
      if (rule.ask.required !== false) {
        problems.push({
          input: name,
          message: `${rule.ask.label} is required`,
        });
      }
      continue;
    }
    const problem = askedValueProblem(rule.ask, value);
    if (problem) {
      problems.push({ input: name, message: `${rule.ask.label} ${problem}` });
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const values = new Map<string, string>();
  const valueOf = (name: string): string => {
    const known = values.get(name);
    if (known !== undefined) return known;
    const made = makeOne(name, inputs[name], answers, random, valueOf);
    values.set(name, made);
    return made;
  };
  const unfilled: ValueProblem[] = [];
  for (const name of Object.keys(inputs)) {
    try {
      valueOf(name);
    } catch (error) {
      if (!(error instanceof Unfilled)) throw error;
      unfilled.push({ input: name, message: error.message });
    }
  }
  if (unfilled.length > 0) return { ok: false, problems: unfilled };
  return { ok: true, values: Object.fromEntries(values) };
}

/** A reference whose value setup did not make: a Domain host it picked none for. */
class Unfilled extends Error {}

function makeOne(
  name: string,
  rule: InputRule,
  answers: SetupAnswers,
  random: RandomSource,
  valueOf: (name: string) => string,
): string {
  if ('ask' in rule) return answers.asked[name] ?? rule.ask.default ?? '';
  if ('value' in rule) return fillReferences(rule.value, answers, valueOf);
  switch (rule.generate) {
    case 'password': {
      let password = '';
      for (let at = 0; at < PASSWORD_LENGTH; at += 1) {
        password += PASSWORD_ALPHABET[random.below(PASSWORD_ALPHABET.length)];
      }
      return password;
    }
    case 'hex':
      return random.bytes(HEX_BYTES).toString('hex');
    case 'base64':
      return random.bytes(BASE64_BYTES).toString('base64');
    case 'uuid':
      return random.uuid();
    case 'jwt':
      // Narrowed by the schema: a jwt rule always names its secret.
      return signJwt(
        (rule as { payload: Record<string, unknown> }).payload,
        valueOf((rule as { secret: string }).secret),
      );
  }
}

/**
 * Text with every `{{…}}` replaced by what it refers to. Used for fixed
 * values here and, by the setup service, for config file text, so the two
 * read references alike.
 */
export function fillReferences(
  text: string,
  answers: Pick<SetupAnswers, 'domain'>,
  valueOf: (name: string) => string,
): string {
  let filled = text;
  for (const { written, reference } of referencesIn(text)) {
    if (reference === null) continue;
    filled = filled.split(written).join(resolve(reference, answers, valueOf));
  }
  return filled;
}

/**
 * A config file's text with its references filled in once, at setup
 * (ADR-0064): each `{{domains.<name>.url|host}}` and each `{{NAME}}` naming
 * one of `values`. Every other `{{…}}`, a name no input has among them, is
 * the file's own (a Handlebars or Jinja file has its own braces) and stays
 * as written, as the Template check reads it (`template-files.ts`). A
 * Domain setup picked no host for refuses the setup, as for a fixed value.
 */
export function fillFileText(
  text: string,
  answers: Pick<SetupAnswers, 'domain'>,
  values: Readonly<Record<string, string>>,
): string {
  let filled = text;
  for (const { written, reference } of referencesIn(text)) {
    if (reference === null) continue;
    if (reference.kind === 'input' && !(reference.name in values)) continue;
    filled = filled
      .split(written)
      .join(resolve(reference, answers, (name) => values[name]));
  }
  return filled;
}

function resolve(
  reference: TemplateReference,
  answers: Pick<SetupAnswers, 'domain'>,
  valueOf: (name: string) => string,
): string {
  if (reference.kind === 'input') return valueOf(reference.name);
  const found = answers.domain(reference.name, reference.part);
  if (found === null) {
    throw new Unfilled(
      `refers to {{domains.${reference.name}.${reference.part}}}, and setup has no host for ${reference.name}`,
    );
  }
  return found;
}

/**
 * A JSON Web Token signed HS256 with `secret`, with no expiry unless the
 * payload sets one (ADR-0064): the claims are the template's, as written.
 */
export function signJwt(
  payload: Readonly<Record<string, unknown>>,
  secret: string,
): string {
  const encode = (part: object) =>
    Buffer.from(JSON.stringify(part)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  const signature = createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}
