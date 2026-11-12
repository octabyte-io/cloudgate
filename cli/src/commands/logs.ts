import {
  deploymentSchema,
  runtimeLogPlaceSchema,
  runtimeLogReadSchema,
  serviceDeploymentListSchema,
} from 'api-schemas';

import type { Command, CommandContext } from '../command.js';
import { deploymentLogFollower } from '../deployment-log-stream.js';
import { watchDeployment } from '../deployment-watch.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import type { ExitCode } from '../exit-codes.js';
import { readCloudRuntimeLog, readServerRuntimeLog } from '../runtime-log.js';
import { kindLabel, kindRefusal } from '../service-status.js';
import { withInterrupts } from '../stopping.js';
import { TARGET_OPTIONS } from '../target.js';
import { chooserFor, lookUpTarget } from '../target-session.js';
import type { TargetSession } from '../target-session.js';

/** `-n`'s range: the most lines either log route answers in one read. */
const MOST_LINES = 10_000;
const DEFAULT_LINES = 100;

/** The Service kinds with a Deployment history, and its route. */
const DEPLOYMENT_ROUTES: Record<string, string> = {
  application: 'applications',
  compose: 'compose',
};

/**
 * `cloudgate logs [-f] [-n <lines>] [--deployment [id]]` (CLI spec
 * "Logs"): a Service's Runtime log, or one of its Deployment logs. Text only,
 * every log line on stdout and nothing else there, so it pipes into `grep`.
 */
export const logs: Command = {
  name: 'logs',
  group: 'THIS FOLDER',
  summary: "Show the Service's logs",
  help: `Show the Service's Runtime log, or a Deployment log.

USAGE
  cloudgate logs [-f] [-n <lines>] [--deployment [id]]

  Prints the last 100 lines of the Service's Runtime log: what it writes
  while it runs, on a Server or in a Cloud account (there, from the last
  hour at most). -f keeps printing new lines until Ctrl-C.
  With --deployment, prints a Deployment log instead: the latest
  Deployment's, or the one [id] names. With -f it follows that Deployment
  from its first line and ends by itself when the Deployment does.
  Log lines go to stdout and nothing else does. Applications only, except
  that a Compose stack has Deployment logs too.

FLAGS
  -f, --follow           Keep printing new lines
  -n, --lines <lines>    How many of the last lines to print (default 100)
  --deployment [id]      A Deployment log: the latest, or [id]'s
  --org <name|id>        Organization            (CLOUDGATE_ORG)
  --project <name|id>    Project                 (CLOUDGATE_PROJECT)
  --env <name|id>        Environment             (CLOUDGATE_ENV)
  --service <name|id>    Service, by Config name (CLOUDGATE_SERVICE)
  --instance <url>       The Instance to ask     (CLOUDGATE_INSTANCE)
`,
  options: {
    ...TARGET_OPTIONS,
    follow: { type: 'boolean', short: 'f' },
    lines: { type: 'string', short: 'n' },
    // A flag whose value is optional, which `parseArgs` has no word for:
    // `--deployment` alone, and the id as the one positional after it.
    deployment: { type: 'boolean' },
  },
  maxPositionals: 1,
  async run(context) {
    const { out, values, positionals } = context;
    const lines = linesWanted(values.lines);
    const [named] = positionals;
    if (named !== undefined && !values.deployment) {
      throw usageError(
        `cloudgate logs takes no arguments, not "${named}"`,
        `For a Deployment log: cloudgate logs --deployment ${named}`,
      );
    }
    const follow = values.follow === true;
    const session = await lookUpTarget(
      context,
      out.mode.canAsk ? { choose: chooserFor(context.prompter) } : {},
    );
    if (values.deployment) {
      const deploymentId = named ?? (await latestDeployment(session));
      return follow
        ? followDeployment(context, session, deploymentId)
        : printDeploymentLog(context, session, deploymentId, lines);
    }
    return printRuntimeLog(context, session, lines, follow);
  },
};

function linesWanted(value: string | boolean | undefined): number {
  if (value === undefined) return DEFAULT_LINES;
  const lines = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!/^\d+$/.test(String(value)) || lines < 1 || lines > MOST_LINES) {
    throw usageError(
      `-n takes a number of lines from 1 to ${MOST_LINES}, not "${String(value)}"`,
    );
  }
  return lines;
}

