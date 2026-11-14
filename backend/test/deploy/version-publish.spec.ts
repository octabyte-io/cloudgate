import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

/**
 * `deploy/version-publish.sh`, the last step of publish-version.yml: it puts
 * the Cloudgate version tarball and its checksum on the tag's GitHub Release.
 * `gh` is a shim that answers `release view` as the test says GitHub would and
 * records every other call, so nothing reaches GitHub.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/version-publish.sh');

const TARBALL = 'cloudgate-0.3.0-linux-amd64.tar.gz';
const CHECKSUM = `${TARBALL}.sha256`;

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
  fs.writeFileSync(path.join(dist, TARBALL), 'tarball');
  fs.writeFileSync(path.join(dist, CHECKSUM), `abc  ${TARBALL}\n`);
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
  it('creates the release for the tag with the tarball and its checksum, its notes the version CHANGELOG section', () => {
    const published = run('not found');

    expect(published.stderr).toBe('');
    expect(published.status).toBe(0);
    const [create, ...rest] = called();
    expect(rest).toEqual([]);
    expect(create.replace(/--notes-file \S+$/, '--notes-file <notes>')).toBe(
      `gh release create v0.3.0 ${dist}/${TARBALL} ${dist}/${CHECKSUM} --verify-tag --title Cloudgate 0.3.0 --notes-file <notes>`,
    );
    const notes = fs.readFileSync(path.join(scratch, 'notes'), 'utf8');
    expect(notes).toContain('### Install a Cloudgate version');
    expect(notes).not.toContain('Not this');
    expect(notes).not.toContain('Older');
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('adds both files to a release made by hand that has neither', () => {
    const published = run({ assets: ['notes.pdf'] });

    expect(published.status).toBe(0);
    expect(called()).toEqual([
      `gh release upload v0.3.0 ${dist}/${TARBALL} ${dist}/${CHECKSUM}`,
    ]);
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('leaves a release that already has both files as it is', () => {
    const rerun = run({ assets: [TARBALL, CHECKSUM] });

    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain(
      'v0.3.0 already has its tarball and checksum',
    );
    expect(called()).toEqual([]);
  });

  it.each([[TARBALL], [CHECKSUM]])(
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
  it('publishes nothing when GitHub cannot say whether the release exists', () => {
    const refused = run('unreachable');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('HTTP 502');
    expect(called()).toEqual([]);
  });
});

/**
 * `.github/workflows/publish-version.yml` itself: the tarball is built on
 * Ubuntu 24.04 and booted by the smoke check on 24.04 and 26.04, the two
 * releases the install accepts (ADR-0085), before anything is published.
 */
describe('.github/workflows/publish-version.yml', () => {
  interface Job {
    'runs-on': string;
    needs?: string | string[];
    if?: string;
    strategy?: { matrix?: Record<string, unknown> };
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

  /** Every runner a job runs on, its matrix expanded. */
  function runners(job: Job): string[] {
    const fromMatrix = /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/.exec(job['runs-on']);
    if (!fromMatrix) return [job['runs-on']];
    const values = job.strategy?.matrix?.[fromMatrix[1]];
    if (!Array.isArray(values)) throw new Error(`no matrix.${fromMatrix[1]}`);
    return values.map(String);
  }

  it('builds the tarball on Ubuntu 24.04', () => {
    expect(runners(jobs().build)).toEqual(['ubuntu-24.04']);
  });

  it('runs the smoke check on Ubuntu 24.04 and 26.04', () => {
    expect(runners(jobs().smoke).sort()).toEqual([
      'ubuntu-24.04',
      'ubuntu-26.04',
    ]);
  });

  it('publishes only once the smoke check has passed on both', () => {
    const publish = jobs().publish;

    expect([publish.needs].flat()).toContain('smoke');
    // An `if:` such as always() would publish past a failed smoke run.
    expect(publish.if).toBeUndefined();
  });
});
