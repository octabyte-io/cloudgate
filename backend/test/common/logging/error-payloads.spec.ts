import { getCreateFileCommand } from '../../../src/docker/docker.utils';
import {
  elideEncodedPayloads,
  elidePayloadsInError,
  REDACTED_ERROR_FIELDS,
} from '../../../src/common/logging/error-payloads';
import { REDACTED_ERROR_FIELDS as REEXPORTED } from '../../../src/destinations/s3-credentials';
import { dockerLoginCommand } from '../../../src/registries/registry.utils';

/**
 * The pipeline `STDIN_CREDENTIAL` recognises, spelled out here rather than
 * built by the product.
 *
 * **It used to come from `safeDockerLoginCommand`, and now nothing in
 * `src/` emits it at all**: both live sites — `uploadImageCommands` and
 * `git-providers/strategies/docker.strategy.ts` — reference a holder the remote
 * shell expands, and the value travels in `RemoteExecOptions.env`. So the
 * pattern is a backstop for `docker`'s own wire format rather than for a shape
 * this tree chose, and driving it from the builder would now assert the mask
 * against a string it can never see. A literal is the honest input: it says
 * "this is what the next caller might write", which is exactly what the
 * pattern is kept for.
 *
 * The complementary claim — that the shapes the tree *does* emit have nothing
 * left to elide — is at the end of this describe, and it is the one that would
 * red if a login site went back to carrying its password.
 */
