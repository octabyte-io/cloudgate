import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  AWS_PROVIDER_VERSION,
  GOOGLE_PROVIDER_VERSION,
  OPENTOFU_VERSION,
  opentofuCliConfig,
  PINNED_PROVIDERS,
} from '../../src/cloud-accounts/tofu/tofu-environment';
import {
  COMPOSE_PLUGIN_VERSION,
  DOCKER_ENGINE_VERSION,
  UBUNTU_IMAGES,
} from '../../src/cloud-accounts/definitions/stack-vm-pins';

/**
 * Each checkout pins exactly one OpenTofu and one version of each provider
 * (ADR-0030): `hashicorp/aws`, and `hashicorp/google` (the Google Cloud spec,
 * S14b), the only Google one since the beta provider was dropped.
 * Each pin is written in four places — `deploy/install.sh`, the committed
 * lock file, `versions.tf.json` and the backend's constants — and these
 * tests are what keep each one pin.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const installer = () => read('deploy/install.sh');
const lockFile = () => read('deploy/opentofu/.terraform.lock.hcl');

/** An assignment from install.sh's inputs, with any `${X:-default}` unwrapped. */
function installDefault(name: string): string {
  const line = installer().match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
  if (line === undefined) throw new Error(`install.sh assigns no ${name}`);
  const fallback = line.match(/^"\$\{\w+:-(.*)\}"$/);
  return fallback ? fallback[1] : line;
}

/** The providers the lock file pins, in its order. */
const LOCKED = ['aws', 'google'] as const;

/** The lock file's block for one provider, from the OpenTofu registry. */
function locked(provider: (typeof LOCKED)[number]) {
  const blocks = [
    ...lockFile().matchAll(/^provider "([^"]+)" \{\n([\s\S]*?)\n\}/gm),
  ];
  expect(blocks.map((b) => b[1])).toEqual(
    LOCKED.map((p) => `registry.opentofu.org/hashicorp/${p}`),
  );
  const body = blocks[LOCKED.indexOf(provider)][2];
  return {
    version: body.match(/^ {2}version {5}= "(.*)"$/m)?.[1],
    hashes: [...body.matchAll(/^ {4}"((?:h1|zh):[^"]+)",$/gm)].map((h) => h[1]),
  };
}

const atLeast = (version: string, floor: string) =>
  version.localeCompare(floor, 'en', { numeric: true }) >= 0;

