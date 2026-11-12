import { quote } from 'shell-quote';
import { nodeGenericResources } from './gpu-setup-state';

/**
 * What GPU setup writes on a Server: Docker's `daemon.json` and the NVIDIA
 * runtime's `config.toml`.
 *
 * - **`daemon.json` is merged, not replaced.** Setup reads what is there and
 *   sets only `default-runtime`, `node-generic-resources` and an `nvidia`
 *   runtime when none is declared, so an operator's `default-shm-size` or
 *   `default-ulimits` survive it. The merge is done here rather than on the
 *   Server because a Server is not promised `jq` or `python3`.
 * - **`swarm-resource` is a top-level key of `config.toml`.** Appended, it
 *   lands in whichever table ends the file — `[nvidia-ctk]` on toolkit
 *   1.20.1 — where the runtime ignores it, and Swarm assigns a card that the
 *   container never gets. So it is written before the first table, with
 *   `awk`, which every Server has; `nvidia-ctk` is not assumed.
 */
export const GPU_CONFIG_FILES = {
  daemonJson: '/etc/docker/daemon.json',
  runtimeToml: '/etc/nvidia-container-runtime/config.toml',
};
export type GpuConfigFiles = typeof GPU_CONFIG_FILES;

export const SWARM_RESOURCE_LINE = 'swarm-resource = "DOCKER_RESOURCE_GPU"';

const TABLE_HEADER = /^\s*\[/;
const SWARM_RESOURCE_SET =
  /^\s*swarm-resource\s*=\s*(["'])DOCKER_RESOURCE_GPU\1\s*(#.*)?$/;

/**
 * Whether `config.toml` sets `swarm-resource = "DOCKER_RESOURCE_GPU"` at top
 * level, before any table — the only place the runtime reads it. A Server set
 * up by an older version has it inside the last table and reads as not
 * configured, so it is set up again.
 */
export function swarmResourceAtTopLevel(toml: string): boolean {
  for (const line of toml.split('\n')) {
    if (TABLE_HEADER.test(line)) return false;
    if (SWARM_RESOURCE_SET.test(line)) return true;
  }
  return false;
}

/**
 * `daemon.json` once setup has merged into it: the three keys setup owns, and
 * whatever else the operator put there, untouched.
 */
export type DaemonConfig = Record<string, unknown> & {
  runtimes: Record<string, unknown>;
  'default-runtime': 'nvidia';
  'node-generic-resources': string[];
};

/**
 * `daemon.json` as it is (`''` when there is none) with these cards advertised
 * and the nvidia runtime made Docker's default. Every other key is kept.
 * Refuses a file that is not a JSON object rather than overwriting it.
 */
export function mergeDaemonConfig(
  existing: string,
  cardIds: string[],
): DaemonConfig {
  let current: unknown = {};
  if (existing.trim()) {
    try {
      current = JSON.parse(existing);
    } catch {
      current = undefined;
    }
  }
  if (!isObject(current)) {
    throw new Error(
      `${GPU_CONFIG_FILES.daemonJson} is not a JSON object, so GPU setup cannot keep what it holds; fix or remove it and run setup again`,
    );
  }

  const runtimes = isObject(current.runtimes) ? current.runtimes : {};
  return {
    ...current,
    runtimes: {
      ...runtimes,
      // An `nvidia` runtime already declared (`nvidia-ctk runtime configure`
      // writes one) is the operator's and is kept.
      nvidia: runtimes.nvidia ?? {
        path: 'nvidia-container-runtime',
        runtimeArgs: [],
      },
    },
    'default-runtime': 'nvidia',
    'node-generic-resources': nodeGenericResources(cardIds),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The POSIX `sh` that writes both files, run as root. `daemonConfig` is
 * {@link mergeDaemonConfig}'s answer; its JSON goes in through a quoted
 * heredoc, so nothing in it is expanded. Running it twice leaves the same
 * files.
 */
export function writeGpuConfigScript(
  daemonConfig: DaemonConfig,
  files: GpuConfigFiles = GPU_CONFIG_FILES,
): string {
  const daemonJson = quote([files.daemonJson]);
  const toml = quote([files.runtimeToml]);
  const staged = quote([`${files.runtimeToml}.cloudgate`]);
  return [
    'set -e',
    `cat > ${daemonJson} <<'CLOUDGATE_DAEMON_JSON'`,
    JSON.stringify(daemonConfig, null, 2),
    'CLOUDGATE_DAEMON_JSON',
    `mkdir -p "$(dirname ${toml})"`,
    `[ -f ${toml} ] || : > ${toml}`,
    // Drop every `swarm-resource` key wherever it sits, then put one back
    // before the first table (or at the end of a file with none).
    `awk -v line=${quote([SWARM_RESOURCE_LINE])} '`,
    '  /^[ \\t]*swarm-resource[ \\t]*=/ { next }',
    '  !done && /^[ \\t]*\\[/ { print line; done = 1 }',
    '  { print }',
    '  END { if (!done) print line }',
    `' ${toml} > ${staged}`,
    `cat ${staged} > ${toml}`,
    `rm -f ${staged}`,
  ].join('\n');
}

const ROOT_PROGRAM_END = 'CLOUDGATE_GPU_SETUP';

/**
 * `script` run by `sh` as root, with the script on `sudo sh -s`'s stdin as a
 * quoted heredoc rather than as `sudo sh -c <quoted script>`. The script holds
 * single quotes (the heredoc delimiter, the `awk` program, and any an
 * operator's `daemon.json` has), and for such a string `quote()` falls back to
 * double quotes with `!` escaped as `\!` — which POSIX `sh` keeps verbatim
 * inside double quotes, so `awk` would read `\!done` and a `!` in a
 * `daemon.json` value would come back as `\!`. A quoted heredoc passes every
 * byte as it is. No step of the script reads stdin, which here is the script.
 */
export function asRootProgram(script: string): string {
  if (script.split('\n').includes(ROOT_PROGRAM_END)) {
    throw new Error(
      `A GPU setup script cannot hold a line ${ROOT_PROGRAM_END}`,
    );
  }
  return [`sudo sh -s <<'${ROOT_PROGRAM_END}'`, script, ROOT_PROGRAM_END].join(
    '\n',
  );
}
