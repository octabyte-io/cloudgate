import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pinnedHttpOptions } from '../../src/git-providers/git-clone-lines';
import { gitStrategy } from '../../src/git-providers/strategies/git.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('gitStrategy.cloneProgram', () => {
  it('builds the clone command for a public http(s) repository and branch', () => {
    const { command } = gitStrategy.cloneProgram({
      url: 'https://github.com/octabyte-io/cloudgate.git',
      branch: 'main',
      outputPath: '/apps/api/code',
    });

    expect(command).toBe(
      `set -e;
rm -rf /apps/api/code;
mkdir -p /apps/api/code;
echo 'Cloning repo https://github.com/octabyte-io/cloudgate.git to /apps/api/code';
cg_clone=$(mktemp -d);
{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://github.com/octabyte-io/cloudgate.git /apps/api/code 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";
if [ -e "$cg_clone/failed" ]; then
  if grep -q 'terminal prompts disabled' "$cg_clone/output"; then echo 'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.'; fi;
  rm -rf "$cg_clone";
  echo '❌ Failed to clone repository https://github.com/octabyte-io/cloudgate.git';
  exit 1;
fi
rm -rf "$cg_clone";
echo '✅ Cloned repo https://github.com/octabyte-io/cloudgate.git';`,
    );
  });

  it('materializes the ssh key and known_hosts before cloning a private ssh repository', () => {
    const privateKey =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----';
    const { command } = gitStrategy.cloneProgram({
      url: 'git@github.com:octabyte-io/private.git',
      branch: 'develop',
      outputPath: '/apps/api/code',
      sshKey: { privateKey },
    });

    expect(command).toBe(
      `set -e;
(
CG_GIT_SSH=$(mktemp -d); export CG_GIT_SSH;
trap 'rm -rf "$CG_GIT_SSH"' EXIT; trap 'exit 1' HUP INT TERM;
echo "${Buffer.from(`${privateKey}\n`, 'utf-8').toString('base64')}" | base64 -d > "$CG_GIT_SSH/id_rsa";
chmod 600 "$CG_GIT_SSH/id_rsa";
if ! ssh-keyscan -p 22 github.com 2>/dev/null >> "$CG_GIT_SSH/known_hosts"; then
  echo 'ssh-keyscan read no host key from github.com:22, so ssh will accept the key the host presents.' >&2;
fi
export GIT_SSH_COMMAND='ssh -i "$CG_GIT_SSH/id_rsa" -o UserKnownHostsFile="$CG_GIT_SSH/known_hosts" -o StrictHostKeyChecking=accept-new';
rm -rf /apps/api/code;
mkdir -p /apps/api/code;
echo 'Cloning repo git@github.com:octabyte-io/private.git to /apps/api/code';
cg_clone=$(mktemp -d);
{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch develop --depth 1 --progress -- git\\@github.com\\:octabyte-io/private.git /apps/api/code 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";
if [ -e "$cg_clone/failed" ]; then
  if grep -q 'terminal prompts disabled' "$cg_clone/output"; then echo 'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.'; fi;
  rm -rf "$cg_clone";
  echo '❌ Failed to clone repository git@github.com:octabyte-io/private.git';
  exit 1;
fi
rm -rf "$cg_clone";
echo '✅ Cloned repo git@github.com:octabyte-io/private.git';
)`,
    );
  });

  it('emits an error command for an ssh repository without an ssh key', () => {
    const { command } = gitStrategy.cloneProgram({
      url: 'git@github.com:octabyte-io/private.git',
      branch: 'main',
      outputPath: '/apps/api/code',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ You are trying to clone a ssh repository without a ssh key, please set a ssh key"; exit 1;`,
    );
  });

  it('emits an error command when the url or branch is missing', () => {
    const { command } = gitStrategy.cloneProgram({
      url: null,
      branch: 'main',
      outputPath: '/apps/api/code',
    });

    expect(command).toBe(`set -e;
echo "Error: ❌ Repository not found"; exit 1;`);
  });

  it('adds --recurse-submodules when submodules are enabled', () => {
    const { command } = gitStrategy.cloneProgram({
      url: 'https://github.com/octabyte-io/cloudgate.git',
      branch: 'main',
      outputPath: '/apps/api/code',
      enableSubmodules: true,
    });

    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch main --depth 1 --recurse-submodules --progress -- https\\://github.com/octabyte-io/cloudgate.git /apps/api/code',
    );
  });

  /**
   * An operator can put a credential in a custom https URL; git needs it,
   * and the log is read by anyone who can open the Deployment. Both spellings:
   * `user:token@` and GitHub's bare `token@`.
   */
  it.each([
    'https://user:secret@git.example.com/acme/repo.git',
    'https://secret@git.example.com/acme/repo.git',
  ])('echoes %s without its userinfo and clones with it', (url) => {
    const { command } = gitStrategy.cloneProgram({
      url,
      branch: 'main',
      outputPath: '/apps/api/code',
    });
    const lines = command.split('\n');
    const echoed = lines.filter((line) => /^\s*(if .*then )?echo /.test(line));

    expect(echoed.filter((line) => line.includes('git.example.com'))).toEqual([
      "echo 'Cloning repo https://git.example.com/acme/repo.git to /apps/api/code';",
      "  echo '❌ Failed to clone repository https://git.example.com/acme/repo.git';",
      "echo '✅ Cloned repo https://git.example.com/acme/repo.git';",
    ]);
    expect(echoed.join('\n')).not.toContain('secret');
    expect(
      lines.find((line) =>
        line.includes('git -c protocol.file.allow=never clone'),
      ),
    ).toContain('secret\\@git.example.com');
  });

  /**
   * `--` ends git's options, so neither the URL nor the directory is read as
   * one whatever it starts with; `protocol.file.allow=never` refuses a local
   * repository, a submodule's included, as the source of a clone on the
   * build host.
   */
  it('ends the options before the url and refuses the file protocol', () => {
    const { command } = gitStrategy.cloneProgram({
      url: 'https://github.com/octabyte-io/cloudgate.git',
      branch: 'main',
      outputPath: '/apps/api/code',
      enableSubmodules: true,
    });

    expect(
      command.split('\n').find((line) => line.includes('GIT_TERMINAL_PROMPT')),
    ).toContain(
      'GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch main --depth 1 --recurse-submodules --progress -- https\\://github.com/octabyte-io/cloudgate.git /apps/api/code 2>&1',
    );
  });

  it('honors an explicit port in an ssh:// url for keyscan and the ssh command', () => {
    const { command } = gitStrategy.cloneProgram({
      url: 'ssh://git@git.example.com:2222/team/repo.git',
      branch: 'main',
      outputPath: '/apps/api/code',
      sshKey: { privateKey: 'KEY' },
    });

    expect(command).toContain(
      'if ! ssh-keyscan -p 2222 git.example.com 2>/dev/null >> "$CG_GIT_SSH/known_hosts"; then',
    );
    expect(command).toContain(
      `export GIT_SSH_COMMAND='ssh -i "$CG_GIT_SSH/id_rsa" -p 2222 -o UserKnownHostsFile="$CG_GIT_SSH/known_hosts" -o StrictHostKeyChecking=accept-new';`,
    );
  });
});