const stdinLogin = (registry: string, user: string, password: string): string =>
  `printf %s '${password.split("'").join(`'\\''`)}' | docker login '${registry}' -u '${user}' --password-stdin`;

const SECRET = 'STRIPE_SECRET_KEY=sk_live_91b3d0c6f2a84e57';
const encode = (content: string): string =>
  Buffer.from(content, 'utf-8').toString('base64');

/**
 * The reader's own falsification: decode every base64-alphabet run the text
 * holds and assert none of them yields the secret.
 *
 * Not "no run decodes to anything" — an ordinary word is in base64's alphabet
 * (`Dockerfile` decodes to five bytes of noise), so the only honest assertion
 * is about the secret, which is also the only one a leak would fail.
 *
 * **What this oracle cannot see.** It decodes each base64-alphabet *run*
 * separately, so a payload split across two runs defeats it while defeating no
 * human at all: `echo "AAA\nBBB" | base64 -d` is two runs, neither of which
 * decodes to the secret on its own, and rejoining them is a copy and a paste.
 * That is a real limitation of this assertion rather than a property of the
 * elision, and the chunked shape is one of the latent gaps
 * `error-payloads.ts` records in prose — unreachable from `src/` today,
 * unelided if it ever becomes reachable, and invisible here if it does.
 */
const expectNoDecodablePayload = (text: string, secret: string): void => {
  expect(text).not.toContain(secret);
  expect(text).not.toContain(Buffer.from(secret, 'utf-8').toString('base64'));
  for (const match of text.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)) {
    expect(Buffer.from(match[0], 'base64').toString('utf8')).not.toContain(
      secret,
    );
  }
};

describe('elideEncodedPayloads', () => {
  it('takes the file body out of the wire shape every builder emits', () => {
    const command = getCreateFileCommand('/srv/app/files', '.env', SECRET);

    expectNoDecodablePayload(elideEncodedPayloads(command), SECRET);
  });

  it('keeps the verbs and the paths, which are the diagnosis', () => {
    const elided = elideEncodedPayloads(
      getCreateFileCommand('/srv/app/files', 'config/app.env', SECRET),
    );

    expect(elided).toBe(
      'mkdir -p "/srv/app/files/config";\n' +
        `echo "[file body elided: ${SECRET.length} bytes]" | base64 -d > ` +
        '"/srv/app/files/config/app.env";\n',
    );
  });

  it("reports the body's decoded size, so an empty write reads differently from a 4 kB one", () => {
    const body = 'x'.repeat(4096);

    expect(
      elideEncodedPayloads(`echo "${encode(body)}" | base64 -d > /f`),
    ).toBe('echo "[file body elided: 4096 bytes]" | base64 -d > /f');
    expect(elideEncodedPayloads('echo "" | base64 -d > /f')).toBe(
      'echo "[file body elided: 0 bytes]" | base64 -d > /f',
    );
  });

  it("handles the container upload's single-quoted payload", () => {
    // `DockerOpsService.uploadFileToContainer` is the one site that single-quotes
    // its payload, so the quote is captured and matched back rather than assumed.
    const elided = elideEncodedPayloads(
      `echo '${encode(SECRET)}' | base64 -d > "/tmp/up" && docker cp "/tmp/up" "c1:/etc/app.env"`,
    );

    expect(elided).toBe(
      `echo '[file body elided: ${SECRET.length} bytes]' | base64 -d > "/tmp/up" && docker cp "/tmp/up" "c1:/etc/app.env"`,
    );
  });

  it('elides every payload in a multi-file command, not just the first', () => {
    const command =
      getCreateFileCommand('/code', '.env', SECRET) +
      getCreateFileCommand('/code', 'Dockerfile', 'FROM nginx\n');

    const elided = elideEncodedPayloads(command);
    expectNoDecodablePayload(elided, SECRET);
    expectNoDecodablePayload(elided, 'FROM nginx');
    expect(elided).toContain(`[file body elided: ${SECRET.length} bytes]`);
    expect(elided).toContain('[file body elided: 11 bytes]');
  });

  it('is idempotent, because the marker it writes is not base64', () => {
    const once = elideEncodedPayloads(
      getCreateFileCommand('/srv', '.env', SECRET),
    );

    expect(elideEncodedPayloads(once)).toBe(once);
  });

  it('takes the password out of a clone URL and leaves the user that names it', () => {
    expect(
      elideEncodedPayloads(
        'git clone --progress https://oauth2:ghs_7c2f4b91e0a63d85f1c8@github.com/o/r.git /code',
      ),
    ).toBe(
      'git clone --progress https://oauth2:[credential elided]@github.com/o/r.git /code',
    );
  });

  it("handles shell-quote's backslash-escaped form, which is what the git strategies emit", () => {
    expect(
      elideEncodedPayloads(
        'git clone https\\://oauth2\\:glpat-9f3a2b\\@gitlab.com/o/r.git',
      ),
    ).toBe(
      'git clone https\\://oauth2\\:[credential elided]\\@gitlab.com/o/r.git',
    );
  });

  it('leaves a command with no payload and no credential exactly as it was', () => {
    for (const command of [
      'docker inspect --format {{.State.Health.Status}} blog-app-9f3a2b1c',
      'echo "Applying 3 patch(es)...";',
      'curl -sfI https://s3.eu-west-1.amazonaws.com:443/bucket/key',
      'rm -rf /etc/cloudgate/schedules/blog-app',
      'git -C /code log -1 --pretty=format:"%H---DELIMITER---%B"',
    ]) {
      expect(elideEncodedPayloads(command)).toBe(command);
    }
  });
});

/**
 * The two secrets that reached the journal in clear *past* the base64 shape,
 * because they never travelled in it.
 *
 * `registry.password` goes to `docker login` on stdin — which keeps it out of
 * `docker`'s argv and out of the host's process table, and does nothing at all
 * about the command *string*, which is the thing `ExecError` captures. And
 * `sshKey.privateKey` was written `echo <key> > /tmp/cloudgate/id_rsa`, which
 * has the `echo` anchor and not the `| base64 -d` one, so the whole PEM landed
 * in six fields of a failed clone. Both columns are `encryptedText`.
 */
const REGISTRY_PASSWORD = 'ghp_4d81c0a7f6b25e93a1d7';
const KEY_BODY = 'MIIEowIBAAKCAQEA9f3a2b71c0e845d6bAAAAAAA';
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

describe('elideEncodedPayloads, on a credential piped to docker login', () => {
  it('takes the password out of the login shape a caller holding one would write', () => {
    const elided = elideEncodedPayloads(
      stdinLogin('ghcr.io', 'octabyte', REGISTRY_PASSWORD),
    );

    expect(elided).toBe(
      "printf %s '[credential elided]' | docker login 'ghcr.io' -u 'octabyte' --password-stdin",
    );
    expectNoDecodablePayload(elided, REGISTRY_PASSWORD);
  });

  it("handles docker.strategy's `if !` wrapping of the same pipeline", () => {
    const elided = elideEncodedPayloads(
      `if ! printf %s '${REGISTRY_PASSWORD}' | docker login 'registry.example.com' -u 'octabyte' --password-stdin; then\n  echo "❌ Registry login failed";\nfi`,
    );

    expect(elided).toContain(
      "if ! printf %s '[credential elided]' | docker login 'registry.example.com' -u 'octabyte' --password-stdin; then",
    );
    expectNoDecodablePayload(elided, REGISTRY_PASSWORD);
  });

  it('keeps the registry, the user and the flag — the whole diagnosis of a refused login', () => {
    const elided = elideEncodedPayloads(
      `${stdinLogin('registry.acme.dev', 'pusher', REGISTRY_PASSWORD)} || { echo "❌ Registry login failed" ; exit 1; }`,
    );

    expect(elided).toContain("docker login 'registry.acme.dev'");
    expect(elided).toContain("-u 'pusher'");
    expect(elided).toContain('--password-stdin');
    expect(elided).toContain('❌ Registry login failed');
  });

  // `shEscape` doubles a quote as `'\''`, so a password carrying one arrives as
  // three concatenated chunks and is still a single shell word.
  it('elides a password that carries a quote, a space and a separator', () => {
    const nasty = `pa'ss w$(id); touch /tmp/x #ord`;
    const elided = elideEncodedPayloads(stdinLogin('ghcr.io', 'acme', nasty));

    expect(elided).toBe(
      "printf %s '[credential elided]' | docker login 'ghcr.io' -u 'acme' --password-stdin",
    );
  });

  it('is idempotent', () => {
    const once = elideEncodedPayloads(
      stdinLogin('ghcr.io', 'acme', REGISTRY_PASSWORD),
    );

    expect(elideEncodedPayloads(once)).toBe(once);
  });

  /**
   * The stdin-login change's own assertion in this file, and the one that keeps
   * the paragraph on {@link stdinLogin} honest: the login the product actually
   * builds carries a *reference*, so the mask finds nothing and changes nothing.
   *
   * Written as `toBe(command)` rather than as `not.toContain(password)`,
   * because there is no password to name — the point is that the string is
   * already free of one before any mask runs, which is ADR 0015's first choice
   * rather than its second. A login site that went back to carrying its value
   * would red on the emitted string here as well as on its own spec.
   */
  it('has nothing to elide in the login the tree emits, which references a holder', () => {
    const command = dockerLoginCommand(
      'registry.acme.dev',
      'pusher',
      'CG_REGISTRY_PASSWORD_0',
    );

    expect(command).toBe(
      `printf %s "$CG_REGISTRY_PASSWORD_0" | docker login 'registry.acme.dev' -u 'pusher' --password-stdin`,
    );
    expect(elideEncodedPayloads(command)).toBe(command);
  });

  /**
   * The second anchor earning its place. `printf %s` on its own is an ordinary
   * verb — the backup commands use it to write a line without a newline — and
   * a pattern anchored on it alone would blank whatever it was printing.
   */
  it('leaves a printf that is not feeding a login exactly as it was', () => {
    for (const command of [
      "printf %s 'hello world' > /tmp/marker",
      "printf %s 'hello' | base64",
      "printf %s 'sha256:9f3a2b1c' | docker load",
      "printf %s 'x' | wc -c",
    ]) {
      expect(elideEncodedPayloads(command)).toBe(command);
    }
  });
});

