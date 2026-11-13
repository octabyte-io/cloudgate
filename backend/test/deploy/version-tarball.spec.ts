import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `deploy/version-tarball.sh`, which builds the Cloudgate version tarball
 * publish-version.yml attaches to a release (ADR-0082), run in a scratch tree.
 *
 * What the tarball ships as it is, the install scripts and `deploy/`, is
 * copied from this repository, so the list is checked against the real files.
 * What it builds is not: `pnpm` is a shim that records how it was called and
 * leaves behind the files a real install and build would, so the test checks
 * what is packed and in what order, never that Next or Nest can build.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/version-tarball.sh');

const PTY = 'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty';
const DRIZZLE_KIT =
  'node_modules/.pnpm/drizzle-kit@0.31.10/node_modules/drizzle-kit';
const JEST = 'node_modules/.pnpm/jest@30.4.2/node_modules/jest';

let scratch: string;
let tree: string;
let out: string;
let calls: string;

function write(file: string, content = '') {
  const at = path.join(tree, file);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, content);
}

function copy(file: string) {
  fs.cpSync(path.join(repoRoot, file), path.join(tree, file), {
    recursive: true,
  });
}

/**
 * The shim. A full install brings a devDependency (jest) and drizzle-kit, a
 * production one brings drizzle-kit only, and `rebuild -r node-pty` compiles
 * pty.node. `options` takes away what a broken run would lack.
 */