describe('gitStrategy shell safety', () => {
  /**
   * `customGitUrl` and `customGitBranch` are unvalidated columns, and the
   * clone command opens with `rm -rf <outputPath>` on the build server — so a
   * url of `a$(id)` used to run there. Quoted rather than refused, because a
   * repository URL legitimately carries what a path never would.
   */
  it('quotes the url, the branch and the output path of a clone', () => {
    const { command } = gitStrategy.cloneProgram({
      url: `https://git.example.com/${SHELL_PAYLOAD}.git`,
      branch: SHELL_PAYLOAD,
      outputPath: `/apps/${SHELL_PAYLOAD}/code`,
    });

    // One substitution is the clone's own: `cg_clone=$(mktemp -d)`.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 1);
    expect(command).toContain('rm -rf');
    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch',
    );
  });

  it('quotes the url of a branch listing', () => {
    expectQuotedInCommand(
      gitStrategy.listBranches({
        url: `https://git.example.com/${SHELL_PAYLOAD}.git`,
      }),
    );
  });

  it('quotes the output path of a commit read', () => {
    expectQuotedInCommand(
      gitStrategy.getCommitInfo({ outputPath: `/apps/${SHELL_PAYLOAD}/code` }),
    );
  });

  /**
   * The key is decrypted material, and `echo "${privateKey}"` substituted a
   * `$(…)` inside it just as readily as outside the double quotes. It went
   * through `quote()` for that reason and now goes through base64 instead
   * which is a stronger claim than quoting and a different assertion:
   * `expectQuotedInCommand` asks whether the payload arrived as one inert
   * *word*, and the payload no longer arrives in the command at all.
   *
   * Both halves are needed. The first is the safety property; the second is
   * what stops it being satisfied by a builder that silently dropped the key.
   */
  it('ships the private key it materializes as base64, not as a shell word', () => {
    const privateKey = `-----BEGIN KEY-----\n${SHELL_PAYLOAD}\n-----END KEY-----`;
    const { command } = gitStrategy.cloneProgram({
      url: 'git@git.example.com:acme/private.git',
      branch: 'main',
      outputPath: '/apps/api/code',
      sshKey: { privateKey },
    });

    expect(command).not.toContain(SHELL_PAYLOAD);
    expect(command).not.toContain('BEGIN KEY');
    const encoded = command.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1];
    // Byte-identical to what `echo '<key>' >` used to write: the key and the
    // newline `echo` added, which is the one OpenSSH wants.
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf-8')).toBe(
      `${privateKey}\n`,
    );
    expect(command).toContain('| base64 -d > "$CG_GIT_SSH/id_rsa";');
    expect(command).toContain('chmod 600');
  });

  // `parseSshUrl`'s domain group admits `;` and `$`, so the keyscan word is a
  // value word like any other.
  it('quotes the domain it hands to ssh-keyscan', () => {
    const { command } = gitStrategy.cloneProgram({
      url: `git@${SHELL_PAYLOAD}:acme/private.git`,
      branch: 'main',
      outputPath: '/apps/api/code',
      sshKey: { privateKey: 'KEY' },
    });

    // Three `(` are the program's own: the subshell the ssh lane runs in,
    // `CG_GIT_SSH=$(mktemp -d)` and `cg_clone=$(mktemp -d)`.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 3);
    expect(command).toContain('ssh-keyscan');
  });
});

