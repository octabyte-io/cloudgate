import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

/**
 * `deploy/version-publish.sh`, the last step of publish-version.yml: it puts
 * the Cloudgate version's two tarballs, linux-amd64 and linux-arm64, and their
 * checksums on the tag's GitHub Release, all four or none (ADR-0088).
 * `gh` is a shim that answers `release view` as the test says GitHub would and
 * records every other call, so nothing reaches GitHub.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/version-publish.sh');

const TARBALL = 'cloudgate-0.3.0-linux-amd64.tar.gz';
const CHECKSUM = `${TARBALL}.sha256`;
const ARM64_TARBALL = 'cloudgate-0.3.0-linux-arm64.tar.gz';
const ARM64_CHECKSUM = `${ARM64_TARBALL}.sha256`;
const FILES = [TARBALL, CHECKSUM, ARM64_TARBALL, ARM64_CHECKSUM];

let scratch: string;
let tree: string;
let dist: string;
let calls: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'version-publish-'));
  tree = path.join(scratch, 'tree');
  dist = path.join(scratch, 'dist');
  calls = path.join(scratch, 'calls');
  fs.mkdirSync(tree);
  fs.mkdirSync(dist);
  for (const tarball of [TARBALL, ARM64_TARBALL]) {
    fs.writeFileSync(path.join(dist, tarball), 'tarball');
    fs.writeFileSync(path.join(dist, `${tarball}.sha256`), `abc  ${tarball}\n`);
  }
  fs.writeFileSync(
    path.join(tree, 'CHANGELOG.md'),
    `# Changelog

## Unreleased

### Not this

## 0.3.0 (2026-11-20)

### Install a Cloudgate version

**What to do on upgrade**: nothing.

## 0.2.0

### Older
`,
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * `view` is what `gh release view v0.3.0 --json assets` does: the names of the
 * release's assets, no release at all, or a failure to ask.
 */
function run(view: { assets: string[] } | 'not found' | 'unreachable') {
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const answer =
    view === 'not found'
      ? `echo "release not found" >&2; exit 1`
      : view === 'unreachable'
        ? `echo "HTTP 502: Bad Gateway" >&2; exit 1`
        : view.assets.map((name) => `echo '${name}'`).join('\n') || 'true';
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
if [ "$1 $2" = "release view" ]; then
${answer}
  exit 0
fi
echo "gh $*" >> "${calls}"
for arg in "$@"; do
  case "$arg" in --notes-file) notes=1 ;; *) [ -n "\${notes:-}" ] && cp "$arg" "${scratch}/notes" && notes= ;; esac
