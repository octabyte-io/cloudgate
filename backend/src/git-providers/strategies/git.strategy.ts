import { quote } from 'shell-quote';
import { encodeBase64 } from '../../docker/docker.utils';
import { isIP } from 'node:net';
import { gitCloneLines } from '../git-clone-lines';
import type { CheckedDial } from '../git-clone-lines';
import { sourceProgram } from '../source-program';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../git-provider.strategy';
import type { SourceProgram } from '../source-program';

/**
 * The variable naming the clone's own key directory. Clone commands may run on
 * any server (local or over ssh), so the command makes the directory itself,
 * with `mktemp -d` (`0700`), one per clone.
 *
 * It was one fixed `/tmp/cloudgate`, shared by every tenant's clone on a build
 * host and never cleaned: two clones at once could each write `id_rsa` between
 * the other's write and its `ssh`, and one ran on the other tenant's key, which
 * then stayed on the disk. `GIT_SSH_COMMAND` names the variable rather than its
 * value, and git runs that command through a shell, so the path is never a
 * word of a command line that has to be quoted.
 */
const SSH_DIR = 'CG_GIT_SSH';
const KEY_PATH = `"$${SSH_DIR}/id_rsa"`;
const KNOWN_HOSTS_PATH = `"$${SSH_DIR}/known_hosts"`;

const isHttpOrHttps = (url: string): boolean => /^https?:\/\//.test(url);

/**
 * An http(s) URL as the log may print it: without its userinfo, which is where
 * an operator puts a token for a private repository. Only git is handed
 * the URL with it.
 *
 * Not `common/logging/error-payloads.ts`' `URL_CREDENTIAL`, which keeps the
 * user and needs a `:` — so it would print GitHub's bare `https://<token>@`
 * spelling whole, which is a URL an operator can type here. An ssh URL keeps
 * its user: `git@` is the account name, not a secret.
 */
