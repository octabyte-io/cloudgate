import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  scrubber,
  TofuRunner,
} from '../../src/cloud-accounts/tofu/tofu-runner';
import type { TofuRunnerOptions } from '../../src/cloud-accounts/tofu/tofu-runner';
import { stateResources } from '../../src/cloud-accounts/aws/state-resources';
import { googleStateResources } from '../../src/cloud-accounts/gcp/state-resources';
import type { TofuStateShow } from '../../src/cloud-accounts/tofu/state-show';
import {
  AWS_PROVIDER_VERSION,
  GOOGLE_PROVIDER_VERSION,
  PINNED_PROVIDERS,
  providerDirectory,
  stateEncryption,
} from '../../src/cloud-accounts/tofu/tofu-environment';
import type { PinnedProvider } from '../../src/cloud-accounts/tofu/tofu-environment';
import type {
  GoogleCredential,
  TofuApplyRequest,
  TofuCredential,
  TofuRunSignal,
} from '../../src/cloud-accounts/cloud.port';
import type { CloudRunSignal } from '../../src/deployment-queue/cloud-run-job.types';
import { TestRunSignal } from '../utils/fake-cloud-port';

/**
 * Seam 2a of the spec: the shared runner's process handling, against a
 * throwaway fake `tofu` (`fixtures/fake-tofu.sh`) that records its arguments,
 * its environment and its working folder, for both clouds' credentials. The
 * real `tofu` never runs here.
 */

const FAKE_TOFU = resolve(__dirname, 'fixtures', 'fake-tofu.sh');
const PINS = resolve(__dirname, '..', '..', '..', 'deploy', 'opentofu');

const SECRETS = {
  appEncryptionSecret: 'app-encryption-secret-0123456789abcdef',
  dbPassword: 'state-login-password-xyz',
  awsSecret: 'aws-secret-access-key-abc',
  certificateKey: 'PRIVATE-CERTIFICATE-KEY',
};
/** A Google credential configuration file's contents: a service account key. */
const GOOGLE_CREDENTIAL: GoogleCredential = {
  credentialConfiguration: JSON.stringify({
    type: 'service_account',
    project_id: 'cloudgate-spec',
    private_key: '-----BEGIN PRIVATE KEY-----\ngoogle-private-key\n',
    client_email: 'cloudgate@cloudgate-spec.iam.gserviceaccount.com',
  }),
};
const STATE_DATABASE_URL = `postgresql://cloudgate_state:${SECRETS.dbPassword}@127.0.0.1:5432/cloudgate`;

let root: string;
let record: string;
let mirror: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tofu-runner-spec-'));
  record = join(root, 'record');
  mirror = join(root, 'providers');
  mkdirSync(record);
  mkdirSync(join(root, 'work'));
  for (const [type, version] of Object.entries(PINNED_PROVIDERS)) {
    const provider = providerDirectory(mirror, type as PinnedProvider);
    mkdirSync(provider, { recursive: true });
    writeFileSync(
      join(provider, `terraform-provider-${type}_v${version}_x5`),
      '',
    );
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A `tofu` on disk that runs the fake in `mode`. */
function fakeTofu(mode: string, version = '1.13.1'): string {
  const binary = join(root, `tofu-${mode}-${version}`);
  writeFileSync(
    binary,
    `#!/bin/sh\nFAKE_TOFU_RECORD='${record}' FAKE_TOFU_MODE='${mode}' FAKE_TOFU_VERSION='${version}' exec '${FAKE_TOFU}' "$@"\n`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

function runner(
  mode: string,
  overrides: Partial<TofuRunnerOptions> = {},
): TofuRunner {
  return new TofuRunner({
    binary: fakeTofu(mode),
    providerMirror: mirror,
    stateDatabaseUrl: STATE_DATABASE_URL,
    appEncryptionSecret: SECRETS.appEncryptionSecret,
    pinsDirectory: PINS,
    workRoot: join(root, 'work'),
    ...overrides,
  });
}

function request(
  overrides: Partial<TofuApplyRequest<TofuCredential>> = {},
): TofuApplyRequest<TofuCredential> {
  return {
    stateId: 'state-1',
    credential: { accessKeyId: 'AKIAFAKE', secretAccessKey: SECRETS.awsSecret },
    definition: { resource: {} },
    variables: { default_certificate_private_key: SECRETS.certificateKey },
    ...overrides,
  };
}

/** The lock file's `provider` blocks, each as written. */
function lockBlocks(lock: string): string[] {
  return [...lock.matchAll(/^provider "[^"]+" \{\n[\s\S]*?\n\}$/gm)].map(
    (block) => block[0],
  );
}

/** The providers a run folder's pin files require and lock, by name and version. */
function pinsIn(dir: string) {
  const versions = JSON.parse(
    readFileSync(join(dir, 'versions.tf.json'), 'utf8'),
  ) as { terraform: { required_providers: unknown } };
  const lock = readFileSync(join(dir, '.terraform.lock.hcl'), 'utf8');
  return {
    required: versions.terraform.required_providers,
    locked: lockBlocks(lock).map((block) => [
      /^provider "([^"]+)"/.exec(block)?.[1],
      /^ {2}version {5}= "(.*)"$/m.exec(block)?.[1],
    ]),
  };
}

/** Every call the fake recorded, in order, `version` excluded. */
function calls() {
  const count = readdirSync(record).filter((f) => f.endsWith('.args')).length;
  return Array.from({ length: count }, (_, n) => ({
    args: readFileSync(join(record, `${n}.args`), 'utf8')
      .trim()
      .split('\n'),
    env: Object.fromEntries(
      readFileSync(join(record, `${n}.env`), 'utf8')
        .split('\0')
        .filter((line) => /^\w+=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ]),
    ),
    dir: join(record, `${n}.dir`),
    credentialMode: existsSync(join(record, `${n}.credential-mode`))
      ? readFileSync(join(record, `${n}.credential-mode`), 'utf8').trim()
      : undefined,
  })).filter((call) => call.args[0] !== 'version');
}

