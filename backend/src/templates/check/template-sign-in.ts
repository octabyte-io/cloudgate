import { referencesIn } from './template-references';
import type { TemplateReading } from './template-rules';
import type { InputRule } from './template-yaml';

/**
 * `signIn` against the rest of the template (#131, #140): every input it
 * names is one the template has, and is one the compose file reads, so its
 * value is in the stack's variables where Get started's done card reads it.
 * The Domain it names, on either form, is one `domains` lists, and lists
 * once: a service several Domains share names none of them, as
 * `{{domains.<name>.url}}` does not (`template-inputs.ts`).
 *
 * The password is a secret: asked with `secret: true`, or generated as a
 * password, hex or base64 string, never a JWT or a uuid. A `value` input is
 * a secret too when its text is exactly one reference, `{{NAME}}`, to such an
 * input (#140, item 4): templates such as fab-manager wrap a generated
 * password in a value (`ADMIN_PASSWORD: { value: "{{ADMIN_PASSWORD_RANDOM}}" }`),
 * and the stack's variable then holds that same secret. Any other value
 * (fixed text, text around the reference, a reference to an input that is not
 * a secret) is refused: its text is written in the template for anyone to
 * read, or is not only the secret. Whitespace around the reference is refused
 * with it, since it would be part of the password; the reference syntax has
 * none inside the braces either.
 */
export function signInRule({
  template,
  compose,
}: TemplateReading): string | null {
  const { signIn, inputs, domains } = template;
  if (signIn === undefined) return null;

  const [domainField, domain] =
    'firstVisit' in signIn
      ? ['firstVisit.domain', signIn.firstVisit.domain]
      : ['domain', signIn.domain];
  if (domain !== undefined) {
    const count = domains.filter(({ service }) => service === domain).length;
    if (count === 0) {
      return `template.yaml: signIn.${domainField} names ${domain}, which domains does not list: name a Domain by its service`;
    }
    if (count > 1) {
      return `template.yaml: signIn.${domainField} names ${domain}, which has ${count} Domains in domains, so it names none of them: give the sign-in its own service, or leave domain out`;
    }
  }
  if ('firstVisit' in signIn) return null;

  const named = (field: string, name: string): string | null => {
    if (!Object.hasOwn(inputs, name)) {
      return `template.yaml: signIn.${field} names ${name}, which inputs has no rule for`;
    }
    if (!compose?.variables.mentions.has(name)) {
      return `template.yaml: signIn.${field} names ${name}, which docker-compose.yml does not read, so its value is not in the stack's variables`;
    }
    return null;
  };

  if (typeof signIn.username === 'string') {
    const problem = named('username', signIn.username);
    if (problem) return problem;
  }
  const problem = named('password', signIn.password);
  if (problem) return problem;

  const rule = inputs[signIn.password];
  if (!('value' in rule)) {
    return isSecret(rule)
      ? null
      : `template.yaml: signIn.password names ${signIn.password}, which is not a secret: ask it with secret: true, or generate a password`;
  }
  const [only] = referencesIn(rule.value);
  if (only?.written !== rule.value || only.reference?.kind !== 'input') {
    return `template.yaml: signIn.password names ${signIn.password}, a value that is not a secret: a value is taken only when it is exactly one reference, {{NAME}}, to an input asked with secret: true or generated as a password`;
  }
  const referred = only.reference.name;
  return Object.hasOwn(inputs, referred) && isSecret(inputs[referred])
    ? null
    : `template.yaml: signIn.password names ${signIn.password}, a value that refers to ${referred}, which is not a secret: ask it with secret: true, or generate a password`;
}

/** Asked with `secret: true`, or generated as a password, hex or base64. */
function isSecret(rule: InputRule): boolean {
  return (
    ('ask' in rule && rule.ask.secret === true) ||
    ('generate' in rule &&
      (rule.generate === 'password' ||
        rule.generate === 'hex' ||
        rule.generate === 'base64'))
  );
}
