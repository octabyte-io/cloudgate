import type { TemplateReading } from './template-rules';

/**
 * `signIn` against the rest of the template (#131): every input it names is
 * one the template has, and is one the compose file reads, so its value is in
 * the stack's variables where Get started's done card reads it. The password
 * is a secret: asked with `secret: true`, or generated as a password, hex or
 * base64 string, never a JWT or a uuid.
 */
export function signInRule({
  template,
  compose,
}: TemplateReading): string | null {
  const { signIn, inputs } = template;
  if (signIn === undefined || 'firstVisit' in signIn) return null;

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
  const secret =
    ('ask' in rule && rule.ask.secret === true) ||
    ('generate' in rule &&
      (rule.generate === 'password' ||
        rule.generate === 'hex' ||
        rule.generate === 'base64'));
  if (!secret) {
    return `template.yaml: signIn.password names ${signIn.password}, which is not a secret: ask it with secret: true, or generate a password`;
  }
  return null;
}
