import { quote } from 'shell-quote';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import {
  DOCKER_DEFAULT_RUNTIME_COMMAND,
  DOCKER_RUNTIMES_COMMAND,
  RUNTIME_TOML_ARGV,
} from '../../src/settings/gpu-runtime';

/**
 * The machine's side of `readRuntimeConfigured`, which every spec that
 * admits a GPU reservation has to answer: the save, the deploy, a Rollback
 * and a Start all read it. Four specs had grown their own copy of the same
 * three answers; §1.7 puts the one copy beside the feature that reads it.
 */

/**
 * What the NVIDIA runtime's `config.toml` holds: `swarm-resource` at top
 * level, where the runtime reads it, or inside the last table, where GPU setup
 * before the fix appended it and the runtime ignores it.
 */
export const RUNTIME_TOML = {
  configured:
    'disable-require = false\nswarm-resource = "DOCKER_RESOURCE_GPU"\n\n[nvidia-ctk]\npath = "nvidia-ctk"\n',
  theOldWay:
    'disable-require = false\n\n[nvidia-ctk]\npath = "nvidia-ctk"\nswarm-resource = "DOCKER_RESOURCE_GPU"\n',
} as const;

const answer = (stdout: string): Promise<ExecResult> =>
  Promise.resolve({ stdout, stderr: '', exitCode: 0 });

/**
 * A GPU machine's answer to one of the runtime read's three commands: Docker
 * knows the `nvidia` runtime and starts containers with it, and `config.toml`
 * is `toml` — `null` fails the read, as an unreadable file does. `undefined`
 * for any other command, so the double falls through to its own answers.
 *
 * `command` is what the double sees: a string, as `withArgvExec` words an
 * argv, or the argv itself, for a spec that stubs `execRemote` directly.
 */
export function nvidiaRuntimeAnswer(
  command: string | readonly string[],
  toml: string | null = RUNTIME_TOML.configured,
): Promise<ExecResult> | undefined {
  const line = typeof command === 'string' ? command : quote([...command]);
  if (line === DOCKER_RUNTIMES_COMMAND) {
    return answer(
      '{"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}\n',
    );
  }
  if (line === DOCKER_DEFAULT_RUNTIME_COMMAND) return answer('nvidia\n');
  if (line === quote(RUNTIME_TOML_ARGV)) {
    return toml === null
      ? Promise.reject(new Error('cat: Permission denied'))
      : answer(toml);
  }
  return undefined;
}
