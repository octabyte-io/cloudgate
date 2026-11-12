import { Logger } from '@nestjs/common';

import { execByServer } from '../docker-ops/server-access';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { GPU_CONFIG_FILES, swarmResourceAtTopLevel } from './gpu-setup-script';

const logger = new Logger('GpuRuntime');

/** The runtimes Docker knows, as JSON. */
export const DOCKER_RUNTIMES_COMMAND =
  'docker info --format "{{json .Runtimes}}"';
/** The runtime Docker starts a container with when nothing names one. */
export const DOCKER_DEFAULT_RUNTIME_COMMAND =
  'docker info --format "{{.DefaultRuntime}}"';
/** The NVIDIA runtime's own config, where `swarm-resource` has to sit. */
export const RUNTIME_TOML_ARGV = ['cat', GPU_CONFIG_FILES.runtimeToml];

/**
 * Whether the machine's NVIDIA runtime hands a task the card Swarm assigned
 * it: Docker has the `nvidia` runtime, uses it by default, and its
 * `config.toml` sets `swarm-resource` at top level. The one reading
 * behind both the GPU card's "runtime configured" and the GPU reservation
 * refusal, so the two cannot disagree.
 *
 * A machine whose answer cannot be read — a command fails, or Docker's JSON
 * does not parse — reads as not configured, as the GPU card has always read
 * it: a reservation there is refused rather than started on a task that may
 * never get its card (ADR-0039). The three reads go out together, since each
 * is its own round trip to a Server.
 */
export async function readRuntimeConfigured(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
): Promise<boolean> {
  try {
    const [runtimes, defaultRuntime, runtimeToml] = await Promise.all([
      execByServer(remoteExec, serverId, DOCKER_RUNTIMES_COMMAND),
      execByServer(remoteExec, serverId, DOCKER_DEFAULT_RUNTIME_COMMAND),
      execByServer(remoteExec, serverId, RUNTIME_TOML_ARGV),
    ]);
    const known = JSON.parse(runtimes.stdout) as Record<string, unknown>;
    return (
      'nvidia' in known &&
      defaultRuntime.stdout.trim() === 'nvidia' &&
      swarmResourceAtTopLevel(runtimeToml.stdout)
    );
  } catch (error) {
    logger.debug(`Runtime configuration check: ${String(error)}`);
    return false;
  }
}
