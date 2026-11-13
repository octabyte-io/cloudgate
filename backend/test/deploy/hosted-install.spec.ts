import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkInstanceModeBoot } from '../../src/instance-mode/instance-mode';

/**
 * `deploy/install.sh`'s hosted path, driven as far as a test can take
 * it off a real box: the script itself up to its first change to the host, and
 * `deploy/hosted.sh`'s functions, which it sources.
 *
 * Every run of install.sh here has `id` shimmed to answer a non-root uid, so a
 * script that got past the input check would stop at "must run as root" rather
 * than touch this machine.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const installer = path.join(repoRoot, 'deploy/install.sh');
const library = path.join(repoRoot, 'deploy/hosted.sh');

/** Every input a hosted install takes, with a value that passes. */
const INPUTS: Record<string, string> = {
  CLOUDGATE_HOSTNAME: 'cloudgate.octabyte.app',
  SITE_URL: 'https://cloudgate.octabyte.app',
  STRIPE_SECRET_KEY: 'sk_live_cloudgate',
  STRIPE_WEBHOOK_SECRET: 'whsec_cloudgate',
  STARTER_PLAN_PRICE_ID: 'price_starter_plan',
  BUSINESS_PLAN_PRICE_ID: 'price_business_plan',
  ADD_ON_PRICE_ID: 'price_add_on',
  MAIL_FROM_ADDRESS: 'Cloudgate <hello@cloudgate.octabyte.app>',
  RESEND_API_KEY: 're_cloudgate',
  TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
  INSTANCE_OWNER_EMAIL: 'ops@octabyte.app',
  INSTANCE_OWNER_FIRST_NAME: 'Ada',
  INSTANCE_ORGANIZATION_NAME: 'Octabyte',
  BACKUP_B2_KEY_ID: '0051a2b3c4d5e6f0000000001',
  BACKUP_B2_APPLICATION_KEY: 'K005cloudgatebackupkey',
  BACKUP_B2_BUCKET: 'octabyte-cloudgate-backups',
  BACKUP_B2_FOLDER: 'live',
  BACKUP_AGE_RECIPIENT:
    'age197feh04jwuq47j0j0jd2fj606jw9947pecg993n53s85s4nzf36s90cs0w',
  BACKUP_ALERT_EMAIL: 'ops@octabyte.app',
};

let scratch: string;
let shimPath: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-install-'));
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 1000\n', {
    mode: 0o755,
  });
  shimPath = `${bin}:${process.env.PATH}`;
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A clean environment: nothing of this machine's leaks into the run. */
function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: shimPath, HOME: scratch, ...extra };
}

function install(extra: Record<string, string>) {
  return spawnSync('bash', [installer], {
    env: baseEnv({ CLOUDGATE_PUBLIC_HOST: '203.0.113.10', ...extra }),
    encoding: 'utf8',
  });
}

