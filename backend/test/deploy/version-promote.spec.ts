import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `deploy/version-promote.sh`, the first job of promote-release-candidate.yml:
 * it checks a release candidate's E2E run and pre-release, then tags the
 * version on the candidate's commit (ADR-0094). It runs in a scratch
 * repository; `gh` is a shim that answers `run list` and `release view` as the
 * test says GitHub would and records every call, so nothing reaches GitHub.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/version-promote.sh');

let scratch: string;
let tree: string;
let calls: string;

function git(...args: string[]): string {
  const ran = spawnSync('git', args, {
    cwd: tree,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout.trim();
}

function commit(): string {
  git('commit', '-q', '--allow-empty', '-m', 'change');
  return git('rev-parse', 'HEAD');
}

/** The six files a published release of `version` carries. */
function filesOf(version: string): string[] {
  return ['amd64', 'arm64'].flatMap((cpu) => {
    const tarball = `cloudgate-${version}-linux-${cpu}.tar.gz`;
    return [tarball, `${tarball}.sha256`, `${tarball}.sha256.sig`];
  });
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'version-promote-'));
  tree = path.join(scratch, 'tree');
  calls = path.join(scratch, 'calls');
  fs.mkdirSync(tree);
  git('init', '-q');
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * `run` is the newest E2E run `gh run list` reports for the candidate's tag,
 * or none; `assets` the candidate's release, or none.
 */
function promote(
  candidate: string,
  github: {
    run?: { status: string; conclusion: string; headSha: string };
    assets?: string[];
  },
) {
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const listed = github.run
    ? `echo '${github.run.status} ${github.run.conclusion || '-'} ${github.run.headSha}'`
    : 'true';
  const viewed = github.assets
    ? github.assets.map((name) => `echo '${name}'`).join('\n') || 'true'
    : `echo "release not found" >&2; exit 1`;
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
echo "gh $*" >> "${calls}"
case "$1 $2" in
  "run list")
${listed}
    ;;
  "release view")
${viewed}
    ;;
  "api --method") ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  return spawnSync('bash', [script, candidate], {
    cwd: tree,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'octabyte-io/cloudgate',
    },
    encoding: 'utf8',
  });
}

function called(): string[] {
  return fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    : [];
}

function tagCalls(): string[] {
  return called().filter((call) => call.startsWith('gh api'));
}

const green = (headSha: string) => ({
  status: 'completed',
  conclusion: 'success',
  headSha,
});

