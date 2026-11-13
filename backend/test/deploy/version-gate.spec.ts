import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `deploy/version-gate.sh`, the checks publish-version.yml makes before it
 * builds a Cloudgate version: run in a scratch git repository holding only
 * what it reads, backend/package.json, the tag and `origin/main`, which the
 * workflow's checkout fetches and here is a ref set by hand.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const gate = path.join(repoRoot, 'deploy/version-gate.sh');

let tree: string;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: tree,
    env: gitEnv,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** Commits backend/package.json at `version` and returns the commit. */
function commit(version: string): string {
  fs.writeFileSync(
    path.join(tree, 'backend/package.json'),
    JSON.stringify({ name: 'backend', version }),
  );
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', `backend ${version}`);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'version-gate-'));
  fs.mkdirSync(path.join(tree, 'backend'));
  git('init', '-q');
});

afterEach(() => {
  fs.rmSync(tree, { recursive: true, force: true });
});

/** Points `origin/main` at `commit`, as a fetch of main would. */
function mainAt(commit: string) {
  git('update-ref', 'refs/remotes/origin/main', commit);
}

/**
 * Runs the gate. Unless a test has set `origin/main` itself, or says there is
 * none (`fetchedMain: false`), main is where the tree is, so the tag is on it.
 */
function run(
  tag: string,
  e2e: { conclusion: string; testedSha: string },
  { fetchedMain = true } = {},
) {
  if (
    fetchedMain &&
    spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
      cwd: tree,
    }).status !== 0
  ) {
    mainAt('HEAD');
  }
  return spawnSync('bash', [gate, tag], {
    cwd: tree,
    env: {
      ...process.env,
      E2E_CONCLUSION: e2e.conclusion,
      TESTED_SHA: e2e.testedSha,
    },
    encoding: 'utf8',
  });
}

describe('deploy/version-gate.sh', () => {
  it('passes a green E2E run of the commit the tag names, at backend/package.json version', () => {
    const tested = commit('0.3.0');
    git('tag', 'v0.3.0');

    const passed = run('v0.3.0', { conclusion: 'success', testedSha: tested });

    expect(passed.stderr).toBe('');
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('v0.3.0 may be published');
  });

  it.each([['failure'], ['cancelled'], ['timed_out'], ['']])(
    'refuses an E2E run whose conclusion is %j',
    (conclusion) => {
      const tested = commit('0.3.0');
      git('tag', 'v0.3.0');

      const refused = run('v0.3.0', { conclusion, testedSha: tested });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('E2E (release) did not pass');
    },
  );

  it('refuses a tag that has moved since the commit E2E tested', () => {
    const tested = commit('0.3.0');
    const moved = commit('0.3.0');
    git('tag', 'v0.3.0', moved);

    const refused = run('v0.3.0', { conclusion: 'success', testedSha: tested });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `v0.3.0 now names ${moved}, but E2E tested ${tested}`,
    );
  });

  it('refuses a tree that is not the commit the tag names', () => {
    const tested = commit('0.3.0');
    git('tag', 'v0.3.0');
    commit('0.3.0');

    const refused = run('v0.3.0', { conclusion: 'success', testedSha: tested });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('is not checked out at v0.3.0');
  });

  it('refuses a tag whose commit is not on main, however green its E2E run', () => {
    const onMain = commit('0.2.0');
    mainAt(onMain);
    git('checkout', '-q', '-b', 'side');
    const tested = commit('0.3.0');
    git('tag', 'v0.3.0');

    const refused = run('v0.3.0', { conclusion: 'success', testedSha: tested });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `v0.3.0 (${tested}) is not on main; only a tag on main is published`,
    );
  });

  it('passes a tag behind the tip of main', () => {
    const tested = commit('0.3.0');
    git('tag', 'v0.3.0');
    mainAt(commit('0.3.0'));
    git('checkout', '-q', 'v0.3.0');

    const passed = run('v0.3.0', { conclusion: 'success', testedSha: tested });

    expect(passed.stderr).toBe('');
    expect(passed.status).toBe(0);
  });

  it('refuses when it has no origin/main to ask, rather than passing the tag', () => {
    const tested = commit('0.3.0');
    git('tag', 'v0.3.0');

    const refused = run(
      'v0.3.0',
      { conclusion: 'success', testedSha: tested },
      { fetchedMain: false },
    );

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('There is no origin/main here');
  });

  it('refuses a tag that is not backend/package.json version', () => {
    const tested = commit('0.2.0');
    git('tag', 'v0.3.0');

    const refused = run('v0.3.0', { conclusion: 'success', testedSha: tested });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "v0.3.0 is not backend/package.json's version (0.2.0)",
    );
  });

  it.each([['0.3.0'], ['v0.3'], ['cli-v0.3.0'], ['v0.3.0-beta.1']])(
    'refuses %j as a Cloudgate version tag',
    (tag) => {
      const tested = commit('0.3.0');
      git('tag', tag);

      const refused = run(tag, { conclusion: 'success', testedSha: tested });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('A Cloudgate version tag is vX.Y.Z');
    },
  );
});