describe('elideEncodedPayloads, on a PEM private key', () => {
  it('takes the body out of a key that reaches a command in no encoding at all', () => {
    const elided = elideEncodedPayloads(
      `echo '${PRIVATE_KEY}' > /tmp/cloudgate/id_rsa;\nchmod 600 /tmp/cloudgate/id_rsa;`,
    );

    expect(elided).toBe(
      "echo '-----BEGIN RSA PRIVATE KEY-----[private key elided]-----END RSA PRIVATE KEY-----' > /tmp/cloudgate/id_rsa;\nchmod 600 /tmp/cloudgate/id_rsa;",
    );
    expectNoDecodablePayload(elided, KEY_BODY);
  });

  it('keeps the markers, so a reader still sees that a key was written', () => {
    for (const label of [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
    ]) {
      const elided = elideEncodedPayloads(
        `-----BEGIN ${label}-----\n${KEY_BODY}\n-----END ${label}-----`,
      );

      expect(elided).toBe(
        `-----BEGIN ${label}-----[private key elided]-----END ${label}-----`,
      );
    }
  });

  it('leaves a public certificate alone — it is not a secret and it is the diagnosis', () => {
    const certificate = `-----BEGIN CERTIFICATE-----\n${KEY_BODY}\n-----END CERTIFICATE-----`;

    expect(elideEncodedPayloads(certificate)).toBe(certificate);
  });

  it('elides every key in a command that writes two', () => {
    const elided = elideEncodedPayloads(
      `echo '${PRIVATE_KEY}' > /a; echo '${PRIVATE_KEY}' > /b`,
    );

    expectNoDecodablePayload(elided, KEY_BODY);
    expect(elided.match(/\[private key elided]/g)).toHaveLength(2);
  });

  it('is idempotent, because the markers survive and the marker is not a body', () => {
    const once = elideEncodedPayloads(`echo '${PRIVATE_KEY}' > /tmp/k`);

    expect(elideEncodedPayloads(once)).toBe(once);
  });
});