describe('deploy/version-promote.sh', () => {
  it('tags the version on the commit the candidate tested, and prints the tag and that commit', () => {
    const tested = commit();
    git('tag', 'v0.3.0-rc.2');

    const promoted = promote('v0.3.0-rc.2', {
      run: green(tested),
      assets: filesOf('0.3.0-rc.2'),
    });

    expect(promoted.status).toBe(0);
    expect(promoted.stdout).toBe(`tag=v0.3.0\ntested_sha=${tested}\n`);
    expect(called()).toContain(
      'gh run list --repo octabyte-io/cloudgate --workflow e2e.yml --event push --branch v0.3.0-rc.2 --limit 1 --json status,conclusion,headSha --jq .[] | "\\(.status) \\(if (.conclusion // "") == "" then "-" else .conclusion end) \\(.headSha)"',
    );
    expect(tagCalls()).toEqual([
      `gh api --method POST repos/octabyte-io/cloudgate/git/refs -f ref=refs/tags/v0.3.0 -f sha=${tested}`,
    ]);
  });

  it('publishes again, tagging nothing, when the version already names that commit', () => {
    const tested = commit();
    git('tag', 'v0.3.0-rc.1');
    git('tag', 'v0.3.0');

    const again = promote('v0.3.0-rc.1', {
      run: green(tested),
      assets: filesOf('0.3.0-rc.1'),
    });

    expect(again.status).toBe(0);
    expect(again.stdout).toBe(`tag=v0.3.0\ntested_sha=${tested}\n`);
    expect(tagCalls()).toEqual([]);
  });

  it('refuses when the version is already a tag on another commit', () => {
    const older = commit();
    git('tag', 'v0.3.0', older);
    const tested = commit();
    git('tag', 'v0.3.0-rc.1');

    const refused = promote('v0.3.0-rc.1', {
      run: green(tested),
      assets: filesOf('0.3.0-rc.1'),
    });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`v0.3.0 already names ${older}`);
    expect(tagCalls()).toEqual([]);
  });

  it.each(['v0.3.0', 'v0.3.0-rc.0', 'v0.3.0-beta.1', 'cli-v0.3.0-rc.1', ''])(
    // eslint-disable-next-line no-restricted-syntax -- a release candidate of a Cloudgate version (ADR-0094), not a Deployment's
    'refuses %j, which is not a release candidate, asking GitHub nothing',
    (candidate) => {
      const refused = promote(candidate, {});

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        // eslint-disable-next-line no-restricted-syntax -- a release candidate of a Cloudgate version (ADR-0094), not a Deployment's
        "A release candidate's tag is vX.Y.Z-rc.N",
      );
      expect(called()).toEqual([]);
    },
  );

  it('refuses a candidate that is not a tag', () => {
    commit();

    const refused = promote('v0.3.0-rc.1', {});

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('There is no tag v0.3.0-rc.1');
    expect(called()).toEqual([]);
  });

  it('refuses a candidate with no E2E run', () => {
    commit();
    git('tag', 'v0.3.0-rc.1');

    const refused = promote('v0.3.0-rc.1', { assets: filesOf('0.3.0-rc.1') });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('v0.3.0-rc.1 has no E2E (release) run');
    expect(tagCalls()).toEqual([]);
  });

  it('refuses a candidate whose E2E run is still going', () => {
    const tested = commit();
    git('tag', 'v0.3.0-rc.1');

    const refused = promote('v0.3.0-rc.1', {
      run: { status: 'in_progress', conclusion: '', headSha: tested },
      assets: filesOf('0.3.0-rc.1'),
    });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('has not finished (it is in_progress)');
    expect(tagCalls()).toEqual([]);
  });

  it.each(['failure', 'cancelled', 'timed_out'])(
    'refuses a candidate whose E2E run ended %s',
    (conclusion) => {
      const tested = commit();
      git('tag', 'v0.3.0-rc.1');

      const refused = promote('v0.3.0-rc.1', {
        run: { status: 'completed', conclusion, headSha: tested },
        assets: filesOf('0.3.0-rc.1'),
      });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        `did not pass (its conclusion is "${conclusion}")`,
      );
      expect(tagCalls()).toEqual([]);
    },
  );

  it('refuses a candidate whose tag has moved since its E2E run tested it', () => {
    const tested = commit();
    const moved = commit();
    git('tag', 'v0.3.0-rc.1', moved);

    const refused = promote('v0.3.0-rc.1', {
      run: green(tested),
      assets: filesOf('0.3.0-rc.1'),
    });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `v0.3.0-rc.1 now names ${moved}, but its E2E (release) run tested ${tested}`,
    );
    expect(tagCalls()).toEqual([]);
  });

  it('refuses a candidate with no published pre-release', () => {
    const tested = commit();
    git('tag', 'v0.3.0-rc.1');

    const refused = promote('v0.3.0-rc.1', { run: green(tested) });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'v0.3.0-rc.1 has no published pre-release',
    );
    expect(tagCalls()).toEqual([]);
  });

  it.each(filesOf('0.3.0-rc.1').map((file) => [file]))(
    'refuses a candidate whose pre-release has no %s',
    (missing) => {
      const tested = commit();
      git('tag', 'v0.3.0-rc.1');

      const refused = promote('v0.3.0-rc.1', {
        run: green(tested),
        assets: filesOf('0.3.0-rc.1').filter((file) => file !== missing),
      });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`pre-release has no ${missing}`);
      expect(tagCalls()).toEqual([]);
    },
  );
});