done
exit 0
`,
    { mode: 0o755 },
  );
  return spawnSync('bash', [script, 'v0.3.0', dist], {
    cwd: tree,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

function called(): string[] {
  return fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    : [];
}

describe('deploy/version-publish.sh', () => {
  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('creates the release for the tag with both tarballs and their checksums, its notes the version CHANGELOG section', () => {
    const published = run('not found');

    expect(published.stderr).toBe('');
    expect(published.status).toBe(0);
    const [create, ...rest] = called();
    expect(rest).toEqual([]);
    expect(create.replace(/--notes-file \S+$/, '--notes-file <notes>')).toBe(
      `gh release create v0.3.0 ${FILES.map((file) => `${dist}/${file}`).join(' ')} --verify-tag --title Cloudgate 0.3.0 --notes-file <notes>`,
    );
    const notes = fs.readFileSync(path.join(scratch, 'notes'), 'utf8');
    expect(notes).toContain('### Install a Cloudgate version');
    expect(notes).not.toContain('Not this');
    expect(notes).not.toContain('Older');
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('adds all four files to a release made by hand that has none of them', () => {
    const published = run({ assets: ['notes.pdf'] });

    expect(published.status).toBe(0);
    expect(called()).toEqual([
      `gh release upload v0.3.0 ${FILES.map((file) => `${dist}/${file}`).join(' ')}`,
    ]);
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('leaves a release that already has all four files as it is', () => {
    const rerun = run({ assets: FILES });

    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain(
      'v0.3.0 already has its tarballs and checksums',
    );
    expect(called()).toEqual([]);
  });

  it.each(FILES.map((file) => [file]))(
    // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
    'replaces nothing on a release that holds only %s',
    (held) => {
      const refused = run({ assets: [held] });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`v0.3.0 already holds ${held}`);
      expect(called()).toEqual([]);
    },
  );

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('replaces nothing on a release that holds only the amd64 tarball and checksum', () => {
    const refused = run({ assets: [TARBALL, CHECKSUM] });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('but not all four files');
    expect(called()).toEqual([]);
  });

  it.each(FILES.map((file) => [file]))(
    'publishes nothing when %s was not built',
    (missing) => {
      fs.rmSync(path.join(dist, missing));
      const refused = run('not found');

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`${dist}/${missing} is not there`);
      expect(refused.stderr).toContain('nothing was published');
      expect(called()).toEqual([]);
    },
  );

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('publishes nothing when GitHub cannot say whether the release exists', () => {
    const refused = run('unreachable');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('HTTP 502');
    expect(called()).toEqual([]);
  });
});

/**
 * `.github/workflows/publish-version.yml` itself: a tarball is built natively
 * on each CPU on Ubuntu 24.04, and each is booted by the smoke check on 24.04
 * and 26.04, the two releases the install accepts (ADR-0085, ADR-0088),
 * before anything is published.
 */
describe('.github/workflows/publish-version.yml', () => {
  interface Job {
    'runs-on': string;
    container?: string;
    needs?: string | string[];
    if?: string;
    strategy?: {
      'fail-fast'?: boolean;
      matrix?: { include?: Record<string, string>[] };
    };
  }

  function jobs(): Record<string, Job> {
    const workflow = parse(
      fs.readFileSync(
        path.join(repoRoot, '.github/workflows/publish-version.yml'),
        'utf8',
      ),
      { logLevel: 'error' },
    ) as { jobs: Record<string, Job> };
    return workflow.jobs;
  }

  /** A job's matrix entries. */
  function include(job: Job): Record<string, string>[] {
    const entries = job.strategy?.matrix?.include;
    if (!Array.isArray(entries)) throw new Error('no matrix.include');
    return entries;
  }

  it('builds a tarball on each CPU, natively, on Ubuntu 24.04', () => {
    const build = jobs().build;

    expect(build['runs-on']).toBe('${{ matrix.runner }}');
    expect(
      include(build).map(({ cpu, runner }) => `${cpu} ${runner}`),
    ).toEqual(['amd64 ubuntu-24.04', 'arm64 ubuntu-24.04-arm']);
  });

  it('boots each tarball on Ubuntu 24.04 and 26.04, the arm64 26.04 one in a 26.04 container on the Arm runner', () => {
    const smoke = jobs().smoke;

    expect(smoke['runs-on']).toBe('${{ matrix.runner }}');
    expect(smoke.container).toBe("${{ matrix.container || '' }}");
    expect(
      include(smoke)
        .map(
          ({ cpu, release, runner, container }) =>
            `${cpu} ${release} ${runner} ${container ?? '-'}`,
        )
        .sort(),
    ).toEqual([
      'amd64 24.04 ubuntu-24.04 -',
      'amd64 26.04 ubuntu-26.04 -',
      'arm64 24.04 ubuntu-24.04-arm -',
      'arm64 26.04 ubuntu-24.04-arm ubuntu:26.04',
    ]);
  });

  it('publishes only once the smoke check has passed on all four', () => {
    const publish = jobs().publish;

    expect([publish.needs].flat()).toContain('smoke');
    // An `if:` such as always() would publish past a failed smoke run.
    expect(publish.if).toBeUndefined();
  });
});