describe('deploy/opentofu/.terraform.lock.hcl', () => {
  it('install.sh installs the provider versions the lock file pins', () => {
    expect(installDefault('AWS_PROVIDER_VERSION')).toBe(locked('aws').version);
    expect(installDefault('GOOGLE_PROVIDER_VERSION')).toBe(
      locked('google').version,
    );
  });

  it.each(LOCKED)('the lock file carries checksums for %s', (provider) => {
    const { hashes } = locked(provider);
    // `zh:` is each platform's zip sha256 — what install.sh checks a download
    // against; `h1:` is what `tofu init` checks the unpacked directory against.
    expect(hashes.some((h) => h.startsWith('zh:'))).toBe(true);
    expect(hashes.some((h) => h.startsWith('h1:'))).toBe(true);
    for (const h of hashes.filter((h) => h.startsWith('zh:'))) {
      expect(h).toMatch(/^zh:[0-9a-f]{64}$/);
    }
  });

  it('install.sh checks each provider zip against the lock file', () => {
    expect(installer()).toContain('deploy/opentofu/.terraform.lock.hcl');
    expect(installer()).toContain('zh:${sum}');
    for (const provider of LOCKED) {
      expect(installer()).toMatch(
        new RegExp(
          `^install_provider ${provider} "\\$\\{\\w+_PROVIDER_VERSION\\}"$`,
          'm',
        ),
      );
    }
  });

  it('versions.tf.json requires exactly the locked providers', () => {
    const versions = JSON.parse(read('deploy/opentofu/versions.tf.json')) as {
      terraform: { required_providers: unknown };
    };
    expect(versions.terraform.required_providers).toEqual(
      Object.fromEntries(
        LOCKED.map((provider) => [
          provider,
          {
            source: `registry.opentofu.org/hashicorp/${provider}`,
            version: locked(provider).version,
          },
        ]),
      ),
    );
  });

  it('pins OpenTofu 1.10 or later, with a checksum', () => {
    expect(atLeast(installDefault('OPENTOFU_VERSION'), '1.10.0')).toBe(true);
    expect(atLeast('1.9.9', '1.10.0')).toBe(false);
    expect(installDefault('OPENTOFU_SHA256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the backend names the versions install.sh installs', () => {
    expect(OPENTOFU_VERSION).toBe(installDefault('OPENTOFU_VERSION'));
    expect(AWS_PROVIDER_VERSION).toBe(installDefault('AWS_PROVIDER_VERSION'));
    expect(GOOGLE_PROVIDER_VERSION).toBe(
      installDefault('GOOGLE_PROVIDER_VERSION'),
    );
  });

  it('the backend pins each provider the lock file does, at its version', () => {
    expect(PINNED_PROVIDERS).toEqual(
      Object.fromEntries(LOCKED.map((p) => [p, locked(p).version])),
    );
  });

  it('writes the pins into the backend env file, as TRAEFIK_VERSION is', () => {
    const env = installer().match(
      /cat > \/etc\/default\/cloudgate-backend <<EOF\n([\s\S]*?)\nEOF\n/,
    )?.[1];
    for (const name of [
      'OPENTOFU_VERSION',
      'OPENTOFU_BINARY',
      'OPENTOFU_PROVIDER_MIRROR',
      'AWS_PROVIDER_VERSION',
      'GOOGLE_PROVIDER_VERSION',
    ]) {
      expect(env).toContain(`\n${name}=\${${name}}\n`);
    }
  });

  it('the example env file shows the same pins', () => {
    const example = read('deploy/env/cloudgate-backend.example');
    for (const name of [
      'OPENTOFU_VERSION',
      'AWS_PROVIDER_VERSION',
      'GOOGLE_PROVIDER_VERSION',
    ]) {
      expect(example).toContain(`\n${name}=${installDefault(name)}\n`);
    }
  });

  // ADR-0030: never Terraform's binary. The only release fetched is OpenTofu's.
  it('downloads OpenTofu, never Terraform', () => {
    expect(installer()).toContain(
      'https://github.com/opentofu/opentofu/releases/download/',
    );
    expect(installer()).not.toMatch(/releases\.hashicorp\.com|\bterraform_\d/);
  });

  it('refuses a host that is not amd64', () => {
    expect(installer()).toContain('if [ "$(uname -m)" != x86_64 ]; then');
  });
});

/**
 * The committed provider schemas every native block is checked against
 * (ADR-0044 rule 5): each is of the provider the lock file pins, at
 * the pinned version. Moving a pin without `pnpm opentofu:schemas` fails
 * here, so a plan never checks against a stale schema.
 */
describe('deploy/opentofu/schemas/', () => {
  const committed = (provider: (typeof LOCKED)[number]) =>
    JSON.parse(read(`deploy/opentofu/schemas/${provider}.json`)) as {
      provider: string;
      version: string;
      format_version: string;
    };

  it('holds one schema per locked provider, and the ECS container’s fields', () => {
    expect(
      fs.readdirSync(path.join(repoRoot, 'deploy/opentofu/schemas')).sort(),
    ).toEqual(
      [
        ...LOCKED.map((p) => `${p}.json`),
        'ecs-container-definition.json',
      ].sort(),
    );
  });

  it.each(LOCKED)(
    'holds the schema of %s at the version the lock file pins',
    (provider) => {
      const schema = committed(provider);

      expect(schema.provider).toBe(
        `registry.opentofu.org/hashicorp/${provider}`,
      );
      expect(schema.version).toBe(locked(provider).version);
      expect(schema.format_version).toBe('1.0');
    },
  );
});

/**
 * `hashicorp/google` 8.8.0 makes every Google resource Cloudgate writes, the
 * Memorystore instance included, so the beta Google provider was dropped
 * from the pins and from everything that named it at once (ADR-0030 as
 * amended). Nothing tracked may name it again: not a pin, a definition, a
 * script, a workflow, a test or a doc. Only `docs/adr/` keeps it, as the
 * record of why it was there and why it went. The needle is built from parts
 * so this file does not match itself.
 */
describe('deploy/opentofu/', () => {
  const NEEDLE = ['google', 'beta'].join('-');

  /** Every tracked file outside `docs/adr/` that names the beta provider. */
  let found: { file: string; text: string }[] | undefined;
  function naming(): { file: string; text: string }[] {
    if (found) return found;
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((file) => file && !file.startsWith('docs/adr/'))
      .filter((file) => fs.existsSync(path.join(repoRoot, file)));
    // A census over nothing passes for the wrong reason.
    expect(tracked).toContain('deploy/opentofu/versions.tf.json');
    found = tracked.flatMap((file) => {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      return text.includes(NEEDLE) ? [{ file, text }] : [];
    });
    return found;
  }

  it('no tracked file outside docs/adr/ names the beta Google provider', () => {
    expect(naming().map(({ file }) => file)).toEqual([]);
  });
});

describe('opentofuCliConfig', () => {
  it('installs providers from the mirror only, never directly', () => {
    const config = opentofuCliConfig(
      '/usr/local/share/cloudgate/opentofu/providers',
    );

    expect(config).toBe(
      [
        'provider_installation {',
        '  filesystem_mirror {',
        '    path = "/usr/local/share/cloudgate/opentofu/providers"',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(config).not.toContain('direct');
  });

  // The CLI config is HCL 1, where `${` and `%{` are plain text: doubling them,
  // as an HCL 2 definition would, names a directory that does not exist. Checked
  // against `tofu init` 1.13.1 with a mirror at a path holding all three.
  it('quotes the path, and leaves template-looking text as it is', () => {
    expect(opentofuCliConfig('/srv/a "b"\\${c}%{d}')).toContain(
      'path = "/srv/a \\"b\\"\\\\${c}%{d}"',
    );
  });

  it('refuses a relative mirror path', () => {
    expect(() => opentofuCliConfig('providers')).toThrow(/absolute/);
  });
});

describe('deploy/opentofu/state-login.sql', () => {
  it('install.sh creates it, with a password of its own kept with the other secrets', () => {
    expect(installer()).toContain('STATEPW="$(read_secret STATEPW)"');
    expect(installer()).toContain(
      "CREATE ROLE cloudgate_state LOGIN PASSWORD '${STATEPW}'",
    );
  });

  it('install.sh grants it from the file the migration test runs, after the migrations, on every run', () => {
    const script = installer();
    const migrate = script.indexOf('node_modules/.bin/drizzle-kit migrate');
    const grant = script.indexOf('deploy/opentofu/state-login.sql');
    expect(migrate).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(migrate);
  });

  it('writes its URL into the backend env file, and the example shows it', () => {
    expect(installer()).toContain(
      '\nINFRASTRUCTURE_STATE_DATABASE_URL=postgresql://cloudgate_state:${STATEPW}@127.0.0.1:5432/cloudgate\n',
    );
    expect(read('deploy/env/cloudgate-backend.example')).toContain(
      '\nINFRASTRUCTURE_STATE_DATABASE_URL=postgresql://cloudgate_state:',
    );
  });

  it('is granted only the states table and its sequence, in its own schema', () => {
    const grants = read('deploy/opentofu/state-login.sql')
      .split('\n')
      .filter((line) => line && !line.startsWith('--'));
    expect(grants).toEqual([
      'GRANT CONNECT ON DATABASE cloudgate TO cloudgate_state;',
      'GRANT USAGE ON SCHEMA infrastructure_state TO cloudgate_state;',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON infrastructure_state.states TO cloudgate_state;',
      'GRANT USAGE ON SEQUENCE infrastructure_state.global_states_id_seq TO cloudgate_state;',
    ]);
  });
});

/**
 * What a Stack VM is made from (ADR-0070): each cloud's Ubuntu 24.04
 * image, and the Docker Engine and compose plugin its first boot installs,
 * pinned beside the OpenTofu pins. A pin that moves is a "replace VM" line.
 */
describe('deploy/opentofu/stack-vm.json', () => {
  const pins = () =>
    JSON.parse(read('deploy/opentofu/stack-vm.json')) as Record<string, string>;

  it('pins exactly the Ubuntu image of each cloud and the Docker Engine and compose plugin a Stack VM installs', () => {
    expect(Object.keys(pins()).sort()).toEqual([
      'compose_plugin',
      'docker_engine',
      'ubuntu_aws',
      'ubuntu_gcp',
    ]);
  });

  it('the backend names the versions it pins', () => {
    expect(DOCKER_ENGINE_VERSION).toBe(pins().docker_engine);
    expect(COMPOSE_PLUGIN_VERSION).toBe(pins().compose_plugin);
    expect(UBUNTU_IMAGES.aws).toBe(pins().ubuntu_aws);
    expect(UBUNTU_IMAGES.gcp).toBe(pins().ubuntu_gcp);
  });

  it("each image is one exact build of Canonical's Ubuntu 24.04 LTS for x86, never a family's latest", () => {
    expect(pins().ubuntu_aws).toMatch(
      /^ubuntu\/images\/hvm-ssd-gp3\/ubuntu-noble-24\.04-amd64-server-\d{8}$/,
    );
    expect(pins().ubuntu_gcp).toMatch(/^ubuntu-2404-noble-amd64-v\d{8}$/);
  });

  it("each is an exact apt version of Docker's Ubuntu 24.04 repository", () => {
    expect(pins().docker_engine).toMatch(
      /^5:\d+\.\d+\.\d+-1~ubuntu\.24\.04~noble$/,
    );
    expect(pins().compose_plugin).toMatch(
      /^\d+\.\d+\.\d+-1~ubuntu\.24\.04~noble$/,
    );
  });
});
