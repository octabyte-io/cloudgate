import { updateApplicationSchema } from '../../src/applications/dto/application.dto';
import { elideEncodedPayloads } from '../../src/common/logging/error-payloads';
import { updateRegistrySchema } from '../../src/registries/dto/registry.dto';
import { dockerStrategy } from '../../src/git-providers/strategies/docker.strategy';
import { SEPARATOR_PAYLOAD, SHELL_PAYLOAD } from '../utils/shell-safety';

/**
 * H-54. An Application that runs somebody else's image carries its own pull
 * credentials — `registryUrl`, `username`, `password` — and the Registry row
 * carries the same three under different names (`url`, `username`,
 * `password`). One of the two tables constrained its host and the other typed
 * it `z.string().nullable()`, which is the shape H-34 found `dockerImage` in
 * and d70bbfc closed on this very file without reaching the field two lines
 * below it.
 *
 * The value reaches `docker login ${shEscape(registryUrl)}`
 * (`git-providers/strategies/docker.strategy.ts`) and dockerode's
 * `authconfig.serveraddress` (`deployment-engine/mechanize.ts`). Both sinks are
 * unchanged and stay that way: the escape is the defence, and a sink that
 * relaxed because a DTO started validating is the reliance H-12 and H-19
 * each reopened. What these pin is that the column now means something, and
 * that it means the *same* thing on both tables.
 */
