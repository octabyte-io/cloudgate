import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

/**
 * `deploy/version-publish.sh`, the last step of publish-version.yml: it puts
 * the Cloudgate version's two tarballs, linux-amd64 and linux-arm64, their
 * checksums and the checksums' signatures on the tag's GitHub Release, all six
 * or none (ADR-0087, ADR-0088).
 * `gh` is a shim that answers `release view` as the test says GitHub would and
 * records every other call, so nothing reaches GitHub.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/version-publish.sh');

const TARBALL = 'cloudgate-0.3.0-linux-amd64.tar.gz';
const CHECKSUM = `${TARBALL}.sha256`;
const ARM64_TARBALL = 'cloudgate-0.3.0-linux-arm64.tar.gz';
const ARM64_CHECKSUM = `${ARM64_TARBALL}.sha256`;
const FILES = [
  TARBALL,
  CHECKSUM,
  `${CHECKSUM}.sig`,
  ARM64_TARBALL,
  ARM64_CHECKSUM,
  `${ARM64_CHECKSUM}.sig`,
];

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
    fs.writeFileSync(path.join(dist, `${tarball}.sha256.sig`), 'signature');
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
function run(
  view: { assets: string[] } | 'not found' | 'unreachable',
  tag = 'v0.3.0',
) {
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
  return spawnSync('bash', [script, tag, dist], {
    cwd: tree,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

/** The six files of `version`, written to dist as version-tarball.sh and version-sign.sh would. */
function distFor(version: string): string[] {
  const files: string[] = [];
  for (const cpu of ['amd64', 'arm64']) {
    const tarball = `cloudgate-${version}-linux-${cpu}.tar.gz`;
    fs.writeFileSync(path.join(dist, tarball), 'tarball');
    fs.writeFileSync(path.join(dist, `${tarball}.sha256`), `abc  ${tarball}\n`);
    fs.writeFileSync(path.join(dist, `${tarball}.sha256.sig`), 'signature');
    files.push(tarball, `${tarball}.sha256`, `${tarball}.sha256.sig`);
  }
  return files;
}

function called(): string[] {
  return fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    : [];
}