/** Every file's text in a recorded working folder. */
function folderText(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('TofuRunner', () => {
  describe('a plan', () => {
    it('runs init, a plan to a file and show, and returns the plan without its variables', async () => {
      const outcome = await runner('ok').plan(request());

      expect(outcome).toEqual({
        ok: true,
        show: { format_version: '1.2', resource_changes: [] },
      });
      expect(calls().map((c) => c.args)).toEqual([
        ['init', '-input=false', '-no-color', '-lockfile=readonly'],
        // The state is the workspace of its id, made on its first run.
        ['workspace', 'select', '-or-create=true', '--', 'state-1'],
        [
          'plan',
          '-input=false',
          '-no-color',
          '-lock-timeout=10s',
          '-out=cloudgate.tfplan',
        ],
        ['show', '-json', '-no-color', 'cloudgate.tfplan'],
      ]);
    });

    it('deletes its working folder when it ends', async () => {
      await runner('ok').plan(request());
      await runner('lock-held').plan(request());

      expect(readdirSync(join(root, 'work'))).toEqual([]);
    });

    it('works in a folder only the service user can open', async () => {
      await runner('ok').plan(request());

      const [init] = calls();
      const folder = init.env.HOME;
      expect(folder.startsWith(join(root, 'work'))).toBe(true);
      // The record is a copy; the mode is mkdtemp's, checked on a fresh one.
      expect(statSync(init.dir).isDirectory()).toBe(true);
      const probe = mkdtempSync(join(root, 'work', 'cloudgate-tofu-'));
      expect(statSync(probe).mode & 0o777).toBe(0o700);
    });
  });

  describe('secrets', () => {
    it('hands tofu the state login, the state key, the AWS key and variables through its environment', async () => {
      await runner('ok').plan(request());

      for (const { env } of calls()) {
        expect(env.PG_CONN_STR).toBe(STATE_DATABASE_URL);
        expect(env.TF_ENCRYPTION).toBe(
          stateEncryption(SECRETS.appEncryptionSecret),
        );
        expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAFAKE');
        expect(env.AWS_SECRET_ACCESS_KEY).toBe(SECRETS.awsSecret);
        expect(env.TF_VAR_default_certificate_private_key).toBe(
          SECRETS.certificateKey,
        );
        // The provider never falls back to the host's own AWS identity.
        expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
      }
    });

    it('never puts a secret in an argument or a file of the working folder', async () => {
      await runner('ok').apply(request());

      const passphrase = /passphrase = "([0-9a-f]+)"/.exec(
        stateEncryption(SECRETS.appEncryptionSecret),
      )![1];
      for (const call of calls()) {
        const seen = [call.args.join(' '), folderText(call.dir)].join('\n');
        for (const secret of [
          ...Object.values(SECRETS),
          passphrase,
          STATE_DATABASE_URL,
        ]) {
          expect(seen).not.toContain(secret);
        }
      }
    });

    it('passes none of the backend’s own environment', async () => {
      process.env.DATABASE_URL_FOR_SPEC = 'postgresql://cloudgate:main@x/y';
      try {
        await runner('ok').plan(request());
      } finally {
        delete process.env.DATABASE_URL_FOR_SPEC;
      }

      expect(calls()[0].env).not.toHaveProperty('DATABASE_URL_FOR_SPEC');
      expect(calls()[0].env).not.toHaveProperty('APP_ENCRYPTION_SECRET');
    });

    it('encrypts state and plan with aes_gcm, enforced, under a key from APP_ENCRYPTION_SECRET and no fallback', () => {
      const config = stateEncryption(SECRETS.appEncryptionSecret);

      expect(config).toContain('method "aes_gcm" "cloudgate"');
      expect(config).toMatch(
        /state \{\n {2}method {3}= method\.aes_gcm\.cloudgate\n {2}enforced = true\n\}/,
      );
      expect(config).toMatch(
        /plan \{\n {2}method {3}= method\.aes_gcm\.cloudgate\n {2}enforced = true\n\}/,
      );
      expect(config).not.toContain('fallback');
      expect(config).not.toContain(SECRETS.appEncryptionSecret);
      // Derived under its own label: another secret gives another key.
      expect(stateEncryption('another-secret-0123456789abcdefghij')).not.toBe(
        config,
      );
      expect(() => stateEncryption('')).toThrow(/APP_ENCRYPTION_SECRET/);
    });
  });

  describe('a Google credential', () => {
    const google = (
      overrides: Partial<TofuApplyRequest<TofuCredential>> = {},
    ) => request({ credential: GOOGLE_CREDENTIAL, ...overrides });

    it('is a credential configuration file in the run’s own folder, readable only by it, named by GOOGLE_APPLICATION_CREDENTIALS', async () => {
      await runner('ok').apply(google());

      const all = calls();
      expect(all.map((c) => c.args[0])).toContain('apply');
      for (const call of all) {
        const file = call.env.GOOGLE_APPLICATION_CREDENTIALS;
        expect(file.startsWith(`${call.env.HOME}/`)).toBe(true);
        expect(call.credentialMode).toBe('600');
        expect(
          readFileSync(
            join(call.dir, file.slice(call.env.HOME.length)),
            'utf8',
          ),
        ).toBe(GOOGLE_CREDENTIAL.credentialConfiguration);
      }
    });

    it('hands tofu no AWS key, and an AWS run no Google credential', async () => {
      await runner('ok').plan(google());
      const [googleInit] = calls();
      expect(
        Object.keys(googleInit.env).filter((name) => /^AWS_/.test(name)),
      ).toEqual([]);

      rmSync(record, { recursive: true });
      mkdirSync(record);
      await runner('ok').plan(request());
      const [awsInit] = calls();
      expect(awsInit.env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
      expect(awsInit.credentialMode).toBeUndefined();
    });

    it.each(['ok', 'lock-held', 'unreadable'])(
      'is gone once a run ends (%s)',
      async (mode) => {
        await runner(mode).apply(google());

        const [init] = calls();
        expect(existsSync(init.env.GOOGLE_APPLICATION_CREDENTIALS)).toBe(false);
        expect(readdirSync(join(root, 'work'))).toEqual([]);
      },
    );

    it('is gone once a stopped run ends', async () => {
      const signal = new TestRunSignal();
      const lines: string[] = [];
      const run = runner('hang').apply(
        google({ signal, onLine: (l) => lines.push(l) }),
      );
      await waitFor(() => lines.includes('aws_vpc.network: Creating...'));
      const [init] = calls();
      expect(existsSync(init.env.GOOGLE_APPLICATION_CREDENTIALS)).toBe(true);

      signal.interrupt();

      expect(await run).toMatchObject({ reason: 'interrupted' });
      expect(existsSync(init.env.GOOGLE_APPLICATION_CREDENTIALS)).toBe(false);
      expect(readdirSync(join(root, 'work'))).toEqual([]);
    });

    it('is written for a read of what a state holds too, and gone after it', async () => {
      await runner('ok').stateResources(
        {
          stateId: 'state-1',
          credential: GOOGLE_CREDENTIAL,
          definition: { resource: {} },
          region: 'europe-west3',
        },
        (show) => googleStateResources(show, 'europe-west3'),
      );

      const all = calls();
      expect(all.map((c) => c.args.slice(0, 2))).toContainEqual([
        'show',
        '-json',
      ]);
      for (const call of all) expect(call.credentialMode).toBe('600');
      expect(existsSync(all[0].env.GOOGLE_APPLICATION_CREDENTIALS)).toBe(false);
      expect(readdirSync(join(root, 'work'))).toEqual([]);
    });
  });

  describe('providers', () => {
    it('loads providers only from the mirror, with the pinned lock file', async () => {
      await runner('ok').plan(request());

      const [init] = calls();
      const cliConfig = readFileSync(
        join(init.dir, init.env.TF_CLI_CONFIG_FILE.split('/').pop()!),
        'utf8',
      );
      expect(cliConfig).toContain('filesystem_mirror');
      expect(cliConfig).toContain(`path = "${mirror}"`);
      expect(cliConfig).not.toContain('direct');
      expect(pinsIn(init.dir)).toEqual({
        required: {
          aws: {
            source: 'registry.opentofu.org/hashicorp/aws',
            version: AWS_PROVIDER_VERSION,
          },
        },
        locked: [['registry.opentofu.org/hashicorp/aws', AWS_PROVIDER_VERSION]],
      });
      // The AWS pin as the lock file has it, checksums and all.
      expect(
        lockBlocks(readFileSync(join(init.dir, '.terraform.lock.hcl'), 'utf8')),
      ).toEqual(
        lockBlocks(
          readFileSync(join(PINS, '.terraform.lock.hcl'), 'utf8'),
        ).filter((block) =>
          block.startsWith('provider "registry.opentofu.org/hashicorp/aws"'),
        ),
      );
    });

    // A run requires only its own cloud's providers: `tofu init`
    // installs every provider `versions.tf.json` names, and a plan lists
    // every one of them in its configuration.
    it("gives a Google run the Google provider's pin, and no AWS one", async () => {
      await runner('ok').plan(request({ credential: GOOGLE_CREDENTIAL }));

      const [init] = calls();
      expect(pinsIn(init.dir)).toEqual({
        required: {
          google: {
            source: 'registry.opentofu.org/hashicorp/google',
            version: GOOGLE_PROVIDER_VERSION,
          },
        },
        locked: [
          ['registry.opentofu.org/hashicorp/google', GOOGLE_PROVIDER_VERSION],
        ],
      });
    });

    it('fails a Google run before running anything when the Google provider is missing from the mirror, naming it', async () => {
      rmSync(providerDirectory(mirror, 'google'), { recursive: true });

      const outcome = await runner('ok').apply(
        request({ credential: GOOGLE_CREDENTIAL }),
      );

      expect(outcome).toEqual({
        ok: false,
        reason: 'install-mismatch',
        message: `The Google provider ${GOOGLE_PROVIDER_VERSION} is not in the provider mirror ${mirror}. Re-run install.sh.`,
      });
      expect(calls()).toEqual([]);
    });

    it("names the Google provider's pin when init finds no provider the lock allows on a Google run", async () => {
      const outcome = await runner('no-provider').plan(
        request({ credential: GOOGLE_CREDENTIAL }),
      );

      expect(outcome).toEqual({
        ok: false,
        reason: 'install-mismatch',
        message: `The installed Google provider is not the ${GOOGLE_PROVIDER_VERSION} this Cloudgate pins (Failed to query available provider packages). Re-run install.sh.`,
      });
    });

    it('runs an AWS run with no Google provider in the mirror', async () => {
      rmSync(providerDirectory(mirror, 'google'), { recursive: true });

      expect((await runner('ok').plan(request())).ok).toBe(true);
    });

    it('fails before running anything when the provider is missing from the mirror, naming the version and install.sh', async () => {
      rmSync(providerDirectory(mirror, 'aws'), { recursive: true });

      const outcome = await runner('ok').apply(request());

      expect(outcome).toEqual({
        ok: false,
        reason: 'install-mismatch',
        message: expect.stringMatching(
          new RegExp(
            `AWS provider ${AWS_PROVIDER_VERSION}.*Re-run install\\.sh`,
          ),
        ) as string,
      });
      expect(calls()).toEqual([]);
    });

    it('fails before running anything when the installed OpenTofu is not the pin', async () => {
      const outcome = await runner('ok', {
        binary: fakeTofu('ok', '1.12.0'),
      }).apply(request());

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'install-mismatch',
        message: expect.stringMatching(
          /OpenTofu is 1\.12\.0.*1\.13\.1.*install\.sh/,
        ) as string,
      });
      expect(calls()).toEqual([]);
    });

    it('fails before running anything when OpenTofu is not installed', async () => {
      const outcome = await runner('ok', { binary: undefined }).plan(request());

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'install-mismatch',
        message: expect.stringContaining('Re-run install.sh') as string,
      });
    });
  });

  describe('failures', () => {
    it('fails when the lock is still held after its wait, saying another run is using the state', async () => {
      const outcome = await runner('lock-held').apply(request());

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'lock-held',
        message: expect.stringMatching(
          /another run is using this state/i,
        ) as string,
        failedAt: 'plan',
      });
      expect(calls().map((c) => c.args[0])).toEqual([
        'init',
        'workspace',
        'plan',
      ]);
    });

    it("fails in its own words, not as another run on this state, when OpenTofu's shared creation lock outlasts the wait", async () => {
      const outcome = await runner('creation-locked').apply(request());

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'state-backend-busy',
        message: expect.stringContaining('state-1') as string,
      });
      expect(outcome).not.toMatchObject({
        message: expect.stringMatching(/another run/i) as string,
      });
      expect(calls().map((c) => c.args[0])).toEqual([
        'init',
        'workspace',
        'plan',
      ]);
    });

    it("makes the state's workspace again when OpenTofu's shared creation lock was taken, then plans", async () => {
      const outcome = await runner('creating-once', {
        creationLockRetryDelayMs: 10,
      }).plan(request());

      expect(outcome).toMatchObject({ ok: true });
      expect(calls().map((c) => c.args[0])).toEqual([
        'init',
        'workspace',
        'workspace',
        'plan',
        'show',
      ]);
    });

    it('fails in its own words, not as another run on this state, when making the workspace keeps finding the creation lock taken', async () => {
      const outcome = await runner('creating-always', {
        creationLockRetryDelayMs: 10,
      }).apply(request());

      expect(outcome).toEqual({
        ok: false,
        reason: 'state-backend-busy',
        message: expect.stringContaining('state-1') as string,
      });
      expect(outcome).not.toMatchObject({
        message: expect.stringMatching(/another run/i) as string,
      });
      expect(calls().map((c) => c.args[0])).toEqual([
        'init',
        'workspace',
        'workspace',
        'workspace',
      ]);
    });

    it.each([2, 3])(
      "lets %i runs on different states make their workspaces at once without one finding OpenTofu's shared creation lock taken",
      async (runs) => {
        const tofu = runner('creating-shared', {
          creationLockRetryDelayMs: 10,
        });

        const outcomes = await Promise.all(
          Array.from({ length: runs }, (_, n) =>
            tofu.plan(request({ stateId: `state-${n + 1}` })),
          ),
        );

        expect(outcomes.map((outcome) => outcome.ok)).toEqual(
          Array.from({ length: runs }, () => true),
        );
        // Each made its workspace at the first try.
        expect(
          readFileSync(join(record, 'workspace-calls'), 'utf8')
            .trim()
            .split('\n')
            .sort(),
        ).toEqual(
          Array.from(
            { length: runs },
            (_, n) => `workspace select -or-create=true -- state-${n + 1}`,
          ),
        );
      },
    );

    it('fails an unreadable state, naming it, and applies nothing', async () => {
      const outcome = await runner('unreadable').apply(request());

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'unreadable-state',
        message: expect.stringContaining('state-1') as string,
      });
      expect(calls().map((c) => c.args[0])).toEqual([
        'init',
        'workspace',
        'plan',
      ]);
    });
  });

  describe('values in what it prints', () => {
    it('shows a variable value as (sensitive) in every streamed line and in its failure', async () => {
      const value = 'hunter2-very-secret';
      const lines: string[] = [];

      const outcome = await runner('leaky').apply(
        request({
          variables: { variable_value_API_KEY: value },
          onLine: (line) => lines.push(line),
        }),
      );

      expect(lines).toContain('  ~ value = (sensitive)');
      expect(lines).toContain('  provider said: (sensitive)');
      expect(outcome).toEqual({
        ok: false,
        reason: 'failed',
        message: 'ValidationException: value (sensitive) is invalid',
        failedAt: 'apply',
      });
      expect(lines.join('\n')).not.toContain(value);
    });

    it("leaves a value too short to tell from ordinary words to OpenTofu's own mask", () => {
      const scrub = scrubber(['on', 'line one\nsecond-line-of-a-pem']);
      expect(scrub('turned on: second-line-of-a-pem')).toBe(
        'turned on: (sensitive)',
      );
    });
  });

  describe('apply and destroy', () => {
    it('streams each line, applies the saved plan and returns the outputs', async () => {
      const lines: string[] = [];

      const outcome = await runner('ok').apply(
        request({ onLine: (line) => lines.push(line) }),
      );

      expect(outcome).toEqual({
        ok: true,
        show: { format_version: '1.2', resource_changes: [] },
        outputs: { vpc_id: 'vpc-1' },
      });
      expect(lines).toEqual([
        'Initializing the backend...',
        'OpenTofu has been successfully initialized!',
        'Plan: 1 to add, 0 to change, 0 to destroy.',
        'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.',
      ]);
      expect(calls().find((c) => c.args[0] === 'apply')?.args).toEqual([
        'apply',
        '-input=false',
        '-no-color',
        '-lock-timeout=10s',
        'cloudgate.tfplan',
      ]);
    });

    it('stops before applying when beforeApply refuses the plan', async () => {
      const outcome = await runner('ok').apply(
        request({
          beforeApply: () => ({
            ok: false,
            reason: 'failed',
            message: 'The plan is not the one approved.',
          }),
        }),
      );

      expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
      expect(calls().map((c) => c.args[0])).not.toContain('apply');
    });

    it('destroys through a destroy plan', async () => {
      await runner('ok').destroy(request());

      expect(calls().find((c) => c.args[0] === 'plan')?.args).toContain(
        '-destroy',
      );
      expect(calls().map((c) => c.args[0])).toContain('apply');
    });

    it('limits the plan to the targets asked, and applies that plan', async () => {
      await runner('ok').apply(
        request({
          targets: [
            'aws_ecr_repository.service',
            'aws_ecr_lifecycle_policy.service',
          ],
        }),
      );

      expect(calls().find((c) => c.args[0] === 'plan')?.args).toEqual([
        'plan',
        '-input=false',
        '-no-color',
        '-lock-timeout=10s',
        '-out=cloudgate.tfplan',
        '-target=aws_ecr_repository.service',
        '-target=aws_ecr_lifecycle_policy.service',
      ]);
      expect(calls().find((c) => c.args[0] === 'apply')?.args).toEqual([
        'apply',
        '-input=false',
        '-no-color',
        '-lock-timeout=10s',
        'cloudgate.tfplan',
      ]);
    });

    it('plans anew the addresses asked to be replaced, and applies that plan', async () => {
      await runner('ok').apply(
        request({ replaces: ['aws_instance.stack_vm'] }),
      );

      expect(calls().find((c) => c.args[0] === 'plan')?.args).toEqual([
        'plan',
        '-input=false',
        '-no-color',
        '-lock-timeout=10s',
        '-out=cloudgate.tfplan',
        '-replace=aws_instance.stack_vm',
      ]);
      expect(calls().find((c) => c.args[0] === 'apply')?.args).toContain(
        'cloudgate.tfplan',
      );
    });
  });

  describe('a read back AWS refuses before a new resource’s tags reach its permissions', () => {
    const quick = { tagRetryDelayMs: 10 };
    const commands = () =>
      calls()
        .map((c) => c.args[0])
        .filter((command) => command !== 'init' && command !== 'workspace');
    const FIRST_SHOW = {
      format_version: '1.2',
      resource_changes: [
        { address: 'aws_vpc.network', change: { actions: ['create'] } },
        {
          address: 'aws_codebuild_project.build',
          change: { actions: ['create'] },
        },
      ],
    };

    it('says why, waits, lifts the taint, then plans and applies once more, streaming both attempts', async () => {
      const lines: string[] = [];

      const outcome = await runner('tag-race', quick).apply(
        request({ onLine: (line) => lines.push(line) }),
      );

      expect(outcome).toEqual({
        ok: true,
        show: FIRST_SHOW,
        outputs: { vpc_id: 'vpc-1' },
      });
      expect(commands()).toEqual([
        'plan',
        'show',
        'apply',
        'show',
        'untaint',
        'plan',
        'show',
        'apply',
        'output',
      ]);
      expect(calls().find((c) => c.args[0] === 'untaint')?.args).toEqual([
        'untaint',
        '-lock-timeout=10s',
        '--',
        'aws_codebuild_project.build',
      ]);
      const retrying = lines.indexOf(
        "AWS had not yet applied the new CodeBuild Project's tags to its permissions, so reading it back was refused; planning and applying again in 1 second",
      );
      expect(retrying).toBeGreaterThan(
        lines.indexOf('aws_codebuild_project.build: Creating...'),
      );
      expect(lines.slice(retrying + 1)).toEqual([
        'Resource instance aws_codebuild_project.build has been successfully untainted.',
        'Plan: 1 to add, 0 to change, 0 to destroy.',
        'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.',
      ]);
    });

    it('asks beforeApply once, of the plan the Apply approved, and a refusal still applies nothing', async () => {
      const seen: unknown[] = [];
      await runner('tag-race', quick).apply(
        request({
          beforeApply: (show) => {
            seen.push(show);
            return null;
          },
        }),
      );
      expect(seen).toEqual([FIRST_SHOW]);

      rmSync(record, { recursive: true });
      mkdirSync(record);
      const refused = await runner('tag-race', quick).apply(
        request({
          beforeApply: () => ({
            ok: false,
            reason: 'failed',
            message: 'The plan is not the one approved.',
          }),
        }),
      );
      expect(refused).toMatchObject({
        message: 'The plan is not the one approved.',
      });
      expect(commands()).not.toContain('apply');
    });

    it('applies nothing more when the plan made again would change what the applied plan did not', async () => {
      const lines: string[] = [];

      const outcome = await runner('tag-race-grows', quick).apply(
        request({ onLine: (line) => lines.push(line) }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'failed',
        message: expect.stringMatching(
          /^reading CodeBuild Project .*AccessDeniedException/,
        ) as string,
      });
      expect(commands().filter((c) => c === 'apply')).toHaveLength(1);
      expect(lines).toContain(
        'The plan made again would also create aws_iam_role.extra, which the plan being applied did not, so it was not applied',
      );
    });

    it('tries once more only: a second refusal fails the run as the first would have', async () => {
      const outcome = await runner('tag-race-twice', quick).apply(request());

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'failed',
        message: expect.stringMatching(
          /^reading CodeBuild Project .*AccessDeniedException/,
        ) as string,
      });
      expect(commands().filter((c) => c === 'apply')).toHaveLength(2);
    });

    it.each([
      ['a resource the apply did not create', 'tag-race-unmade'],
      ['another error beside it', 'tag-race-mixed'],
    ])(
      'fails at once, as before, for a refused read of %s',
      async (_case, mode) => {
        const lines: string[] = [];

        const outcome = await runner(mode, quick).apply(
          request({ onLine: (line) => lines.push(line) }),
        );

        expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
        expect(commands()).toEqual(['plan', 'show', 'apply']);
        expect(lines.some((line) => line.startsWith('AWS had not'))).toBe(
          false,
        );
      },
    );

    it('leaves a Google run as it was', async () => {
      const outcome = await runner('tag-race', quick).apply(
        request({ credential: GOOGLE_CREDENTIAL }),
      );

      expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
      expect(commands()).toEqual(['plan', 'show', 'apply']);
    });

    it('ends during the wait when the run is interrupted, planning nothing more', async () => {
      const signal = new TestRunSignal();
      const lines: string[] = [];
      const started = Date.now();
      const run = runner('tag-race', { tagRetryDelayMs: 60_000 }).apply(
        request({ signal, onLine: (line) => lines.push(line) }),
      );
      await waitFor(() => lines.some((line) => line.startsWith('AWS had not')));

      signal.interrupt();

      expect(await run).toMatchObject({ ok: false, reason: 'interrupted' });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(commands()).toEqual(['plan', 'show', 'apply']);
    });
  });

  describe('forgetting instances before the plan', () => {
    const forget = (
      keep: string[],
      seen: unknown[][],
      before?: () => Promise<void>,
    ) => ({
      resource: 'aws_acm_certificate.domain',
      keep,
      before: async (found: unknown[]) => {
        seen.push(found);
        await before?.();
      },
    });

    it('tells the caller of each instance the definition no longer keys, takes it out of the state, then plans', async () => {
      const seen: unknown[][] = [];

      const outcome = await runner('certificates').apply(
        request({ forget: forget(['dom_1-2'], seen) }),
      );

      expect(outcome.ok).toBe(true);
      expect(seen).toEqual([
        [
          {
            address: 'aws_acm_certificate.domain["dom_1-1"]',
            arn: 'arn:aws:acm:us-east-1:123456789012:certificate/0b5f3c1e-old',
            region: 'us-east-1',
            domainName: 'docs.example.com',
          },
        ],
      ]);
      expect(calls().map((c) => c.args)).toEqual([
        ['init', '-input=false', '-no-color', '-lockfile=readonly'],
        ['workspace', 'select', '-or-create=true', '--', 'state-1'],
        ['show', '-json', '-no-color'],
        [
          'state',
          'rm',
          '-lock-timeout=10s',
          '--',
          'aws_acm_certificate.domain["dom_1-1"]',
        ],
        [
          'plan',
          '-input=false',
          '-no-color',
          '-lock-timeout=10s',
          '-out=cloudgate.tfplan',
        ],
        ['show', '-json', '-no-color', 'cloudgate.tfplan'],
        [
          'apply',
          '-input=false',
          '-no-color',
          '-lock-timeout=10s',
          'cloudgate.tfplan',
        ],
        ['output', '-json', '-no-color'],
      ]);
    });

    it('removes nothing from the state when every instance is kept', async () => {
      const seen: unknown[][] = [];

      await runner('certificates').apply(
        request({ forget: forget(['dom_1-1', 'dom_1-2'], seen) }),
      );

      expect(seen).toEqual([]);
      expect(calls().map((c) => c.args[0])).not.toContain('state');
    });

    it('changes nothing when the caller cannot record what it would forget', async () => {
      const seen: unknown[][] = [];

      const outcome = await runner('certificates').apply(
        request({
          forget: forget([], seen, () =>
            Promise.reject(new Error('the database is gone')),
          ),
        }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'failed',
        message: expect.stringContaining('the database is gone') as unknown,
      });
      // Before the plan: nothing asked the cloud, so nothing it refused.
      expect(outcome).not.toHaveProperty('failedAt');
      expect(calls().map((c) => c.args[0])).toEqual([
        'init',
        'workspace',
        'show',
      ]);
    });
  });

  describe('ending a run from outside', () => {
    it('interrupts tofu once, and it stops', async () => {
      const signal = new TestRunSignal();
      const lines: string[] = [];
      const run = runner('hang').apply(
        request({ signal, onLine: (l) => lines.push(l) }),
      );
      // Printed once its interrupt handling is in place, as tofu's would be.
      await waitFor(() => lines.includes('aws_vpc.network: Creating...'));

      signal.interrupt();

      expect(await run).toMatchObject({
        ok: false,
        reason: 'interrupted',
        message: expect.stringContaining('saved the state') as string,
      });
      expect(readFileSync(join(record, 'interrupted'), 'utf8')).toBe(
        'stopped\n',
      );
    });

    it('kills tofu and its provider on the kill that follows, when they have not stopped', async () => {
      const signal = new TestRunSignal();
      const run = runner('stubborn').apply(request({ signal }));
      await waitFor(() => existsSync(join(record, 'provider.pid')));
      const provider = Number(
        readFileSync(join(record, 'provider.pid'), 'utf8'),
      );
      const tofu = Number(readFileSync(join(record, 'tofu.pid'), 'utf8'));

      signal.interrupt();
      await waitFor(() => existsSync(join(record, 'interrupted')));
      // One interrupt, and nothing more until the kill.
      await new Promise((r) => setTimeout(r, 200));
      expect(alive(tofu)).toBe(true);
      expect(alive(provider)).toBe(true);

      signal.kill();

      expect(await run).toMatchObject({
        ok: false,
        reason: 'interrupted',
        message: expect.stringContaining('killed') as string,
      });
      await waitFor(() => !alive(provider) && !alive(tofu));
    });

    it("takes the Cloud run pool's own signal", () => {
      // A compile-time check: the pool's control hands this straight in.
      const fromPool = (signal: CloudRunSignal): TofuRunSignal => signal;
      expect(fromPool(new TestRunSignal())).toBeInstanceOf(TestRunSignal);
    });

    it('does not start tofu at all once interrupted', async () => {
      const signal = new TestRunSignal();
      signal.interrupt();

      const outcome = await runner('ok').plan(request({ signal }));

      expect(outcome).toMatchObject({ reason: 'interrupted' });
      expect(calls()).toEqual([]);
    });
  });

  describe('a read of what a state holds', () => {
    const read = () => ({
      stateId: 'state-1',
      credential: {
        accessKeyId: 'AKIAFAKE',
        secretAccessKey: SECRETS.awsSecret,
      },
      definition: { resource: {} },
      region: 'eu-central-1',
    });
    const awsProjection = (show: TofuStateShow) =>
      stateResources(show, 'eu-central-1');

    it('runs init, lists the workspaces, selects the state and shows it, taking no lock and planning nothing', async () => {
      const outcome = await runner('ok').stateResources(read(), awsProjection);

      expect(calls().map((c) => c.args)).toEqual([
        ['init', '-input=false', '-no-color', '-lockfile=readonly'],
        ['workspace', 'list'],
        ['workspace', 'select', '--', 'state-1'],
        ['show', '-json', '-no-color'],
      ]);
      expect(outcome).toMatchObject({ ok: true });
      const resources = outcome.ok ? outcome.resources : [];
      expect(resources.map((one) => one.type)).toContain('aws_iam_role');
      // Only the projection leaves: no value of the state does.
      expect(JSON.stringify(outcome)).not.toContain('PARAMETER-SECRET-VALUE');
      expect(JSON.stringify(outcome)).not.toContain('OUTPUT-SECRET-VALUE');
    });

    it('lists nothing for a state no run has made, and never makes its workspace', async () => {
      const outcome = await runner('no-workspace').stateResources(
        read(),
        awsProjection,
      );

      expect(outcome).toEqual({ ok: true, resources: [] });
      expect(calls().map((c) => c.args.slice(0, 2))).toEqual([
        ['init', '-input=false'],
        ['workspace', 'list'],
      ]);
    });

    it('fails an unreadable state, naming it', async () => {
      const outcome = await runner('unreadable').stateResources(
        read(),
        awsProjection,
      );

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'unreadable-state',
        message: expect.stringContaining('state-1') as string,
      });
    });

    it('leaves no working folder behind', async () => {
      await runner('ok').stateResources(read(), awsProjection);

      expect(readdirSync(join(root, 'work'))).toEqual([]);
    });
  });

  describe('shutdown', () => {
    it('waits for a running tofu to finish, and sends it nothing', async () => {
      const tofu = runner('slow');
      let finished = false;
      const run = tofu.apply(request()).then((outcome) => {
        finished = true;
        return outcome;
      });
      await waitFor(() => calls().some((c) => c.args[0] === 'apply'));

      await tofu.whenIdle();

      expect(finished).toBe(true);
      expect(await run).toMatchObject({ ok: true });
      expect(existsSync(join(record, 'interrupted'))).toBe(false);
    });

    it('resolves at once with nothing running', async () => {
      await expect(runner('ok').whenIdle()).resolves.toBeUndefined();
    });
  });
});