const withoutUserinfo = (url: string): string =>
  url.replace(/^(https?:\/\/)[^/?#]*@/i, '$1');

/** Pulls user/domain/port/path out of an ssh repo URL. */
const parseSshUrl = (input: string) => {
  const SSH_PATH_RE = new RegExp(
    [
      /^\s*/,
      /(?:(?<proto>[a-z]+):\/\/)?/,
      /(?:(?<user>[a-z_][a-z0-9_-]+)@)?/,
      /(?<domain>[^\s/?#:]+)/,
      /(?::(?<port>[0-9]{1,5}))?/,
      /(?:[/:](?<owner>[^\s/?#:]+))?/,
      /(?:[/:](?<repo>(?:[^\s?#:.]|\.(?!git\/?\s*$))+))/,
      /(?:.git)?\/?\s*$/,
    ]
      .map((r) => r.source)
      .join(''),
    'i',
  );

  const found = input.match(SSH_PATH_RE);
  if (!found) {
    throw new Error(`Malformatted SSH path: ${input}`);
  }

  return {
    domain: found.groups?.domain,
    port: found.groups?.port ? Number(found.groups.port) : null,
  };
};

/**
 * Lines that write the private key and trust the host, then route git over
 * it: accept-new pins the host key on first contact; the keyscan is
 * best-effort (some hosts never answer it) and must not abort under set -e.
 * Its stderr is dropped because it carries a `# host:port SSH-2.0-…` banner
 * per key type, which filled the head of every ssh build log; a scan that
 * reads no key says so in one line instead.
 *
 * The key was written `echo "${privateKey}" > …`, and `$` and a backtick
 * substitute inside double quotes as readily as outside them — so a decrypted
 * SSH key was `quote()`d like everything else here, and so is the `domain`
 * `parseSshUrl` pulls out of `customGitUrl` (its pattern, `[^\s/?#:]+`, admits
 * `;` and `$`). `KEY_PATH`/`KNOWN_HOSTS_PATH` are module constants and `port`
 * is a `Number`, so those stay bare.
 *
 * **The key now travels base64-encoded, and the reason is the journal** (from a
 * review). `sshKey.privateKey` is an `encryptedText` column (ADR 0006), and
 * `echo <the PEM> > <path>` put the whole decrypted key into
 * `ExecError.command` on every failed clone, from where pino writes it six
 * times over: `common/logging/error-payloads.ts` elides
 * `echo <base64> | base64 -d`, which is the shape the tree's other twelve file
 * writers use, and this one had the opening anchor without the closing one. So
 * the fix is to *be* that shape rather than to teach the elision a fourteenth
 * one — a body already covered wherever it is written beats a pattern per
 * builder, and this is the same command `getCreateFileCommand` emits for a
 * mount, a patch and a traefik certificate key.
 *
 * It is also strictly safer on the shell, which is why it replaces the quoting
 * rather than joining it: base64's alphabet contains nothing a shell reacts to,
 * so the word carrying the key stops being a value that has to be escaped
 * correctly and becomes one that cannot be escaped wrongly. `\n` is appended
 * because that is what `echo` used to add — the bytes that land in `id_rsa` are
 * byte-identical to before, and OpenSSH wants the trailing newline.
 *
 * It does **not** claim the key is secret on the host: it is still decoded into
 * a scratch file that `chmod 600` protects and nothing else does, exactly as
 * before. ADR 0015's "not secret in transit or at the far end" paragraph covers
 * this line too.
 */
const sshSetupLines = (
  url: string,
  privateKey: string,
  dial?: CheckedDial | null,
): string[] => {
  const parsed = parseSshUrl(url);
  const { domain, port } = dial
    ? { domain: dial.address, port: dial.port }
    : parsed;
  const portFlag = port ? ` -p ${port}` : '';
  return [
    `${SSH_DIR}=$(mktemp -d); export ${SSH_DIR};`,
    `trap 'rm -rf "$${SSH_DIR}"' EXIT; trap 'exit 1' HUP INT TERM;`,
    `echo "${encodeBase64(`${privateKey}\n`)}" | base64 -d > ${KEY_PATH};`,
    `chmod 600 ${KEY_PATH};`,
    `if ! ssh-keyscan -p ${port ?? 22} ${quote([domain ?? ''])} 2>/dev/null >> ${KNOWN_HOSTS_PATH}; then`,
    `  echo ${quote([`ssh-keyscan read no host key from ${domain ?? ''}:${port ?? 22}, so ssh will accept the key the host presents.`])} >&2;`,
    'fi',
    `export GIT_SSH_COMMAND='ssh -i ${KEY_PATH}${portFlag}${hostNameOption(dial)} -o UserKnownHostsFile=${KNOWN_HOSTS_PATH} -o StrictHostKeyChecking=accept-new';`,
  ];
};

/**
 * What holds an ssh clone to the address its host was checked at:
 * `HostName` makes ssh connect there instead of looking the name git hands it
 * up again, which is the lookup a rebind would answer, and the keyscan above
 * reads the same address, so `known_hosts` is keyed by what ssh connects to.
 * Command-line options come before every config file, and the first value ssh
 * obtains is the one it uses.
 *
 * The address goes into a single-quoted `GIT_SSH_COMMAND` bare, so it is
 * refused unless it is an IP literal, which carries no quote.
 */
const hostNameOption = (dial?: CheckedDial | null): string => {
  if (!dial) return '';
  if (isIP(dial.address) === 0) {
    throw new Error(`A checked dial needs an address, not ${dial.address}`);
  }
  return ` -o HostName=${dial.address}`;
};

/**
 * An ssh clone or listing, run in a subshell of its own so that the `EXIT`
 * trap {@link sshSetupLines} sets removes the key directory when *this* git
 * command ends, on success, on a failed clone's `exit 1` and on a `set -e`
 * abort alike, and replaces no trap of the deploy program it is part of.
 * `GIT_SSH_COMMAND` ends with it too.
 */
const withSshKey = (
  url: string,
  privateKey: string,
  lines: readonly string[],
  dial?: CheckedDial | null,
): string[] => ['(', ...sshSetupLines(url, privateKey, dial), ...lines, ')'];

/**
 * Generic (custom) git over http(s)/ssh.
 *
 * `customGitUrl` and `customGitBranch` are unvalidated columns and are quoted
 * rather than refused: a URL legitimately carries `:` and `?`, so the
 * `SHELL_UNSAFE` refusal `patch-repo.service.ts` uses for a browsable path
 * would reject working repositories (see `BuildStrategy` for the rule).
 */
export const gitStrategy: GitProviderStrategy = {
  sourceType: 'git',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { url, branch, outputPath, sshKey, enableSubmodules } = input;
    const lines = ['set -e;'];

    if (!url || !branch) {
      lines.push('echo "Error: ❌ Repository not found"; exit 1;');
      return sourceProgram(lines.join('\n'));
    }

    if (!isHttpOrHttps(url)) {
      if (!sshKey) {
        lines.push(
          'echo "Error: ❌ You are trying to clone a ssh repository without a ssh key, please set a ssh key"; exit 1;',
        );
        return sourceProgram(lines.join('\n'));
      }
    }

    const clone = gitCloneLines({
      label: withoutUserinfo(url),
      cloneUrl: url,
      branch,
      outputPath,
      enableSubmodules,
      dial: input.dial,
    });
    lines.push(
      ...(sshKey && !isHttpOrHttps(url)
        ? withSshKey(url, sshKey.privateKey, clone, input.dial)
        : clone),
    );
    return sourceProgram(lines.join('\n'));
  },

  listBranches(input): string {
    const { url, sshKey } = input;
    const lsRemote = `git -c protocol.file.allow=never ls-remote --heads -- ${quote([url ?? ''])}`;
    if (!url || isHttpOrHttps(url) || !sshKey) {
      return lsRemote;
    }
    return ['set -e;', ...withSshKey(url, sshKey.privateKey, [lsRemote])].join(
      '\n',
    );
  },

  getCommitInfo(input): string {
    return `git -C ${quote([input.outputPath])} log -1 --pretty=format:"%H---DELIMITER---%B"`;
  },
};
