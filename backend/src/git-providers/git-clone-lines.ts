import { isIP } from 'node:net';
import { quote } from 'shell-quote';
import type { CloneDial } from './git-clone-url';

/**
 * The line a clone adds after git's own when the server asked for credentials.
 * git's words for it — `could not read Username for '…': terminal prompts
 * disabled` — read like a device fault, and the cause is that a URL carrying no
 * credential reached a repository that is private or does not exist.
 */
export const CREDENTIALS_PROMPT_HINT =
  'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.';

/**
 * Where a clone on the platform host was checked to go: the host and port
 * {@link CloneDial} read out of the URL, and the public address
 * `OutboundAddressGuard.addressToDial` checked that host at. Set only for a
 * clone held to that address — on the platform host, for an Organization other
 * than the instance organization (ADR-0013).
 */
export interface CheckedDial extends CloneDial {
  readonly address: string;
}

/**
 * The `-c` options that make git's curl dial `dial.address` and nothing else:
 * `http.curloptResolve` hands curl the address for the URL's host and port, so
 * it makes no lookup of its own for a rebind to answer differently (git
 * 2.37+; Ubuntu 24.04, which `deploy/install.sh` installs on, ships 2.43),
 * and `http.followRedirects=false` stops a checked server sending git on to
 * one nobody checked — git's default follows the first request's redirect.
 * An IP literal has nothing to resolve, so it gets only the second.
 *
 * Throws on an address that is not one, rather than writing a word curl would
 * read as a name.
 */
export function pinnedHttpOptions(dial: CheckedDial): string[] {
  const family = isIP(dial.address);
  if (family === 0) {
    throw new Error(`A checked dial needs an address, not ${dial.address}`);
  }
  const address = family === 6 ? `[${dial.address}]` : dial.address;
  return [
    ...(isIP(dial.host) === 0
      ? [`http.curloptResolve=${dial.host}:${dial.port}:${address}`]
      : []),
    'http.followRedirects=false',
  ];
}

export interface GitCloneStep {
  /** What the log calls the repository. */
  readonly label: string;
  /** What git is handed, which for a provider carries its token. */
  readonly cloneUrl: string;
  readonly branch: string;
  readonly outputPath: string;
  readonly enableSubmodules?: boolean;
  /**
   * The checked address an http(s) clone is pinned to, when it is held to one;
   * see {@link pinnedHttpOptions}. An ssh clone is pinned in its
   * `GIT_SSH_COMMAND` instead (`git.strategy.ts`).
   */
  readonly dial?: CheckedDial | null;
}

/**
 * The clone step every git-backed strategy ends with: announce it, clone,
 * and only then say it succeeded — a ✅ printed before `git clone` ran
 * sat green above the error of a clone that failed.
 *
 * `GIT_TERMINAL_PROMPT=0` makes a credentials challenge fail at once with
 * `terminal prompts disabled` rather than trying a terminal the build has not
 * got. git's output goes through `tee` so it still streams into the log as it
 * is written and can be searched for that phrase afterwards; the failure is
 * carried out of the pipeline in a marker file, since a POSIX pipeline reports
 * only its last command's status. The provider strategies put a token in the
 * URL, so git never prompts there and the hint only ever fires for the plain
 * git source.
 *
 * Every value word is `quote()`d per `GitProviderStrategy`'s rule. `--` ends
 * git's options before the URL and the directory, so neither is read as one
 * whatever it starts with, and `protocol.file.allow=never` refuses a local
 * repository (a `file://` URL, a bare path, a submodule pointing at either) as
 * a source: on the Hosted instance the clone runs on the platform host, where
 * every tenant's checkout is on the same disk. No Self-hosted doc relies on
 * cloning from a local path, so the rule is the same in both modes.
 */
export const gitCloneLines = ({
  label,
  cloneUrl,
  branch,
  outputPath,
  enableSubmodules,
  dial,
}: GitCloneStep): string[] => {
  const submodules = enableSubmodules ? ' --recurse-submodules' : '';
  const pinned =
    dial && dial.transport === 'http'
      ? pinnedHttpOptions(dial)
          .map((option) => ` -c ${quote([option])}`)
          .join('')
      : '';
  return [
    `rm -rf ${quote([outputPath])};`,
    `mkdir -p ${quote([outputPath])};`,
    `echo ${quote([`Cloning repo ${label} to ${outputPath}`])};`,
    'cg_clone=$(mktemp -d);',
    `{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never${pinned} clone --branch ${quote([branch])} --depth 1${submodules} --progress -- ${quote([cloneUrl])} ${quote([outputPath])} 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";`,
    'if [ -e "$cg_clone/failed" ]; then',
    `  if grep -q 'terminal prompts disabled' "$cg_clone/output"; then echo ${quote([CREDENTIALS_PROMPT_HINT])}; fi;`,
    '  rm -rf "$cg_clone";',
    `  echo ${quote([`❌ Failed to clone repository ${label}`])};`,
    '  exit 1;',
    'fi',
    'rm -rf "$cg_clone";',
    `echo ${quote([`✅ Cloned repo ${label}`])};`,
  ];
};
