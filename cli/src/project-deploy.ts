import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  configSourcesSchema,
  environmentWithServicesSchema,
} from 'api-schemas';
import type { ConfigSources, DeploymentView } from 'api-schemas';

import type { CommandContext } from './command.js';
import {
  deploymentsPage,
  noteLeftOut,
  shownFolder,
  startDeployment,
  stoppedWatching,
  tookFor,
  untilNoBuildInProgress,
  uploadFiles,
  watchBuild,
} from './deploy-steps.js';
import { CliError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { WORKING_COPY_FILE } from './folder-link.js';
import { runPlanStep } from './plan-step.js';
import { resolveProjectTarget, targetInputs } from './target.js';
import type { ProjectTarget, Target } from './target.js';
import {
  connectToInstance,
  describeTarget,
  instanceCatalog,
} from './target-session.js';
import type { Connection, TargetSession } from './target-session.js';
import { selectUploadFiles } from './upload-files.js';
import type { FoundProjectFolder } from './working-copy.js';

/**
 * `cloudgate deploy` in a **Project folder** (ADR-0080): the plan step of
 * `cloudgate config plan` first, then the whole folder uploaded to every app
 * whose config entry names a subfolder of it as its source, with that
 * subfolder as the upload's build path, each built and followed to its end.
 * Apps from a repository or an image, console-managed entries, databases and
 * buckets are listed as skipped, and nothing is sent to them.
 */

type ConfigEntry = ConfigSources['services'][number];

/** An app the run builds: its entry and, once found, its Application. */
interface Build {
  entry: ConfigEntry & { folder: string };
  session: TargetSession | null;
}

/** How each app's part of the run ended, for the line it gets at the end. */
type Ending =
  | { kind: 'ended'; deployment: DeploymentView }
  | { kind: 'queued'; deployment: DeploymentView }
  | { kind: 'missing' };

const DATABASE_KINDS = new Set([
  'postgres',
  'mysql',
  'redis',
  'mongo',
  'mariadb',
  'libsql',
]);

/** Why a root deploy leaves an entry alone, as its line says it. */
function skipReason(entry: ConfigEntry): string {
  switch (entry.source) {
    case 'repository':
      return 'built from a repository';
    case 'image':
      return 'runs an image';
    case 'console':
      return 'console-managed';
    default:
      if (DATABASE_KINDS.has(entry.kind)) return 'a database';
      if (entry.kind === 'bucket') return 'a bucket';
      return 'names no source';
  }
}

/**
 * `connected` is the run's connection when it already has one, as a first
 * `deploy` that has just made the folder a Project folder does.
 */
export async function deployProjectFolder(
  context: CommandContext,
  project: FoundProjectFolder,
  connected?: Connection,
): Promise<ExitCode> {
  const { out, values } = context;
  const { link, folder } = project;
  const connection = connected ?? (await connectToInstance(context, project));
  const inputs = targetInputs({ values, env: context.env, link });
  const where = await out.withSpinner(
    `Looking up the Project on ${connection.instance.url}…`,
    () => resolveProjectTarget(inputs, instanceCatalog(connection.client)),
  );
  if (where.project.id !== link.projectId) {
    throw usageError(
      `this Project folder is linked to Project ${link.names.project}, not ${where.project.name}`,
      'Run cloudgate deploy here without --org or --project.',
    );
  }
  const client = connection.client.inOrganization(
    where.organization.id,
    where.organization.name,
  );

  const plan = await runPlanStep(context, client, project, {
    yes: values.yes === true,
  });
  if (plan.kind === 'declined') {
    out.note('Nothing was uploaded.');
    return EXIT.failed;
  }

  const environmentPath = `/environments/${encodeURIComponent(where.environment.id)}`;
  const sources = await client.get(
    `${environmentPath}/config/sources`,
    configSourcesSchema,
  );
  if (!sources.readable) {
    throw new CliError(
      'the Project config could not be read, so nothing was uploaded',
      EXIT.failed,
    );
  }
  const entries = chosenEntries(sources.services, inputs.service?.value);
  const builds = entries.flatMap((entry) =>
    entry.source === 'folder' && entry.folder !== null
      ? [{ ...entry, folder: entry.folder }]
      : [],
  );
  const skipped = entries.filter((entry) => entry.source !== 'folder');

  // Every subfolder is checked before anything is uploaded.
  for (const entry of builds) {
    const path = join(folder, entry.folder);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new CliError(
        `${entry.configName} builds from ${entry.folder}, which is not a folder in this Project folder`,
        EXIT.failed,
        `Make ${entry.folder}, or change ${entry.configName}'s source in ${WORKING_COPY_FILE}.`,
      );
    }
  }
  if (builds.length === 0) {
    out.note('No app in the Project config is built from this folder.');
    out.note(
      `  Give one source: { folder: <subfolder> } in ${WORKING_COPY_FILE} to build it from here.`,
    );
    for (const entry of skipped) {
      out.note(`- ${entry.configName}: skipped, ${skipReason(entry)}`);
    }
    return plan.kind === 'applied' && plan.failed > 0 ? EXIT.failed : EXIT.ok;
  }

  const { services } = await client.get(
    environmentPath,
    environmentWithServicesSchema,
  );
  const sessions: Build[] = builds.map((entry) => {
    const service = services.find(
      (one) =>
        one.configName === entry.configName &&
        one.serviceType === 'application',
    );
    return {
      entry,
      session: service
        ? {
            ...connection,
            link: project,
            client,
            target: targetOf(where, {
              id: service.serviceId,
              configName: service.configName,
              name: service.name,
              kind: service.serviceType,
            }),
          }
        : null,
    };
  });

  const selection = selectUploadFiles(folder);
  noteLeftOut(out, selection);
  const shown = shownFolder(context.cwd, folder);
  const queued = new Map<string, DeploymentView>();
  for (const { entry, session } of sessions) {
    if (!session) continue;
    out.note(
      `Deploying ${describeTarget(shown, session.target, connection.instance.url)}, built from ${entry.folder}`,
    );
    // Each app waits for its own build, as a deploy of one Service does.
    const waited = await untilNoBuildInProgress(context, session);
    if (waited !== undefined) return waited;
    const stopped = await uploadFiles(
      context,
      session,
      folder,
      selection.files,
      { full: values.full === true, buildPath: entry.folder },
    );
    if (stopped !== undefined) return stopped;
    const started = await startDeployment(
      session.client,
      session.target.service.id,
      out,
    );
    out.note(`Deployment ${started.deploymentId} queued`);
    queued.set(entry.configName, started);
  }

  const endings = new Map<string, Ending>();
  if (values.detach) {
    for (const [name, deployment] of queued) {
      endings.set(name, { kind: 'queued', deployment });
    }
  } else {
    for (const { entry, session } of sessions) {
      const started = queued.get(entry.configName);
      if (!session || !started) continue;
      const result = await watchBuild(context, session, started.deploymentId);
      if (result.kind === 'interrupted') {
        stoppedWatching(
          out,
          started.deploymentId,
          deploymentsPage(connection.instance.url, session.target.service.id),
        );
        return EXIT.interrupted;
      }
      endings.set(entry.configName, {
        kind: 'ended',
        deployment: result.deployment,
      });
    }
  }
  for (const { entry, session } of sessions) {
    if (!session) endings.set(entry.configName, { kind: 'missing' });
  }

  if (values.detach) {
    printQueued(context, connection.instance.url, sessions, endings);
  }
  let allDone = plan.kind !== 'applied' || plan.failed === 0;
  for (const { entry } of sessions) {
    const ending = endings.get(entry.configName);
    if (!ending) continue;
    if (ending.kind === 'missing') {
      allDone = false;
      out.note(
        `✗ ${entry.configName}: not in ${where.environment.name}, so nothing was built`,
      );
    } else if (ending.kind === 'ended') {
      if (ending.deployment.status !== 'done') allDone = false;
      out.note(endingLine(entry.configName, ending.deployment));
    }
  }
  for (const entry of skipped) {
    out.note(`- ${entry.configName}: skipped, ${skipReason(entry)}`);
  }
  return allDone ? EXIT.ok : EXIT.failed;
}