describe('elideEncodedPayloads, on a long line', () => {
  // The MCP mask runs this over deployment logs, whose lines can be a
  // minified bundle or a base64 blob. An unbounded scheme in URL_CREDENTIAL
  // made one such line quadratic: 600 kB outlasted a five-minute watchdog.
  it('passes a 600 kB run of word characters through in linear time, unchanged', () => {
    const line = 'x'.repeat(600 * 1024);
    const started = Date.now();
    expect(elideEncodedPayloads(line)).toBe(line);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still elides a credential behind a scheme longer than the bound', () => {
    const scheme = `git${'x'.repeat(100)}`;
    expect(
      elideEncodedPayloads(`${scheme}://oauth2:ghs_tokenvalue123@github.com/a`),
    ).toBe(`${scheme}://oauth2:[credential elided]@github.com/a`);
  });
});

describe('elidePayloadsInError', () => {
  it('covers every field on the shared list, and one level down', () => {
    const carrying = getCreateFileCommand('/srv', '.env', SECRET);
    const original = Object.assign(new Error(`Command failed: ${carrying}`), {
      cmd: carrying,
      stdout: carrying,
      stderr: carrying,
    });
    const error = Object.assign(
      new Error(`Command execution failed: ${carrying}`),
      {
        command: carrying,
        stdout: carrying,
        stderr: carrying,
        originalError: original,
        cause: Object.assign(new Error(carrying), { command: carrying }),
      },
    );

    elidePayloadsInError(error);

    // Every string the whole graph holds, which is what pino writes.
    expectNoDecodablePayload(
      JSON.stringify(error, [
        ...REDACTED_ERROR_FIELDS,
        'originalError',
        'cause',
      ]),
      SECRET,
    );
    for (const field of REDACTED_ERROR_FIELDS) {
      const value = (error as unknown as Record<string, unknown>)[field];
      if (typeof value === 'string') expect(value).toContain('elided');
    }
  });

  it('leaves a non-object and a field that is not a string alone', () => {
    expect(elidePayloadsInError(null)).toBeNull();
    expect(elidePayloadsInError('not an error')).toBe('not an error');
    const error = Object.assign(new Error('boom'), { command: 7 });
    expect(elidePayloadsInError(error).command).toBe(7);
  });
});

describe('REDACTED_ERROR_FIELDS', () => {
  /**
   * The list is one list. `destinations/s3-credentials.ts` re-exports it so
   * the guard's test keeps enumerating the same array this file's mask walks — a
   * field added for one mask and not the other is the drift both docblocks are
   * about.
   */
  it('is the same array the S3 credential mask walks', () => {
    expect(REEXPORTED).toBe(REDACTED_ERROR_FIELDS);
  });

  it('is the six fields pino was measured to write for one failed exec', () => {
    expect([...REDACTED_ERROR_FIELDS]).toEqual([
      'message',
      'stack',
      'command',
      'cmd',
      'stdout',
      'stderr',
    ]);
  });
});