function shimPnpm(
  options: { ptyCompiles?: boolean; drizzleKitIsProd?: boolean } = {},
) {
  const ptyCompiles = options.ptyCompiles ?? true;
  const drizzleKitIsProd = options.drizzleKitIsProd ?? true;
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env bash
set -e
echo "pnpm $* NODE_ENV=\${NODE_ENV:-} BACKEND_INTERNAL_ORIGIN=\${BACKEND_INTERNAL_ORIGIN:-}" >> "${calls}"
drizzle_kit() {
  mkdir -p ${DRIZZLE_KIT} backend/node_modules/.bin
  echo 'drizzle-kit' > ${DRIZZLE_KIT}/bin.cjs
  ln -sfn ../../../${DRIZZLE_KIT}/bin.cjs backend/node_modules/.bin/drizzle-kit
}
case "$*" in
  "install --frozen-lockfile")
    mkdir -p ${JEST} ${PTY}/prebuilds/darwin-arm64 frontend/node_modules
    echo 'jest' > ${JEST}/index.js
    echo 'darwin' > ${PTY}/prebuilds/darwin-arm64/pty.node
    ln -sfn ../../${PTY} frontend/node_modules/node-pty
    drizzle_kit ;;
  "install --frozen-lockfile --prod --ignore-scripts")
    [ ! -e node_modules ] && [ ! -e backend/node_modules ] && [ ! -e frontend/node_modules ] || {
      echo "a production install over the full one" >&2; exit 9; }
    mkdir -p ${PTY}/prebuilds/darwin-arm64
    echo 'darwin' > ${PTY}/prebuilds/darwin-arm64/pty.node
    ${drizzleKitIsProd ? 'drizzle_kit' : 'true'} ;;
  "rebuild -r node-pty")
    ${ptyCompiles ? `mkdir -p ${PTY}/build/Release && printf '\\177ELF' > ${PTY}/build/Release/pty.node` : 'true'} ;;
  "--filter backend build")
    mkdir -p backend/dist api-schemas/dist
    echo 'main' > backend/dist/main.js
    echo 'schemas' > api-schemas/dist/index.js ;;
  "--filter frontend build")
    mkdir -p frontend/.next/server frontend/.next/cache/webpack
    echo 'build' > frontend/.next/BUILD_ID
    echo 'page' > frontend/.next/server/page.js
    echo 'cache' > frontend/.next/cache/webpack/0.pack ;;
  *) echo "unexpected pnpm $*" >&2; exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  return bin;
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'version-tarball-'));
  tree = path.join(scratch, 'tree');
  out = path.join(scratch, 'out');
  calls = path.join(scratch, 'calls');
  fs.mkdirSync(tree);

  // Shipped as they are, from this repository.
  for (const file of [
    'LICENSE',
    'install.sh',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'deploy',
    'backend/assets',
    'backend/drizzle.config.ts',
    'frontend/server.mjs',
    'frontend/server',
    'frontend/public',
  ]) {
    copy(file);
  }
  write(
    'backend/package.json',
    JSON.stringify({ name: 'backend', version: '0.3.0' }),
  );
  write('backend/drizzle/0000_init.sql', 'CREATE TABLE x ();');
  write('backend/drizzle/meta/_journal.json', '{}');
  write('api-schemas/package.json', '{"name":"api-schemas"}');
  write('frontend/package.json', '{"name":"frontend"}');

  // Never shipped.
  write('backend/src/main.ts', 'source');
  write('backend/test/x.spec.ts', 'test');
  write('backend/.env', 'BETTER_AUTH_SECRET=from-a-working-copy');
  write('frontend/.env.local', 'CLOUDGATE_API_URL=http://localhost:4000');
  write('frontend/src/app/page.tsx', 'source');
  write('cli/package.json', '{"name":"@octabyte-io/cloudgate"}');
  write('docs/deploy.md', 'docs');
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function run(bin: string) {
  // Not jest's NODE_ENV=test: the script sets NODE_ENV where it means to.
  const env = { ...process.env };
  delete env.NODE_ENV;
  return spawnSync('bash', [script, out], {
    cwd: tree,
    env: { ...env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

const TARBALL = 'cloudgate-0.3.0-linux-amd64.tar.gz';

function listing(): string[] {
  const listed = spawnSync('tar', ['-tzf', path.join(out, TARBALL)], {
    encoding: 'utf8',
  });
  if (listed.status !== 0) throw new Error(listed.stderr);
  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
}

function unpack(): string {
  const into = path.join(scratch, 'unpacked');
  fs.mkdirSync(into);
  const unpacked = spawnSync(
    'tar',
    ['-xzf', path.join(out, TARBALL), '-C', into],
    {
      encoding: 'utf8',
    },
  );
  if (unpacked.status !== 0) throw new Error(unpacked.stderr);
  return into;
}

describe('deploy/version-tarball.sh', () => {
  it('names the tarball and its checksum after backend/package.json version', () => {
    const built = run(shimPnpm());

    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual([TARBALL, `${TARBALL}.sha256`]);
    const sha256 = createHash('sha256')
      .update(fs.readFileSync(path.join(out, TARBALL)))
      .digest('hex');
    expect(fs.readFileSync(path.join(out, `${TARBALL}.sha256`), 'utf8')).toBe(
      `${sha256}  ${TARBALL}\n`,
    );
  });

  it('holds a VERSION file and the tree /opt/cloudgate runs, at the top of the tarball', () => {
    expect(run(shimPnpm()).status).toBe(0);

    const entries = listing();
    expect(entries).toEqual(
      expect.arrayContaining([
        'VERSION',
        'LICENSE',
        'install.sh',
        'package.json',
        'pnpm-workspace.yaml',
        'pnpm-lock.yaml',
        // the built backend, its mail images and the migrations
        'api-schemas/package.json',
        'api-schemas/dist/index.js',
        'backend/package.json',
        'backend/dist/main.js',
        'backend/assets/mail/cloudgate-logo-on-dark.png',
        'backend/drizzle.config.ts',
        'backend/drizzle/0000_init.sql',
        'backend/drizzle/meta/_journal.json',
        // the built console
        'frontend/package.json',
        'frontend/server.mjs',
        'frontend/server/api-origin.mjs',
        'frontend/server/forwarded-for.mjs',
        'frontend/.next/BUILD_ID',
        'frontend/.next/server/page.js',
        // production node_modules, with what db:migrate runs
        `${PTY}/build/Release/pty.node`,
        `${DRIZZLE_KIT}/bin.cjs`,
        'backend/node_modules/.bin/drizzle-kit',
        // deploy/
        'deploy/install.sh',
        'deploy/hosted.sh',
        'deploy/hosted-update.sh',
        'deploy/hosted-backup.sh',
        'deploy/systemd/cloudgate-backend.service',
        'deploy/systemd/cloudgate-console.service',
        'deploy/traefik/traefik.yml.example',
        'deploy/opentofu/.terraform.lock.hcl',
        'deploy/opentofu/state-login.sql',
        'deploy/opentofu/versions.tf.json',
      ]),
    );
    expect(fs.readFileSync(path.join(unpack(), 'VERSION'), 'utf8')).toBe(
      '0.3.0\n',
    );
  });

  it('leaves out source, tests, env files, devDependencies, the build cache, the CLI and docs', () => {
    expect(run(shimPnpm()).status).toBe(0);

    const entries = listing();
    for (const left of [
      'backend/src',
      'backend/test',
      'backend/.env',
      'frontend/.env.local',
      'frontend/src',
      'frontend/.next/cache',
      'frontend/server/api-origin.test.mjs',
      JEST,
      'cli',
      'docs',
    ]) {
      expect(
        entries.filter(
          (entry) => entry === left || entry.startsWith(`${left}/`),
        ),
      ).toEqual([]);
    }
  });

  it('builds the console against the loopback API, then installs production node_modules afresh and compiles node-pty', () => {
    expect(run(shimPnpm()).status).toBe(0);

    expect(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)).toEqual([
      'pnpm install --frozen-lockfile NODE_ENV= BACKEND_INTERNAL_ORIGIN=',
      'pnpm --filter backend build NODE_ENV=production BACKEND_INTERNAL_ORIGIN=',
      'pnpm --filter frontend build NODE_ENV=production BACKEND_INTERNAL_ORIGIN=http://127.0.0.1:4000',
      'pnpm install --frozen-lockfile --prod --ignore-scripts NODE_ENV= BACKEND_INTERNAL_ORIGIN=',
      'pnpm rebuild -r node-pty NODE_ENV= BACKEND_INTERNAL_ORIGIN=',
    ]);
  });

  it('keeps the node_modules links relative, so the tree runs wherever it is unpacked', () => {
    expect(run(shimPnpm()).status).toBe(0);

    const link = path.join(unpack(), 'backend/node_modules/.bin/drizzle-kit');
    expect(fs.readlinkSync(link)).toBe(`../../../${DRIZZLE_KIT}/bin.cjs`);
    expect(fs.readFileSync(link, 'utf8')).toBe('drizzle-kit\n');
  });

  it('packs nothing when node-pty did not compile pty.node, even beside its darwin prebuilds', () => {
    const refused = run(shimPnpm({ ptyCompiles: false }));

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('node-pty did not compile pty.node');
    expect(fs.existsSync(path.join(out, TARBALL))).toBe(false);
  });

  it('packs nothing when production node_modules cannot run db:migrate', () => {
    const refused = run(shimPnpm({ drizzleKitIsProd: false }));

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'drizzle-kit is not in production node_modules',
    );
    expect(fs.existsSync(path.join(out, TARBALL))).toBe(false);
  });
});