describe('deploy/version-publish.sh', () => {
  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('creates the release for the tag with both tarballs, their checksums and both signatures, its notes the version CHANGELOG section', () => {
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
  it('creates a release candidate as a pre-release, its notes its version CHANGELOG section (ADR-0094)', () => {
    const files = distFor('0.3.0-rc.2');

    const published = run('not found', 'v0.3.0-rc.2');

    expect(published.stderr).toBe('');
    expect(published.status).toBe(0);
    expect(published.stdout).toContain('as a pre-release');
    const [create, ...rest] = called();
    expect(rest).toEqual([]);
    expect(create.replace(/--notes-file \S+$/, '--notes-file <notes>')).toBe(
      `gh release create v0.3.0-rc.2 ${files.map((file) => `${dist}/${file}`).join(' ')} --verify-tag --prerelease --title Cloudgate 0.3.0-rc.2 --notes-file <notes>`,
    );
    const notes = fs.readFileSync(path.join(scratch, 'notes'), 'utf8');
    expect(notes).toContain('### Install a Cloudgate version');
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('takes a release candidate notes from Unreleased while its version has no CHANGELOG section', () => {
    distFor('0.4.0-rc.1');

    const published = run('not found', 'v0.4.0-rc.1');

    expect(published.status).toBe(0);
    expect(called()[0]).toContain('--prerelease');
    const notes = fs.readFileSync(path.join(scratch, 'notes'), 'utf8');
    expect(notes).toContain('### Not this');
    expect(notes).not.toContain('Install a Cloudgate version');
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('refuses a release candidate whose six files are not there, publishing nothing', () => {
    const refused = run('not found', 'v0.3.0-rc.1');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'cloudgate-0.3.0-rc.1-linux-amd64.tar.gz is not there',
    );
    expect(called()).toEqual([]);
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('adds all six files to a release made by hand that has none of them', () => {
    const published = run({ assets: ['notes.pdf'] });

    expect(published.status).toBe(0);
    expect(called()).toEqual([
      `gh release upload v0.3.0 ${FILES.map((file) => `${dist}/${file}`).join(' ')}`,
    ]);
  });

  // eslint-disable-next-line no-restricted-syntax -- a GitHub Release, not a Deployment's
  it('leaves a release that already has all six files as it is', () => {
    const rerun = run({ assets: FILES });

    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain(
      'v0.3.0 already has its tarballs, checksums and signatures',
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
    expect(refused.stderr).toContain('but not all six files');
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
 * `deploy/version-sign.sh`, run in publish-version.yml just before
 * version-publish.sh: it signs both checksums with VERSION_SIGNING_KEY
 * (`ssh-keygen -Y sign`, namespace `cloudgate-version`) and checks each
 * signature against the allowed-signers line root `install.sh` carries
 * (ADR-0087). The keys are made here with `ssh-keygen`; `install.sh` is a
 * stand-in holding the trusted one's line.
 */
describe('deploy/version-sign.sh', () => {
  const signScript = path.join(repoRoot, 'deploy/version-sign.sh');

  /** A key made with ssh-keygen: its private half and its allowed-signers line. */
  function makeKey(name: string): { privateKey: string; signers: string } {
    const file = path.join(scratch, name);
    const made = spawnSync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', file],
      { encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(made.stderr);
    const publicKey = fs.readFileSync(`${file}.pub`, 'utf8').trim();
    return {
      privateKey: fs.readFileSync(file, 'utf8'),
      signers: `cloudgate-version namespaces="cloudgate-version" ${publicKey}`,
    };
  }

  let trusted: { privateKey: string; signers: string };

  beforeEach(() => {
    trusted = makeKey('trusted');
    fs.writeFileSync(
      path.join(tree, 'install.sh'),
      `#!/bin/sh\nVERSION_SIGNERS='${trusted.signers}'\n`,
    );
    // Unsigned, as version-tarball.sh writes them.
    for (const checksum of [CHECKSUM, ARM64_CHECKSUM]) {
      fs.rmSync(path.join(dist, `${checksum}.sig`));
    }
  });

  function sign(key: string | undefined, tag = 'v0.3.0') {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.VERSION_SIGNING_KEY;
    if (key !== undefined) env.VERSION_SIGNING_KEY = key;
    return spawnSync('bash', [signScript, tag, dist], {
      cwd: tree,
      env,
      encoding: 'utf8',
    });
  }

  /** `ssh-keygen -Y verify` of `checksum` against `signers`, as the install runs it. */
  function verifies(checksum: string, signers: string): boolean {
    const allowed = path.join(scratch, 'allowed_signers');
    fs.writeFileSync(allowed, `${signers}\n`);
    return (
      spawnSync(
        'ssh-keygen',
        [
          '-Y',
          'verify',
          '-f',
          allowed,
          '-I',
          'cloudgate-version',
          '-n',
          'cloudgate-version',
          '-s',
          path.join(dist, `${checksum}.sig`),
        ],
        { input: fs.readFileSync(path.join(dist, checksum)) },
      ).status === 0
    );
  }

  // eslint-disable-next-line no-restricted-syntax -- a release candidate of a Cloudgate version (ADR-0094), not a Deployment's
  it('signs a release candidate checksums, named for the candidate (ADR-0094)', () => {
    const files = distFor('0.3.0-rc.1');
    for (const file of files.filter((name) => name.endsWith('.sig'))) {
      fs.rmSync(path.join(dist, file));
    }

    const signed = sign(trusted.privateKey, 'v0.3.0-rc.1');

    expect(signed.stderr).toBe('');
    expect(signed.status).toBe(0);
    expect(
      verifies(
        'cloudgate-0.3.0-rc.1-linux-amd64.tar.gz.sha256',
        trusted.signers,
      ),
    ).toBe(true);
    expect(
      verifies(
        'cloudgate-0.3.0-rc.1-linux-arm64.tar.gz.sha256',
        trusted.signers,
      ),
    ).toBe(true);
  });

  it('signs both checksums with the key, in the cloudgate-version namespace', () => {
    const signed = sign(trusted.privateKey);

    expect(signed.status).toBe(0);
    expect(verifies(CHECKSUM, trusted.signers)).toBe(true);
    expect(verifies(ARM64_CHECKSUM, trusted.signers)).toBe(true);
  });

  it('refuses a key install.sh does not trust, leaving no signature to publish', () => {
    const other = makeKey('other');

    const refused = sign(other.privateKey);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'does not verify against the key root install.sh trusts',
    );
    expect(fs.existsSync(path.join(dist, `${CHECKSUM}.sig`))).toBe(false);
    expect(fs.existsSync(path.join(dist, `${ARM64_CHECKSUM}.sig`))).toBe(false);
  });

  // ADR-0087: a rotation ships the new key in install.sh beside the old one
  // before the first version signed with it.
  it('signs with a key on any line of a VERSION_SIGNERS that holds more than one', () => {
    const old = makeKey('old');
    fs.writeFileSync(
      path.join(tree, 'install.sh'),
      `#!/bin/sh\nVERSION_SIGNERS='${old.signers}\n${trusted.signers}'\n`,
    );

    const signed = sign(trusted.privateKey);

    expect(signed.stderr).toBe('');
    expect(signed.status).toBe(0);
    expect(verifies(CHECKSUM, trusted.signers)).toBe(true);
    expect(verifies(ARM64_CHECKSUM, trusted.signers)).toBe(true);
  });

  it('refuses to run without VERSION_SIGNING_KEY, signing nothing', () => {
    const refused = sign(undefined);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('VERSION_SIGNING_KEY is not set');
    expect(fs.existsSync(path.join(dist, `${CHECKSUM}.sig`))).toBe(false);
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
    expect(include(build).map(({ cpu, runner }) => `${cpu} ${runner}`)).toEqual(
      ['amd64 ubuntu-24.04', 'arm64 ubuntu-24.04-arm'],
    );
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

  it('signs both checksums with VERSION_SIGNING_KEY just before it publishes them', () => {
    const steps = (
      jobs().publish as Job & {
        steps: { run?: string; env?: Record<string, string> }[];
      }
    ).steps;
    const signing = steps.findIndex((step) =>
      step.run?.includes('deploy/version-sign.sh'),
    );
    const publishing = steps.findIndex((step) =>
      step.run?.includes('deploy/version-publish.sh'),
    );

    expect(signing).toBeGreaterThan(-1);
    expect(steps[signing].run).toContain(
      'bash deploy/version-sign.sh "$TAG" "$RUNNER_TEMP/version"',
    );
    expect(steps[signing].env).toEqual({
      VERSION_SIGNING_KEY: '${{ secrets.VERSION_SIGNING_KEY }}',
    });
    expect(publishing).toBe(signing + 1);
  });

  it('publishes only once the smoke check has passed on all four', () => {
    const publish = jobs().publish;

    expect([publish.needs].flat()).toContain('smoke');
    // An `if:` such as always() would publish past a failed smoke run.
    expect(publish.if).toBeUndefined();
  });

  // eslint-disable-next-line no-restricted-syntax -- a release candidate of a Cloudgate version (ADR-0094), not a Deployment's
  it('names the tarball for the tag, so a release candidate is built as one (ADR-0094)', () => {
    const steps = (jobs().build as Job & { steps: { run?: string }[] }).steps;

    expect(
      steps.some((step) =>
        step.run?.includes(
          'bash deploy/version-tarball.sh "$RUNNER_TEMP/version" "$TAG"',
        ),
      ),
    ).toBe(true);
  });

  // eslint-disable-next-line no-restricted-syntax -- a release candidate of a Cloudgate version (ADR-0094), not a Deployment's
  it('never starts the Hosted instance upgrade for a release candidate', () => {
    expect(jobs()['deploy-hosted'].if).toBe(
      "${{ !contains(inputs.tag || github.event.workflow_run.head_branch, '-rc.') }}",
    );
  });

  it('is called by a promotion with the version tag and the commit the candidate tested', () => {
    const workflow = parse(
      fs.readFileSync(
        path.join(repoRoot, '.github/workflows/publish-version.yml'),
        'utf8',
      ),
      { logLevel: 'error' },
    ) as {
      on: { workflow_call: { inputs: Record<string, { required: boolean }> } };
      env: Record<string, string>;
    };

    expect(Object.keys(workflow.on.workflow_call.inputs).sort()).toEqual([
      'tag',
      'tested_sha',
    ]);
    expect(workflow.env.TAG).toBe(
      '${{ inputs.tag || github.event.workflow_run.head_branch }}',
    );
    expect(workflow.env.TESTED_SHA).toBe(
      '${{ inputs.tested_sha || github.event.workflow_run.head_sha }}',
    );
  });
});

/**
 * `.github/workflows/promote-release-candidate.yml`: run by hand, it tags the
 * version on the candidate's tested commit with deploy/version-promote.sh,
 * then publishes and deploys it through publish-version.yml (ADR-0094).
 */
describe('.github/workflows/promote-release-candidate.yml', () => {
  const workflow = () =>
    parse(
      fs.readFileSync(
        path.join(repoRoot, '.github/workflows/promote-release-candidate.yml'),
        'utf8',
      ),
      { logLevel: 'error' },
    ) as {
      on: Record<string, unknown>;
      jobs: Record<
        string,
        {
          needs?: string;
          uses?: string;
          with?: Record<string, string>;
          secrets?: Record<string, string>;
          steps?: { run?: string }[];
        }
      >;
    };

  it('runs only by hand', () => {
    expect(Object.keys(workflow().on)).toEqual(['workflow_dispatch']);
  });

  it('promotes with deploy/version-promote.sh, then calls publish-version.yml with what it printed', () => {
    const { promote, publish } = workflow().jobs;

    expect(
      promote.steps?.some((step) =>
        step.run?.includes('bash deploy/version-promote.sh "$CANDIDATE"'),
      ),
    ).toBe(true);
    expect(publish.needs).toBe('promote');
    expect(publish.uses).toBe('./.github/workflows/publish-version.yml');
    expect(publish.with).toEqual({
      tag: '${{ needs.promote.outputs.tag }}',
      tested_sha: '${{ needs.promote.outputs.tested_sha }}',
    });
    expect(publish.secrets).toEqual({
      VERSION_SIGNING_KEY: '${{ secrets.VERSION_SIGNING_KEY }}',
    });
  });
});
