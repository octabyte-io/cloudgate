import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { readGpuCounts } from '../settings/gpu-counts';

/**
 * Whether an Application is waiting for a GPU, and on how many of its run
 * Server's cards. `free` and `cards` are the counts-only read's.
 */
export type GpuWait =
  { waiting: false } | { waiting: true; free: number; cards: number };

/**
 * The Application's tasks Swarm wants running, one JSON object per line.
 * Argv, so `appName` and the Go template need no quoting.
 */
export const gpuWaitTasksArgv = (appName: string): string[] => [
  'docker',
  'service',
  'ps',
  appName,
  '--no-trunc',
  '--filter',
  'desired-state=running',
  '--format',
  '{{json .}}',
];

/**
 * Whether any task in a `docker service ps --format '{{json .}}'` listing is
 * `Pending` because no node can take it — what Swarm says of a task whose GPU
 * reservation no node can meet. A line that does not parse counts as not.
 */
export function anyTaskStarved(stdout: string): boolean {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      let parsed: { CurrentState?: unknown; Error?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return false;
      }
      return (
        typeof parsed.CurrentState === 'string' &&
        /^pending\b/i.test(parsed.CurrentState) &&
        typeof parsed.Error === 'string' &&
        parsed.Error.includes('no suitable node')
      );
    });
}

/**
 * The live read behind "Waiting for a GPU: this Server has N free of M" on an
 * Application's Overview: outside a deploy — a reboot, a lost card —
 * Swarm leaves a GPU-reserving task `Pending` with "no suitable node", and
 * nothing else would say why the Application is not running.
 *
 * Only for an Application reserving a GPU; one reserving none reads nothing.
 * It is not a Deployment and writes nothing. A machine that cannot be read
 * answers "not waiting": this is an explanation, never a verdict, and the
 * Overview has its own word for a Server it cannot reach.
 */
export async function readGpuWait(
  remoteExec: RemoteExecService,
  app: { appName: string; serverId: string | null; gpus: number },
): Promise<GpuWait> {
  if (app.gpus < 1) return { waiting: false };
  try {
    const { stdout } = await execOnServer(
      remoteExec,
      app.serverId,
      gpuWaitTasksArgv(app.appName),
    );
    if (!anyTaskStarved(stdout)) return { waiting: false };
    const { counts } = await readGpuCounts(remoteExec, app.serverId);
    return { waiting: true, free: counts.free, cards: counts.cards };
  } catch {
    return { waiting: false };
  }
}
