import { ExecError } from '../../src/remote/exec-error';
import {
  getS3CredentialsEnv,
  RCLONE_INVOCATION_ENV,
  redactS3Credentials,
  redactS3CredentialsInError,
  MIN_MASKED_CREDENTIAL_LENGTH,
  REDACTED_ERROR_FIELDS,
} from '../../src/destinations/s3-credentials';
import type { Destination } from '../../src/db/schema';

// The credential set every rclone invocation against a destination is built
// from. It travels in the environment and never as `--s3-*` flags, so
// the environment form below is the only form, and the masking helpers are
// the second layer behind it.
const r2Destination: Destination = {
  destinationId: 'dest-1',
  name: 'prod-backups',
  provider: 'Cloudflare',
  accessKey: 'AKIAEXAMPLEACCESSKEY',
  secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
  bucket: 'cloudgate-backups',
  region: 'auto',
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  createdAt: '2026-07-23T00:00:00.000Z',
  organizationId: 'org-1',
};

describe('getS3CredentialsEnv', () => {
  // Expected names come from rclone's documented flag-to-variable rule
  // (RCLONE_ + the flag in upper snake case), not from the implementation.
  it('builds rclone’s own environment variables for the destination', () => {
    expect(getS3CredentialsEnv(r2Destination)).toEqual({
      RCLONE_S3_PROVIDER: 'Cloudflare',
      RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
      RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
      RCLONE_S3_REGION: 'auto',
      RCLONE_S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
      RCLONE_S3_NO_CHECK_BUCKET: 'true',
      RCLONE_S3_FORCE_PATH_STYLE: 'true',
      // rclone's own default for every provider, read off
      // `--s3-encoding`'s help line — `(default Slash,InvalidUtf8,Dot)` on
      // rclone v1.75.0 — rather than off the source under test. The reach it
      // closes is asserted where it lives, in `test/destinations/rclone-exec`'s
      // `an rclone variable the operator put in the backend's environment`:
      // this line alone would pass whether or not the value ever won against
      // `process.env`.
      RCLONE_S3_ENCODING: 'Slash,InvalidUtf8,Dot',
    });
  });

  it('omits the provider variable when the destination has no provider', () => {
    const env = getS3CredentialsEnv({ ...r2Destination, provider: null });
    expect(env).not.toHaveProperty('RCLONE_S3_PROVIDER');
    expect(env.RCLONE_S3_ACCESS_KEY_ID).toBe('AKIAEXAMPLEACCESSKEY');
    // …and the encoder is not conditional with it, which is the whole point:
    // a Destination with no provider is the shape most exposed to an inherited
    // environment, so it is the one that must still carry the pin.
    expect(env.RCLONE_S3_ENCODING).toBe('Slash,InvalidUtf8,Dot');
  });

  it('carries no value that a caller could paste into a command line', () => {
    // Not a tautology: the point of the shape is that a caller holds names and
    // values apart, so it cannot join them into argv the way the flag list was.
    for (const value of Object.values(getS3CredentialsEnv(r2Destination))) {
      expect(value).not.toContain('--s3-');
    }
  });
});

// The backend is a systemd unit, so `JOURNAL_STREAM` is in its
// environment and `{ ...process.env, ...env }` handed it to every rclone it
// spawned. rclone concluded it was writing to the journal and framed every line
// with a syslog priority — `<5>NOTICE: Config file … not found`, `<3>ERROR : …`
// — and `rcloneFailureMessage` answers a 400 with that stderr verbatim, so the
// first line of every failed backup, restore and listing was decoration.
describe('RCLONE_INVOCATION_ENV', () => {
  it('blanks what makes rclone frame its output for the journal', () => {
    // Pinned by name rather than by count, for the same reason
    // `REDACTED_ERROR_FIELDS` is: each entry is here because of a specific
    // observed line, and dropping one is a silent regression.
    expect(RCLONE_INVOCATION_ENV).toEqual({
      JOURNAL_STREAM: '',
      RCLONE_LOG_SYSTEMD: 'false',
      RCLONE_CONFIG: '/dev/null',
    });
  });

  it('is a sibling of the credential set, not an extension of it', () => {
    // The two are kept apart on purpose — one is about where secrets travel and
    // the other is spawn hygiene — and this is the assertion that says so: no
    // key of either appears in the other, so a merge would fail here rather
    // than quietly make each docblock's reasoning apply to the other's entries.
    const credentials = Object.keys(getS3CredentialsEnv(r2Destination));
    for (const key of Object.keys(RCLONE_INVOCATION_ENV)) {
      expect(credentials).not.toContain(key);
    }
    expect(credentials).toContain('RCLONE_S3_ACCESS_KEY_ID');
  });
});

describe('redactS3Credentials', () => {
  it('masks a secret access key named as an environment assignment', () => {
    expect(
      redactS3Credentials(
        'RCLONE_S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI-example-secret-key rclone ls',
        r2Destination,
      ),
    ).toBe('RCLONE_S3_SECRET_ACCESS_KEY=•••••• rclone ls');
  });

  it('masks a secret access key named as an rclone flag', () => {
    expect(
      redactS3Credentials(
        'rclone ls --s3-secret-access-key="wJalrXUtnFEMI-example-secret-key" :s3:b',
        r2Destination,
      ),
    ).toBe('rclone ls --s3-secret-access-key=•••••• :s3:b');
  });

  it('masks a bare credential value nothing in the text named', () => {
    const out = redactS3Credentials(
      'SignatureDoesNotMatch for AKIAEXAMPLEACCESSKEY / wJalrXUtnFEMI-example-secret-key',
      r2Destination,
    );
    expect(out).not.toContain('AKIAEXAMPLEACCESSKEY');
    expect(out).not.toContain('wJalrXUtnFEMI-example-secret-key');
    // The diagnosis is why the message is shown at all, so it survives.
    expect(out).toContain('SignatureDoesNotMatch');
  });

  it('leaves a credential under six characters alone', () => {
    expect(
      redactS3Credentials('bucket at auto', {
        accessKey: 'auto',
        secretAccessKey: 'x',
      }),
    ).toBe('bucket at auto');
  });

  it('masks a credential of exactly the shortest masked length', () => {
    // The threshold `rclone-exec.ts`'s argv guard refuses on, pinned so
    // the two cannot drift: a value this mask hides must be one the guard stops,
    // and a value it leaves alone must be one the guard lets through.
    const value = 'a'.repeat(MIN_MASKED_CREDENTIAL_LENGTH);
    expect(
      redactS3Credentials(`403 for ${value}`, {
        accessKey: '',
        secretAccessKey: value,
      }),
    ).toBe('403 for ••••••');
  });
});

