import { quote } from 'shell-quote';
import type { DeployableAiModel } from '../deployment-engine/deployment-engine.types';
import { execOnServer } from '../remote/exec-dispatch';
import { ExecError } from '../remote/exec-error';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { INFERENCE_RUNTIMES } from './inference-runtime';

/** How many lines of the runtime's own answer a failure carries. */
const REASON_LINES = 3;

/**
 * The program that makes an AI model ready, run on its run Server once the
 * release has converged: its runtime's readiness command, in a
 * running task of `appName`. For Ollama that is the pull of the facet's
 * model, so the AI model is ready when the pull has finished; for vLLM and
 * llama.cpp it is `GET /health`, which answers once the model is loaded.
 *
 * The output is held back and only its tail is printed, on stderr, on
 * failure: a pull prints progress for every layer, and the reason is the
 * last thing it says. `appName` and the command words are `quote()`d, though
 * `APP_NAME_REGEX` and the model grammar already narrow both.
 */
export function readinessProgram(
  appName: string,
  facet: DeployableAiModel,
): string {
  const runtime = INFERENCE_RUNTIMES[facet.runtime];
  const command = runtime.readinessCommand(facet.model);
  return [
    ...findRunningTask(
      appName,
      `${runtime.readinessWords.doing.toLowerCase()} into`,
    ),
    `out=$(docker exec "$CONTAINER_ID" ${quote(command)} 2>&1) || { printf '%s\\n' "$out" | tail -n ${REASON_LINES} >&2; exit 1; }`,
  ].join('\n');
}

/**
 * The lines that put a running task of `appName` in `$CONTAINER_ID`, or fail
 * saying there is none to `doWhat` — shared by the readiness pull and the
 * prune (`weights-volume.ts`), which ask the same task.
 */
export function findRunningTask(appName: string, doWhat: string): string[] {
  const filter = quote([`label=com.docker.swarm.service.name=${appName}`]);
  return [
    `CONTAINER_ID=$(docker ps -q --filter status=running --filter ${filter} | head -n 1)`,
    `if [ -z "$CONTAINER_ID" ]; then echo ${quote([`no running task of ${appName} to ${doWhat}`])} >&2; exit 1; fi`,
  ];
}

/**
 * Runs {@link readinessProgram} on the run Server, answering when the model
 * is ready and throwing an `Error` whose message is the reason when it is
 * not — which the deploy writes into the Deployment log and fails the
 * Deployment with.
 */
export async function awaitModelReady(
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
  facet: DeployableAiModel,
): Promise<void> {
  try {
    await execOnServer(remoteExec, serverId, readinessProgram(appName, facet));
  } catch (error) {
    const said =
      error instanceof ExecError
        ? (error.stderr ?? '').trim() || error.message
        : error instanceof Error
          ? error.message
          : String(error);
    const { doing } = INFERENCE_RUNTIMES[facet.runtime].readinessWords;
    throw new Error(
      `❌ [Model] ${doing} '${facet.model}' failed, so the AI model is not ready: ${said}`,
    );
  }
}