/** Sources hosted.sh, points it at a scratch inputs file, runs `script`. */
function withLibrary(
  script: string,
  extra: Record<string, string> = {},
  inputsFile = path.join(scratch, 'cloudgate-hosted'),
) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail; . "$1"; HOSTED_INPUTS_FILE="$2"; ${script}`,
      'bash',
      library,
      inputsFile,
    ],
    { env: baseEnv(extra), encoding: 'utf8' },
  );
}

/** The refusal's list: the `  - ` lines, each one's first word. */
function named(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('  - '))
    .map((line) => line.slice(4).split(' ')[0]);
}

describe('deploy/install.sh', () => {
  it('refuses before touching the box while every input is missing, naming them all', () => {
    if (fs.existsSync('/etc/default/cloudgate-hosted')) return; // a real Hosted box
    const run = install({ HOSTED_MODE: 'true' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'HOSTED_MODE=true, but the hosted install cannot continue without:',
    );
    expect(named(run.stderr)).toEqual(Object.keys(INPUTS));
    expect(run.stderr).not.toContain('must run as root');
    expect(run.stdout).not.toContain('==>');
  });

  it('names only what is missing', () => {
    if (fs.existsSync('/etc/default/cloudgate-hosted')) return;
    const { STRIPE_WEBHOOK_SECRET, TURNSTILE_SECRET_KEY, ...given } = INPUTS;
    void STRIPE_WEBHOOK_SECRET;
    void TURNSTILE_SECRET_KEY;

    const run = install({ HOSTED_MODE: 'true', ...given });

    expect(run.status).toBe(1);
    expect(named(run.stderr)).toEqual([
      'STRIPE_WEBHOOK_SECRET',
      'TURNSTILE_SECRET_KEY',
    ]);
  });

  it('goes on to the install proper once every input is given', () => {
    if (fs.existsSync('/etc/default/cloudgate-hosted')) return;
    const run = install({ HOSTED_MODE: 'true', ...INPUTS });

    // The next check is the root one, which the shim fails on purpose.
    expect(run.stderr).not.toContain('cannot continue without');
    expect(run.stderr).toContain('must run as root');
  });

  it('refuses a HOSTED_MODE that is neither true nor false', () => {
    const run = install({ HOSTED_MODE: 'yes' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('HOSTED_MODE must be "true" or "false"');
  });

  it.each<Record<string, string>>([
    {},
    { HOSTED_MODE: 'false' },
    { HOSTED_MODE: '' },
  ])('is the Self-hosted install, asking nothing hosted, with %j', (extra) => {
    if (fs.existsSync('/etc/default/cloudgate-hosted')) return;
    const run = install(extra);

    expect(run.stderr).not.toContain('cannot continue without');
    expect(run.stderr).toContain('must run as root');
  });
});

describe('deploy/hosted.sh', () => {
  it.each([
    [
      { CLOUDGATE_HOSTNAME: 'Cloudgate.Octabyte.App' },
      'CLOUDGATE_HOSTNAME must be a lower-case hostname',
    ],
    [
      { CLOUDGATE_HOSTNAME: 'host`) || Host(`x' },
      'CLOUDGATE_HOSTNAME must be a lower-case hostname',
    ],
    [
      { SITE_URL: 'http://cloudgate.octabyte.app' },
      'SITE_URL must be an https:// address',
    ],
    [
      { STRIPE_SECRET_KEY: "sk_'$(reboot)" },
      'STRIPE_SECRET_KEY must not contain a single quote',
    ],
    [
      { BACKUP_B2_FOLDER: 'live/../staging' },
      'BACKUP_B2_FOLDER must be one lower-case folder name',
    ],
    [{ BACKUP_B2_BUCKET: 'b2' }, 'BACKUP_B2_BUCKET must be a B2 bucket name'],
    [
      {
        BACKUP_AGE_RECIPIENT:
          'AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQY',
      },
      'BACKUP_AGE_RECIPIENT must be an age public key (age1…), never the identity',
    ],
    [
      { BACKUP_ALERT_EMAIL: 'ops@octabyte.app, cto@octabyte.app' },
      'BACKUP_ALERT_EMAIL must be one email address',
    ],
  ])('refuses %j', (bad, message) => {
    const run = withLibrary('hosted_require_inputs', { ...INPUTS, ...bad });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
  });

  it('accepts a complete set of inputs', () => {
    const run = withLibrary('hosted_require_inputs', INPUTS);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('lets a re-run name nothing: the first run’s inputs are kept and reused', () => {
    const file = path.join(scratch, 'kept-inputs');
    const first = withLibrary('hosted_save_inputs', INPUTS, file);
    expect(first.status).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const rerun = withLibrary(
      'hosted_load_inputs; hosted_require_inputs; echo "$MAIL_FROM_ADDRESS|$STRIPE_SECRET_KEY"',
      { STRIPE_SECRET_KEY: 'sk_live_rotated' },
      file,
    );

    expect(rerun.stderr).toBe('');
    expect(rerun.status).toBe(0);
    // What the environment names wins over what was kept.
    expect(rerun.stdout.trim()).toBe(
      'Cloudgate <hello@cloudgate.octabyte.app>|sk_live_rotated',
    );
  });

  /**
   * The census that ties the installer to the boot check: the lines the hosted
   * install appends to the backend's environment file, read back the way
   * install.sh reads that file (`set -a; .`), are a configuration the hosted
   * boot check starts. A setting the check gains and the installer does not
   * write fails here rather than on the box, with a backend that will not boot.
   */
  it('writes a backend environment the hosted boot check starts', () => {
    const run = withLibrary(
      [
        'hosted_backend_env http://172.18.0.1:3000 > "$HOME/backend-env"',
        'env -i bash -c \'set -a; . "$1"; set +a; env -0\' bash "$HOME/backend-env"',
      ].join('; '),
      INPUTS,
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const env = Object.fromEntries(
      run.stdout
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf('=');
          return [entry.slice(0, at), entry.slice(at + 1)];
        }),
    );

    expect(checkInstanceModeBoot(env)).toBe('hosted');
    expect(env.HOSTED_MODE).toBe('true');
    expect(env.MAIL_FROM_ADDRESS).toBe(INPUTS.MAIL_FROM_ADDRESS);
    expect(env.CLOUDGATE_CONSOLE_URL).toBe('http://172.18.0.1:3000');
    // The installer's own inputs stay out of the backend's file.
    expect(env.INSTANCE_OWNER_EMAIL).toBeUndefined();
    // So do the backup's: the backend never holds the B2 key.
    expect(
      Object.keys(env).filter((name) => name.startsWith('BACKUP_')),
    ).toEqual([]);
  });

  /**
   * The box's public address, install.sh's own input, reaches the backend on
   * the Hosted instance: on a cloud VM behind NAT it is on no interface, and
   * a Server address naming it must be refused as the box's own (ADR-0053).
   */
  it('hands the backend the public address install.sh was given', () => {
    const run = withLibrary(
      'hosted_require_inputs; hosted_backend_env http://172.18.0.1:3000',
      { ...INPUTS, CLOUDGATE_PUBLIC_HOST: '203.0.113.10' },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CLOUDGATE_PUBLIC_HOST='203.0.113.10'");
  });

  /**
   * The provider settings of Bought Servers are optional (ADR-0071): an
   * install without them writes none, which boots a Hosted instance that
   * offers no Buy a Server, and one with them hands them to the backend.
   */
  it('writes the Bought Server settings only when they are given', () => {
    const backendEnv = (extra: Record<string, string>) =>
      withLibrary(
        'hosted_require_inputs; hosted_backend_env http://172.18.0.1:3000',
        {
          ...INPUTS,
          ...extra,
        },
      );

    const without = backendEnv({});
    expect(without.status).toBe(0);
    expect(without.stdout).not.toMatch(/HETZNER_|BOUGHT_SERVER_/);

    const given = backendEnv({
      HETZNER_EUR_API_TOKEN: 'eur-token',
      HETZNER_USD_API_TOKEN: 'usd-token',
      BOUGHT_SERVER_REVERSE_DNS_DOMAIN: 'servers.octabyte.app',
    });
    expect(given.status).toBe(0);
    expect(given.stdout).toContain("HETZNER_EUR_API_TOKEN='eur-token'");
    expect(given.stdout).toContain("HETZNER_USD_API_TOKEN='usd-token'");
    expect(given.stdout).toContain(
      "BOUGHT_SERVER_REVERSE_DNS_DOMAIN='servers.octabyte.app'",
    );
  });

  /**
   * Docker makes docker_gwbridge only when a container first joins an overlay
   * network, never at `swarm init`, so a fresh box has none when install.sh
   * asks for Traefik's way to the console. The stub answers like that daemon:
   * `inspect` fails until the bridge exists, and `create` makes it.
   */
  describe('hosted_docker_gwbridge', () => {
    let docker: string;
    let state: string;

    beforeEach(() => {
      docker = fs.mkdtempSync(path.join(scratch, 'docker-'));
      state = path.join(docker, 'state');
      fs.mkdirSync(state);
      fs.writeFileSync(
        path.join(docker, 'docker'),
        `#!/usr/bin/env bash
echo "docker $*" >> "${state}/calls"
if [ "$1 $2" = "network inspect" ] && [ "$3" = docker_gwbridge ]; then
  if [ ! -e "${state}/gwbridge" ]; then
    echo "Error response from daemon: network docker_gwbridge not found" >&2
    exit 1
  fi
  case "$5" in
    *Gateway*) echo 172.18.0.1 ;;
    *Subnet*) echo 172.18.0.0/16 ;;
  esac
  exit 0
