import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `deploy/hosted-release-gate.sh`, the check deploy-hosted.yml makes before it
 * upgrades the Hosted instance on its own: run in a scratch tree holding only
 * the two files it reads, backend/package.json and CHANGELOG.md.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const gate = path.join(repoRoot, 'deploy/hosted-release-gate.sh');

let tree: string;

beforeEach(() => {
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-release-gate-'));
  fs.mkdirSync(path.join(tree, 'backend'));
});

afterEach(() => {
  fs.rmSync(tree, { recursive: true, force: true });
});

function release(version: string, changelog: string) {
  fs.writeFileSync(
    path.join(tree, 'backend/package.json'),
    JSON.stringify({ name: 'backend', version }),
  );
  fs.writeFileSync(path.join(tree, 'CHANGELOG.md'), changelog);
}

function run(tag: string) {
  return spawnSync('bash', [gate, tag], { cwd: tree, encoding: 'utf8' });
}

const NEWER = `# Changelog

## Unreleased

### Something not released yet

**What to do on upgrade**: subscribe the Stripe webhook to \`invoice.paid\`.

`;

describe('deploy/hosted-release-gate.sh', () => {
  it('passes a version whose every upgrade line says nothing', () => {
    release(
      '0.3.0',
      `${NEWER}## 0.3.0 (2026-11-20)

### One

**What to do on upgrade**: nothing.

### Two

**What to do on upgrade**: nothing. Migration \`0230_x\` adds a column.

### Three, with no upgrade line

## 0.2.0

**What to do on upgrade**: rotate every key.
`,
    );

    const passed = run('v0.3.0');

    expect(passed.stderr).toBe('');
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('v0.3.0 asks for nothing on upgrade');
  });

  it('stops for a person, naming each line that asks for something', () => {
    release(
      '0.3.0',
      `## v0.3.0

**What to do on upgrade**: nothing.

**What to do on upgrade**: nothing on a Self-hosted instance. On the Hosted instance, subscribe the webhook to \`charge.dispute.created\`.

**What to do on upgrade**: nothing, if \`CLOUDGATE_TEMPLATES_URL\` is unset.
`,
    );

    const stopped = run('v0.3.0');

    expect(stopped.status).toBe(3);
    expect(stopped.stdout).toContain('nothing on a Self-hosted instance');
    expect(stopped.stdout).toContain('nothing, if');
    expect(stopped.stdout).not.toContain('**: nothing.\n');
  });

  it('refuses a tag that is not backend/package.json version', () => {
    release('0.2.0', '## 0.3.0\n');

    const refused = run('v0.3.0');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "is not backend/package.json's version (0.2.0)",
    );
  });

  it('refuses a version with no section of its own in CHANGELOG.md', () => {
    release('0.3.0', `${NEWER}## 0.3.1\n\n## 0.2.0\n`);

    const refused = run('v0.3.0');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('CHANGELOG.md has no "## 0.3.0" section');
  });

  it.each([['0.3.0'], ['v0.3'], ['cli-v0.3.0'], ['v0.3.0-beta.1']])(
    'refuses %j as a server version tag',
    (tag) => {
      release('0.3.0', '## 0.3.0\n');

      const refused = run(tag);

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('A server version tag is vX.Y.Z');
    },
  );
});