describe('updateApplicationSchema registry credentials', () => {
  const parseUrl = (registryUrl: string | null) =>
    updateApplicationSchema.safeParse({ registryUrl });

  /**
   * The whole finding in one assertion: the two columns are the same value, so
   * they answer the same way. Written as an equivalence rather than as two
   * lists, because two lists drift and this one cannot — a rule added to either
   * table and not the other fails here.
   */
  const bothTables = [
    'ghcr.io',
    'docker.io',
    'registry.example.com',
    'localhost:5000',
    'registry.internal:5000',
    '123456789012.dkr.ecr.us-east-1.amazonaws.com',
    'europe-west1-docker.pkg.dev',
    '',
    'https://ghcr.io',
    'ghcr.io/acme',
    `ghcr.io${SHELL_PAYLOAD}`,
    `ghcr.io${SEPARATOR_PAYLOAD}`,
    'ghcr.io -u root',
    'ghcr.io`id`',
  ];

  it.each(bothTables)(
    'answers about %j exactly as the Registry row does',
    (url) => {
      expect(parseUrl(url).success).toBe(
        updateRegistrySchema.safeParse({ url }).success,
      );
    },
  );

  it('accepts the registries a docker-sourced application is actually pulled from', () => {
    for (const url of [
      'ghcr.io',
      'docker.io',
      'registry.example.com',
      'localhost:5000',
      'registry.internal:5000',
      '123456789012.dkr.ecr.us-east-1.amazonaws.com',
      'europe-west1-docker.pkg.dev',
      'quay.io',
    ]) {
      expect(parseUrl(url).success).toBe(true);
    }
  });

  it('refuses a second word after the host', () => {
    expect(parseUrl(`ghcr.io${SEPARATOR_PAYLOAD}`).success).toBe(false);
    expect(parseUrl('ghcr.io -u root').success).toBe(false);
  });

  /**
   * Both spellings of "no registry", and neither is an oversight. `null` is
   * what the console sends for a cleared field (`registryUrl: values.registryUrl
   * || null`); `''` is what `registryUrlSchema` has always documented as the
   * default registry, and what `mechanize.ts` writes into `serveraddress`
   * through `registryUrl || ''`.
   */
  it('keeps null and the empty string, which both mean Docker Hub', () => {
    expect(parseUrl(null).success).toBe(true);
    expect(parseUrl('').success).toBe(true);
  });

  /**
   * The negative claim, so the omission reads as a decision rather than a miss
   * — and it is the same decision `updateRegistrySchema` records for the same
   * field one module over.
   *
   * A registry login is not a path and not a hostname: ECR wants exactly `AWS`,
   * Google Artifact Registry wants `_json_key` or `oauth2accesstoken`, Docker
   * Hub takes an email, and a service account may carry an `@`. A charset over
   * that set refuses logins that work, which is worse than no charset at all
   * because the sink that matters already quotes it.
   */
  it('leaves the username to the quoting at its sinks, as the Registry row does', () => {
    for (const username of [
      'AWS',
      '_json_key',
      'oauth2accesstoken',
      'bot@example.com',
      'acme-corp',
    ]) {
      expect(updateApplicationSchema.safeParse({ username }).success).toBe(
        true,
      );
      expect(updateRegistrySchema.safeParse({ username }).success).toBe(true);
    }
  });

  it('trims the username the way the Registry row trims it', () => {
    const parsed = updateApplicationSchema.safeParse({ username: '  AWS  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.username).toBe('AWS');
  });

  /**
   * **A password is not a value you give a charset**, and this is the
   * assertion that says so out loud.
   *
   * A registry token is chosen by somebody else's system — a GitHub PAT, an ECR
   * `get-login-password` blob, a base64 service-account key — and every
   * character a rule here refused would be a credential Cloudgate cannot store
   * for a registry that works. The Registry row reaches the same conclusion
   * (`password: z.string().min(1)` and no pattern), and unlike a hostname there
   * is no specification to transcribe: `registry.dto.ts` could copy
   * `distribution/reference` because a reference *is* specified, and nothing
   * specifies a secret.
   *
   * So the defence is the one that was always doing the work, and the second
   * half of this test is it: the value goes over stdin, single-quoted, so it
   * never becomes a word of **`docker`'s argv** and is not in the host's
   * process table. `application.password` is an `encryptedText` column on top
   * of that, so it is not readable back either.
   *
   * **The sentence this paragraph used to end with — that the password "never
   * becomes a word of the login command" — was wrong, and a review caught
   * it.** It *was* a word of the login command: `printf %s '<the password>'`
   * was the first word of the pipeline. What `--password-stdin` keeps it out of
   * is the argv of the program being driven, not the shell string that drives
   * it — and that string is exactly what `ExecError` captures and pino writes,
   * so a refused login printed the password into the journal. A later fix masked it on
   * the way out (`common/logging/error-payloads.ts`).
   *
   * **Now the original sentence is true, and by construction rather than
   * by a mask.** The strategy emits `printf %s "$CG_SOURCE_REGISTRY_PASSWORD"`
   * and hands the value back in `SourceProgram.env`, which
   * `DeploymentEngineService.exec` gives to `RemoteExecOptions.env` — `export`
   * lines on the SSH channel, which `ExecError` never records. So the assertion
   * below is absence *as constructed*, before any error exists, which is a
   * property no mask can manufacture; the elision assertion stays beneath it
   * because a second defence is not the same claim as the first.
   */
  it('gives the password no charset, and keeps it out of the sink entirely', () => {
    const password = `pa${SEPARATOR_PAYLOAD}ss`;
    expect(updateApplicationSchema.safeParse({ password }).success).toBe(true);
    expect(updateRegistrySchema.safeParse({ password }).success).toBe(true);

    // The real sink, rather than the login builder in isolation: what has to be
    // free of the value is the whole program the deploy composes.
    const { command, env } = dockerStrategy.cloneProgram({
      outputPath: '/etc/cloudgate/applications/web/code',
      dockerImage: 'ghcr.io/acme/web:1',
      registryUrl: 'ghcr.io',
      username: 'acme',
      password,
    });

    expect(command).not.toContain(password);
    expect(command).toContain('printf %s "$CG_SOURCE_REGISTRY_PASSWORD"');
    expect(command).toContain('--password-stdin');
    // …and it reaches the login, so the absence above is never-carry rather
    // than a credential dropped on the floor.
    expect(env).toEqual({ CG_SOURCE_REGISTRY_PASSWORD: password });
    // The journalled copy of the command is unchanged by the elision, because
    // there is nothing left in it to elide.
    expect(elideEncodedPayloads(command)).toBe(command);
  });

  it('keeps null on both credentials, which is how a field is cleared', () => {
    expect(updateApplicationSchema.safeParse({ username: null }).success).toBe(
      true,
    );
    expect(updateApplicationSchema.safeParse({ password: null }).success).toBe(
      true,
    );
  });

  // `.partial()`, so a PATCH that names none of the three parses none of them
  // — which is why `docker.strategy.ts` still escapes rather than deriving from
  // this schema: rows written before this rule are stored and unrevalidated.
  it('leaves a payload that names none of the three alone', () => {
    expect(
      updateApplicationSchema.safeParse({ name: 'shop-api' }).success,
    ).toBe(true);
  });
});