fi
if [ "$1 $2" = "network create" ] && [ "\${@: -1}" = docker_gwbridge ]; then
  touch "${state}/gwbridge"
  exit 0
fi
echo "docker stub: $*" >&2
exit 2
`,
        { mode: 0o755 },
      );
    });

    function gwbridge() {
      return spawnSync(
        'bash',
        [
          '-c',
          'set -euo pipefail; . "$1"; hosted_docker_gwbridge; echo "$DOCKER_HOST_GATEWAY $DOCKER_GWBRIDGE_SUBNET"',
          'bash',
          library,
        ],
        {
          env: { PATH: `${docker}:${process.env.PATH}`, HOME: scratch },
          encoding: 'utf8',
        },
      );
    }

    it("finds Traefik's way to the console on a fresh swarm, before any container joined an overlay", () => {
      const found = gwbridge();

      expect(found.stderr).toBe('');
      expect(found.status).toBe(0);
      expect(found.stdout.trim()).toBe('172.18.0.1 172.18.0.0/16');
    });

    it('leaves a docker_gwbridge that already exists as it is', () => {
      fs.writeFileSync(path.join(state, 'gwbridge'), '');

      const found = gwbridge();

      expect(found.status).toBe(0);
      expect(found.stdout.trim()).toBe('172.18.0.1 172.18.0.0/16');
      expect(fs.readFileSync(path.join(state, 'calls'), 'utf8')).not.toContain(
        'network create',
      );
    });
  });
});
