/**
 * Take the secrets we just sent back out of a message we are about to render.
 *
 * Blunt on purpose — a literal replace of the exact strings, not a pattern that
 * tries to recognise what a secret looks like. Short values are left alone: a
 * one-character key would otherwise redact half the sentence, and a secret that
 * short is not a secret.
 *
 * Promoted out of `destinations-spec.tsx` when the registry dialog and an
 * Application's Docker-image source needed the same last pass over a test's
 * refusal.
 */
export function redactSecrets(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    out = out.split(secret).join("••••••");
  }
  return out;
}