/**
 * The entries a run deploys: every one, or with `--service` (or
 * `CLOUDGATE_SERVICE`) the one it names, by Config name ignoring case; that
 * one must be built from this folder.
 */
function chosenEntries(
  entries: readonly ConfigEntry[],
  wanted: string | undefined,
): readonly ConfigEntry[] {
  if (wanted === undefined) return entries;
  const named = entries.find(
    (entry) => entry.configName.toLowerCase() === wanted.toLowerCase(),
  );
  if (!named) {
    throw new CliError(
      `no app with Config name "${wanted}" in the Project config`,
      EXIT.failed,
      `Its entries: ${entries.map((entry) => entry.configName).join(', ') || 'none'}.`,
    );
  }
  if (named.source !== 'folder') {
    throw new CliError(
      `${named.configName} is not built from this Project folder (${skipReason(named)})`,
      EXIT.failed,
      `Only an app whose source in ${WORKING_COPY_FILE} is a folder (source: { folder: <subfolder> }) is deployed from here.`,
    );
  }
  return [named];
}

function targetOf(where: ProjectTarget, service: Target['service']): Target {
  return { ...where, service };
}

/** The line an app's finished build gets at the end. */
function endingLine(name: string, deployment: DeploymentView): string {
  const { deploymentId, status } = deployment;
  const took = tookFor(deployment);
  if (status === 'done') {
    return `✓ ${name}: Deployment ${deploymentId} done${took ? ` in ${took}` : ''}`;
  }
  if (status === 'cancelled') {
    return `✗ ${name}: Deployment ${deploymentId} was cancelled`;
  }
  return `✗ ${name}: Deployment ${deploymentId} failed${took ? ` after ${took}` : ''}; its log: cloudgate logs --deployment ${deploymentId}`;
}

/** `--detach`: each queued Deployment, as a table or, with `--json`, JSON. */
function printQueued(
  context: CommandContext,
  instance: string,
  sessions: readonly Build[],
  endings: ReadonlyMap<string, Ending>,
): void {
  const rows = sessions.flatMap(({ entry, session }) => {
    const ending = endings.get(entry.configName);
    return ending?.kind === 'queued' && session
      ? [
          {
            service: entry.configName,
            deploymentId: ending.deployment.deploymentId,
            status: ending.deployment.status,
            consoleUrl: deploymentsPage(instance, session.target.service.id),
          },
        ]
      : [];
  });
  if (context.values.json) {
    context.out.json(rows);
    return;
  }
  context.out.data(
    table([
      ['Service', 'Deployment', 'Status'],
      ...rows.map((row) => [row.service, row.deploymentId, row.status]),
    ]),
  );
}

/** Rows of cells, each column padded to its widest cell and two spaces. */
function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows
    .map(
      (row) =>
        row
          .map((cell, column) =>
            column === row.length - 1 ? cell : cell.padEnd(widths[column] + 2),
          )
          .join('') + '\n',
    )
    .join('');
}
