import { updateApplicationSchema } from '../../src/applications/dto/application.dto';
import { SEPARATOR_PAYLOAD, SHELL_PAYLOAD } from '../utils/shell-safety';

/**
 * H-47. `dockerImage` was `z.string().nullable()` — no charset, no mint,
 * nothing — and H-34 found it reaching `docker tag` as a bare word through
 * `builtImageName()`. H-34 quoted the five sinks, which is the defence and
 * remains it; this is the half it could not reach from where it stood, and the
 * half `builders/build-strategy.ts` names when it says *the quoting is the
 * defence, and every charset in the tree is belt-and-braces behind it*.
 *
 * These drive the schema rather than a `PATCH`, because the claim is about the
 * contract the global pipe validates against and `applications.e2e-spec.ts` is
 * where the route is asserted. The grammar itself — the real-world references
 * it must keep accepting, the length, the anchoring — is pinned once in
 * `test/registries/registry.dto.spec.ts`, where the schema lives.
 */
describe('updateApplicationSchema dockerImage', () => {
  const parse = (dockerImage: string | null) =>
    updateApplicationSchema.safeParse({ dockerImage });

  it('refuses the value H-34 got a 200 for', () => {
    // Verbatim from f6e82c9: with `sourceType: 'docker'`, this stored word
    // became `docker tag nginx:a$(id); touch /tmp/h34-pwn # …` on the build
    // server. The word is quoted now, and it is also no longer storable.
    expect(parse(`nginx:${SEPARATOR_PAYLOAD}`).success).toBe(false);
  });

  it('refuses a command substitution in the tag', () => {
    expect(parse(`nginx:${SHELL_PAYLOAD}`).success).toBe(false);
  });

  it('accepts the image references a docker-sourced application runs', () => {
    for (const reference of [
      'nginx',
      'nginx:1.27.4-alpine',
      'ghcr.io/acme/app:v1.2.3-rc.1',
      `registry:5000/team/app@sha256:${'a'.repeat(64)}`,
      'registry.example.com/team/api:v2',
    ]) {
      expect(parse(reference).success).toBe(true);
    }
  });

  // Both spellings of "this application has no image" — `null` for a
  // git-sourced row, `''` for a cleared field. The API has taken both since the
  // column existed and `builtImageName` reads `dockerImage || ''`, so neither
  // is an oversight; `publishDirectory` makes the same allowance for the same
  // reason.
  it('keeps taking null and the empty string, which both mean no image', () => {
    expect(parse(null).success).toBe(true);
    expect(parse('').success).toBe(true);
  });

  // `.partial()`, so a PATCH that does not send the column does not parse it —
  // which is also why `docker.strategy.ts` still escapes rather than deriving
  // from this schema: rows written before this rule are already stored.
  it('leaves a payload that does not name the column alone', () => {
    expect(
      updateApplicationSchema.safeParse({ name: 'shop-api' }).success,
    ).toBe(true);
  });
});