/** The Service's newest Deployment; refused when it has none. */
async function latestDeployment(session: TargetSession): Promise<string> {
  const { service } = session.target;
  const route = DEPLOYMENT_ROUTES[service.kind];
  if (!route) {
    throw new CliError(
      `${service.configName} is a ${kindLabel(service.kind)}, which has no Deployments`,
      EXIT.failed,
    );
  }
  const [latest] = await session.client.get(
    `/${route}/${encodeURIComponent(service.id)}/deployments`,
    serviceDeploymentListSchema,
  );
  if (!latest) {
    throw new CliError(
      `${service.configName} has no Deployment yet`,
      EXIT.failed,
      'Deploy it: cloudgate deploy',
    );
  }
  return latest.deploymentId;
}

/** The tail of a Deployment log, as the Instance reads it. */
async function printDeploymentLog(
  context: CommandContext,
  session: TargetSession,
  deploymentId: string,
  lines: number,
): Promise<ExitCode> {
  const text = await session.client.getText(
    `/deployments/${encodeURIComponent(deploymentId)}/logs?tail=${lines}`,
  );
  if (text) context.out.data(text.endsWith('\n') ? text : `${text}\n`);
  return EXIT.ok;
}

/**
 * `--deployment -f`: the Deployment log stream from its first line, until
 * `GET /deployments/:id` says the Deployment finished — the stream never
 * closes by itself (`watchDeployment`, shared with `deploy`). It reports
 * and does not judge: a failed Deployment's log read to its end exits 0.
 */
async function followDeployment(
  context: CommandContext,
  session: TargetSession,
  deploymentId: string,
): Promise<ExitCode> {
  const { out } = context;
  const websocket = session.checked.endpoints.websocket;
  if (!websocket) throw noStreamAddress();
  let endsInNewline = true;
  const result = await withInterrupts(context.interrupts, (signal) =>
    watchDeployment({
      read: () =>
        session.client.get(
          `/deployments/${encodeURIComponent(deploymentId)}`,
          deploymentSchema,
        ),
      follow: deploymentLogFollower({
        open: context.openSocket,
        websocket,
        deploymentId,
        headers: session.client.socketHeaders(),
      }),
      onText: (text) => {
        if (!text) return;
        out.data(text);
        endsInNewline = text.endsWith('\n');
      },
      sleep: context.sleep,
      signal,
    }),
  );
  if (!endsInNewline) out.data('\n');
  if (result.kind === 'interrupted') return EXIT.interrupted;
  const word =
    result.deployment.status === 'error' ? 'failed' : result.deployment.status;
  out.note(`Deployment ${deploymentId} ${word}`);
  return EXIT.ok;
}

/**
 * The Runtime log, wherever the Service runs: a Cloud account's over REST,
 * a Server's (or the platform host's) over the container-logs socket.
 */
async function printRuntimeLog(
  context: CommandContext,
  session: TargetSession,
  lines: number,
  follow: boolean,
): Promise<ExitCode> {
  const { out } = context;
  const { service } = session.target;
  const wrongKind = kindRefusal(service, 'logs');
  if (wrongKind) throw wrongKind;
  const base = `/applications/${encodeURIComponent(service.id)}`;
  const place = await session.client.get(base, runtimeLogPlaceSchema);
  const onText = (text: string) => {
    if (text) out.data(text);
  };
  const end = await withInterrupts(context.interrupts, async (signal) => {
    if (place.cloudAccountId) {
      return readCloudRuntimeLog({
        read: (since) =>
          session.client.get(
            `${base}/runtime-log${since === undefined ? '' : `?since=${since}`}`,
            runtimeLogReadSchema,
          ),
        lines,
        follow,
        onText,
        sleep: context.sleep,
        signal,
      });
    }
    const websocket = session.checked.endpoints.websocket;
    if (!websocket) throw noStreamAddress();
    const ended = await readServerRuntimeLog({
      open: context.openSocket,
      websocket,
      headers: session.client.socketHeaders(),
      appName: place.appName,
      serverId: place.serverId ?? null,
      lines,
      follow,
      onText,
      signal,
    });
    if (ended === 'ended' && follow) {
      out.note(
        "The Service's output ended: it was stopped, removed or could not be read.",
      );
    }
    return ended;
  });
  return end === 'interrupted' ? EXIT.interrupted : EXIT.ok;
}

function noStreamAddress(): CliError {
  return new CliError(
    'this Instance names no address for its log streams',
    EXIT.failed,
    'Its operator sets one with CLOUDGATE_API_URL.',
  );
}