describe('gitStrategy.listBranches', () => {
  it('lists remote heads for a public http(s) repository', () => {
    expect(
      gitStrategy.listBranches({
        url: 'https://github.com/octabyte-io/cloudgate.git',
      }),
    ).toBe(
      'git -c protocol.file.allow=never ls-remote --heads -- https\\://github.com/octabyte-io/cloudgate.git',
    );
  });

  it('routes ls-remote over the ssh key for a private ssh repository', () => {
    expect(
      gitStrategy.listBranches({
        url: 'git@github.com:octabyte-io/private.git',
        sshKey: { privateKey: 'KEY' },
      }),
    ).toBe(
      `set -e;
(
CG_GIT_SSH=$(mktemp -d); export CG_GIT_SSH;
trap 'rm -rf "$CG_GIT_SSH"' EXIT; trap 'exit 1' HUP INT TERM;
echo "${Buffer.from('KEY\n', 'utf-8').toString('base64')}" | base64 -d > "$CG_GIT_SSH/id_rsa";
chmod 600 "$CG_GIT_SSH/id_rsa";
if ! ssh-keyscan -p 22 github.com 2>/dev/null >> "$CG_GIT_SSH/known_hosts"; then
  echo 'ssh-keyscan read no host key from github.com:22, so ssh will accept the key the host presents.' >&2;
fi
export GIT_SSH_COMMAND='ssh -i "$CG_GIT_SSH/id_rsa" -o UserKnownHostsFile="$CG_GIT_SSH/known_hosts" -o StrictHostKeyChecking=accept-new';
git -c protocol.file.allow=never ls-remote --heads -- git\\@github.com\\:octabyte-io/private.git
)`,
    );
  });
});

describe('gitStrategy.getCommitInfo', () => {
  it('prints the head commit hash and message with the ---DELIMITER--- separator', () => {
    expect(gitStrategy.getCommitInfo({ outputPath: '/apps/api/code' })).toBe(
      'git -C /apps/api/code log -1 --pretty=format:"%H---DELIMITER---%B"',
    );
  });
});

/**
 * These run the generated clone under `sh` against a stand-in `git` and
 * `ssh-keyscan` on `PATH`, because what they pin is what the log reads: which
 * lines appear, in what order, and whether the program exits non-zero. A string
 * assertion cannot see a status that a pipeline swallowed.
 *
 * `TMPDIR` points every `mktemp -d` the program makes at a directory of the
 * suite's own, so a run never writes into the machine's `/tmp`, and what is
 * left in it afterwards is what the program failed to remove.
 */