// F-41 read the mask's absence from 6 918 journal lines as proof it
// could not fire on any live route. The absence was real and the conclusion was
// not: an earlier fix moved the credentials into rclone's environment so nothing *this
// tree builds* echoes one, but `REDACTED_ERROR_FIELDS` also covers `stderr`,
// and rclone writes into it a string built from a field the API accepts freely.
//
// **Not the provider's error body, which was this comment's first answer and is
// not a shape that exists.** rclone's S3 backend keeps `Code` and
// `Message` from an error body and discards the remainder before it formats
// anything — measured against a stub returning AWS's exact XML,
// `<AWSAccessKeyId>` included, which `curl` confirmed was on the wire and which
// rclone never printed. No S3 provider can put a credential into rclone's
// output that way.
//
// What rclone does always echo is **the URL it dialled**, and `Destination`'s
// `endpoint` is a free string. An operator pasting credentials into it —
// `https://<key>:<secret>@minio.example.test` — is a real mistake, and Go's
// `url.Redacted()` hides the password and keeps the username, so the access key
// reaches `stderr` in clear and the secret does not. That path is now driven on
// two live routes (`backups.e2e-spec.ts`, `volume-backups.e2e-spec.ts`), which
// assert the marker is *present* rather than only that the key is absent.
//
// This block stays the exhaustive one: every field the list names, driven off
// the list itself, which is what those two route tests cannot do.
describe('redactS3CredentialsInError', () => {
  it('masks every field of the list, whatever the list is', () => {
    const secret = r2Destination.secretAccessKey;
    const error = Object.assign(new Error(`boom ${secret}`), {
      ...Object.fromEntries(
        REDACTED_ERROR_FIELDS.map((field) => [field, `carrying ${secret}`]),
      ),
      // Not in the list, and deliberately: the mask reads a fixed set of string
      // fields rather than walking the object, so pinning what it leaves alone
      // is what says the list is the whole guarantee. Anything new that pino
      // writes has to be added to the list *and* to this test.
      syscall: `spawn ${secret}`,
    });

    redactS3CredentialsInError(error, r2Destination);

    for (const field of REDACTED_ERROR_FIELDS) {
      const value = (error as unknown as Record<string, string>)[field];
      expect(value).not.toContain(secret);
      expect(value).toContain('••••••');
    }
    expect((error as unknown as { syscall: string }).syscall).toContain(secret);
  });

  it('masks the fields pino’s error serializer writes, by name', () => {
    // Pinned by name rather than by count: each of these was found the hard way
    // — `stack` and `command` first, `cmd` after the journal still held the
    // command one field over under Node's own spelling — and dropping one is a
    // leak. `stderr` is the one a live route reaches, so dropping *that*
    // one leaks a provider's echo of the key on every failed restore.
    expect([...REDACTED_ERROR_FIELDS]).toEqual([
      'message',
      'stack',
      'command',
      'cmd',
      'stdout',
      'stderr',
    ]);
  });

  it('masks the credentials in every field of an ExecError the logger writes', () => {
    // pino's error serializer writes the stack and every own property, so a
    // masked `message` beside a raw `command` would be no fix at all.
    const raw = new Error(
      'Command failed: rclone lsf RCLONE_S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI-example-secret-key',
    );
    const error = new ExecError(
      'Command execution failed: rclone failed for AKIAEXAMPLEACCESSKEY',
      {
        command:
          'rclone lsf --s3-secret-access-key="wJalrXUtnFEMI-example-secret-key" :s3:b',
        stdout: 'key wJalrXUtnFEMI-example-secret-key',
        stderr: 'AKIAEXAMPLEACCESSKEY rejected',
        exitCode: 1,
        originalError: raw,
      },
    );

    redactS3CredentialsInError(error, r2Destination);

    for (const text of [
      error.message,
      error.stack ?? '',
      error.command,
      error.stdout ?? '',
      error.stderr ?? '',
      raw.message,
      raw.stack ?? '',
    ]) {
      expect(text).not.toContain('wJalrXUtnFEMI-example-secret-key');
      expect(text).not.toContain('AKIAEXAMPLEACCESSKEY');
    }
  });

  it('returns the same error, so the status code the route answers with is unchanged', () => {
    // Another fix owns what these failures answer with; masking must not decide it.
    const error = new ExecError('boom', { command: 'rclone ls' });
    const out = redactS3CredentialsInError(error, r2Destination);
    expect(out).toBe(error);
    expect(out.exitCode).toBeUndefined();
  });

  it('passes a non-object rejection through untouched', () => {
    expect(redactS3CredentialsInError('boom', r2Destination)).toBe('boom');
    expect(
      redactS3CredentialsInError(undefined, r2Destination),
    ).toBeUndefined();
  });
});