describe('gitStrategy.cloneProgram, executed', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-git-clone-')),
  );
  const bin = path.join(root, 'bin');
  const scratch = path.join(root, 'scratch');
  const outputPath = path.join(root, 'code');

  beforeAll(() => {
    fs.mkdirSync(bin);
    // Records the environment it ran under, then answers the way the
    // scenario says git would.
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh
echo "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT-unset}" > "$FAKE_ROOT/git-env\${FAKE_TAG-}"
# The key file ssh would be handed, read the way git reads GIT_SSH_COMMAND.
if [ -n "\${GIT_SSH_COMMAND-}" ]; then
  eval "set -- $GIT_SSH_COMMAND"
  while [ $# -gt 0 ]; do
    if [ "$1" = -i ]; then key="$2"; fi
    shift
  done
  echo "$key" > "$FAKE_ROOT/key-path\${FAKE_TAG-}"
  cat "$key" > "$FAKE_ROOT/key-seen\${FAKE_TAG-}"
  cat "$(dirname "$key")/known_hosts" > "$FAKE_ROOT/known-hosts-seen\${FAKE_TAG-}"
fi
if [ -n "\${FAKE_SLEEP-}" ]; then sleep "$FAKE_SLEEP"; fi
echo "Cloning into '$FAKE_ROOT/code'..." >&2
case "$FAKE_GIT" in
  prompt)
    echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
    exit 128;;
  unreachable)
    echo "fatal: unable to access 'https://github.com/octabyte-io/cloudgate.git/': Could not resolve host: github.com" >&2
    exit 128;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'ssh-keyscan'),
      `#!/bin/sh
if [ "$FAKE_KEYSCAN" = fail ]; then
  echo "getaddrinfo github.com: Name or service not known" >&2
  exit 1
fi
echo "# github.com:22 SSH-2.0-babeld-5a2e1f7c" >&2
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch);
  });

  type Scenario = {
    git?: string;
    keyscan?: string;
    tag?: string;
    sleep?: string;
  };

  const environment = (scenario: Scenario): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: scratch,
    FAKE_ROOT: root,
    FAKE_GIT: scenario.git ?? 'ok',
    FAKE_KEYSCAN: scenario.keyscan ?? 'ok',
    FAKE_TAG: scenario.tag ?? '',
    FAKE_SLEEP: scenario.sleep ?? '',
  });

  /** Runs a clone the way the engine does — one subshell, output merged. */
  const run = (
    command: string,
    scenario: Scenario = {},
  ): { status: number; lines: string[] } => {
    const result = spawnSync('sh', ['-c', `(${command}) 2>&1`], {
      encoding: 'utf8',
      env: environment(scenario),
    });
    return {
      status: result.status ?? -1,
      lines: result.stdout.split('\n').filter((line) => line.trim()),
    };
  };

  /** The same, without waiting for it, so two clones overlap. */
  const start = (command: string, scenario: Scenario): Promise<number> =>
    new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', `(${command}) 2>&1`], {
        env: environment(scenario),
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });

  const httpsClone = () =>
    gitStrategy.cloneProgram({
      url: 'https://github.com/octabyte-io/cloudgate.git',
      branch: 'main',
      outputPath,
    }).command;

  const sshClone = () =>
    gitStrategy.cloneProgram({
      url: 'git@github.com:octabyte-io/private.git',
      branch: 'main',
      outputPath,
      sshKey: { privateKey: 'KEY' },
    }).command;

  it('marks a clone done only after git clone succeeds', () => {
    const { status, lines } = run(httpsClone());

    expect(status).toBe(0);
    expect(lines).toEqual([
      `Cloning repo https://github.com/octabyte-io/cloudgate.git to ${outputPath}`,
      `Cloning into '${root}/code'...`,
      '✅ Cloned repo https://github.com/octabyte-io/cloudgate.git',
    ]);
  });

  it('runs an https clone with terminal prompts disabled', () => {
    run(httpsClone());

    expect(fs.readFileSync(path.join(root, 'git-env'), 'utf8')).toBe(
      'GIT_TERMINAL_PROMPT=0\n',
    );
  });

  /**
   * git's own words for a credentials challenge on a URL that carries
   * none read like a device fault; the line after them says what they mean.
   */
  it('names the cause when the server asks an https clone for credentials', () => {
    const { status, lines } = run(httpsClone(), { git: 'prompt' });

    expect(status).toBe(1);
    expect(lines).toEqual([
      `Cloning repo https://github.com/octabyte-io/cloudgate.git to ${outputPath}`,
      `Cloning into '${root}/code'...`,
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.',
      '❌ Failed to clone repository https://github.com/octabyte-io/cloudgate.git',
    ]);
  });

  it('adds no credentials line to a clone that failed for another reason', () => {
    const { status, lines } = run(httpsClone(), { git: 'unreachable' });

    expect(status).toBe(1);
    expect(lines.at(-1)).toBe(
      '❌ Failed to clone repository https://github.com/octabyte-io/cloudgate.git',
    );
    expect(lines.join('\n')).not.toContain('asked for credentials');
    expect(lines.join('\n')).not.toContain('✅');
  });

  it("keeps ssh-keyscan's banner lines out of the log and its keys in known_hosts", () => {
    const { status, lines } = run(sshClone());

    expect(status).toBe(0);
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'known-hosts-seen'), 'utf8')).toBe(
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n',
    );
  });

  it('says so when ssh-keyscan reads no host key, and still attempts the clone', () => {
    const { lines } = run(sshClone(), { keyscan: 'fail' });

    expect(lines[0]).toBe(
      'ssh-keyscan read no host key from github.com:22, so ssh will accept the key the host presents.',
    );
    expect(lines[1]).toBe(
      `Cloning repo git@github.com:octabyte-io/private.git to ${outputPath}`,
    );
  });

  /**
   * Two tenants' clones on one build host at once. The key used to be written
   * to one fixed `/tmp/cloudgate/id_rsa` and left there, so the second write
   * could land between the first clone's write and its `ssh`, and that clone
   * ran on the other tenant's key.
   */
  it('gives two clones running at once their own key, and removes both', async () => {
    const clone = (privateKey: string) =>
      gitStrategy.cloneProgram({
        url: 'git@github.com:octabyte-io/private.git',
        branch: 'main',
        outputPath: path.join(root, `code-${privateKey}`),
        sshKey: { privateKey },
      }).command;

    const statuses = await Promise.all([
      start(clone('KEY-A'), { tag: '-a', sleep: '0.5' }),
      start(clone('KEY-B'), { tag: '-b', sleep: '0.5' }),
    ]);

    expect(statuses).toEqual([0, 0]);
    const read = (name: string) =>
      fs.readFileSync(path.join(root, name), 'utf8').trim();
    expect(read('key-seen-a')).toBe('KEY-A');
    expect(read('key-seen-b')).toBe('KEY-B');
    expect(read('key-path-a')).not.toBe(read('key-path-b'));
    expect(fs.existsSync(read('key-path-a'))).toBe(false);
    expect(fs.existsSync(read('key-path-b'))).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('removes the key when the clone fails', () => {
    const { status } = run(sshClone(), { git: 'unreachable', tag: '-failed' });

    expect(status).toBe(1);
    const keyPath = fs
      .readFileSync(path.join(root, 'key-path-failed'), 'utf8')
      .trim();
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });
});

/**
 * curl's resolve entry takes an IPv6 address in brackets, and an IP literal
 * host has no lookup to pin, so it gets only the redirect refusal.
 */
describe('pinnedHttpOptions', () => {
  it('brackets an IPv6 address in the resolve entry', () => {
    expect(
      pinnedHttpOptions({
        transport: 'http',
        host: 'git.example.com',
        port: 443,
        address: '2001:db8::1',
      }),
    ).toEqual([
      'http.curloptResolve=git.example.com:443:[2001:db8::1]',
      'http.followRedirects=false',
    ]);
  });

  it('writes no resolve entry for an IP literal host', () => {
    expect(
      pinnedHttpOptions({
        transport: 'http',
        host: '93.184.216.34',
        port: 80,
        address: '93.184.216.34',
      }),
    ).toEqual(['http.followRedirects=false']);
  });

  it('refuses a checked dial whose address is a name', () => {
    expect(() =>
      pinnedHttpOptions({
        transport: 'http',
        host: 'git.example.com',
        port: 443,
        address: 'git.example.com',
      }),
    ).toThrow();
  });
});
