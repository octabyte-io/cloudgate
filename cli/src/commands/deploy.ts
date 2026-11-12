import { existsSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import {
  applicationBuildListSchema,
  configRepositorySourcesSchema,
  DEPLOYMENT_IN_PROGRESS_CODE,
  deploymentSchema,
  serviceRowSchema,
  uploadedDropSchema,
} from 'api-schemas';
import type { DeploymentView } from 'api-schemas';

import type { ApiClient } from '../api-client.js';
import type { Command, CommandContext } from '../command.js';
import { deploymentLogFollower } from '../deployment-log-stream.js';
import { watchDeployment } from '../deployment-watch.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import type { ExitCode } from '../exit-codes.js';
import { runningBuildVerdict, sourceVerdict } from '../deploy-guards.js';
import type { SourceFacts } from '../deploy-guards.js';
import { nearestLinkedFolder, writeLink } from '../folder-link.js';
import { columns, describeDuration, describeSize } from '../format.js';
import { kindRefusal, sourceOf } from '../service-status.js';
import { abortOf, POLL_MILLISECONDS, withInterrupts } from '../stopping.js';
import type { ServiceSource } from '../service-status.js';
import { TARGET_OPTIONS } from '../target.js';
import type { Target } from '../target.js';
import { chooserFor, describeTarget, lookUpTarget } from '../target-session.js';
import type { TargetSession } from '../target-session.js';
import { selectUploadFiles, summarizeUpload } from '../upload-files.js';
import { packUpload } from '../zip.js';

/**
 * `cloudgate deploy [folder] [--detach]` (CLI spec "Deploy
 * behaviour", the twelve deploy steps): uploads the folder as it is on
 * disk, starts a Deployment, follows its Deployment log, and exits 0 only if
 * it ended done.
 *
 * Before anything is uploaded (`deploy-guards.ts`): only an
 * Application, never against a repository the Project config names, a git
 * or image source switched only on a yes, and never while a build of the
 * Service reads the tree it would replace.
 */
export const deploy: Command = {
  name: 'deploy',
  group: 'THIS FOLDER',
  summary: 'Upload this folder and deploy it',
  help: `Upload a folder and deploy it to its Service.

USAGE
  cloudgate deploy [folder] [--env <name|id>] [--detach [--json]]
                   [--switch-source]

  Uploads the linked folder (the one holding the nearest .cloudgate/), or
  [folder]; with no link, the current folder. Uncommitted files are
  included. Left out: .git, .cloudgate, anything any .gitignore or a
  .cloudgateignore lists (same syntax; ! brings a file back), and .env
  files except .env.example (put secrets in with cloudgate vars set).
  Symlinks are left out with a warning, and file modes are not kept.
  Waits for any running build first, then uploads, then follows the
  Deployment log until the Deployment ends, and exits 0 only if it is
  done. Ctrl-C stops watching; the build goes on. Applications only.
  An unlinked folder is linked first, by the link questions.

FLAGS
  --org <name|id>        Organization            (CLOUDGATE_ORG)
  --project <name|id>    Project                 (CLOUDGATE_PROJECT)
  --env <name|id>        Deploy to the same Service in another
                         Environment              (CLOUDGATE_ENV)
  --service <name|id>    Service, by Config name (CLOUDGATE_SERVICE)
  --detach               Don't wait: print the Deployment and exit once
                         queued
  --json                 With --detach, print it as JSON
  --switch-source        Allow switching a git or image source to
                         uploaded files without asking (needed in CI)
  --instance <url>       The Instance to deploy to (CLOUDGATE_INSTANCE)
`,
  options: {
    ...TARGET_OPTIONS,
    detach: { type: 'boolean' },
    json: { type: 'boolean' },
    'switch-source': { type: 'boolean' },
  },
  maxPositionals: 1,
  async run(context) {
    const { out, values } = context;
    if (values.json && !values.detach) {
      throw usageError(
        '--json goes with --detach',
        'A watched Deployment prints its log; run cloudgate deploy --detach --json for a result to parse.',
      );
    }
    const folder = uploadFolder(context);
    // The lookup starts in the folder uploaded, so `cloudgate deploy
    // ../other` deploys to the Service ../other is linked to.
    let asked = false;
    const choose = out.mode.canAsk ? chooserFor(context.prompter) : undefined;
    const session = await lookUpTarget(
      { ...context, cwd: folder },
      choose
        ? {
            choose: (level, candidates) => {
              asked = true;
              return choose(level, candidates);
            },
          }
        : {},
    );
    const { target, instance } = session;
    const shown = shownFolder(context.cwd, folder);

    // Nothing is uploaded until the kind, the source and any build
    // in progress say it may be.
    const wrongKind = kindRefusal(target.service, 'deploy');
    if (wrongKind) throw wrongKind;
    if (!session.link && asked) {
      // An unlinked folder in a terminal: the link questions were just
      // answered, so they are kept, as `cloudgate link` keeps them.
      saveLink(folder, instance.url, target);
      out.note(`✓ Linked ${describeTarget(shown, target, instance.url)}`);
    }
    const source = sourceVerdict({
      configName: target.service.configName,
      source: await currentSource(session),
      configRepository: await configRepositoryOf(session),
      switchSource: values['switch-source'] === true,
      canAsk: out.mode.canAsk,
    });
    if (source.kind === 'refuse') throw source.error;
    if (
      source.kind === 'ask' &&
      !(await context.prompter.confirm(source.question))
    ) {
      out.note('Nothing was uploaded.');
      return EXIT.failed;
    }

    out.note(`Deploying ${describeTarget(shown, target, instance.url)}`);
    const waited = await untilNoBuildInProgress(context, session);
    if (waited !== undefined) return waited;

    const selection = selectUploadFiles(folder);
    if (selection.leftOutEnvFiles.length > 0) {
      out.note(
        `Left out ${listed(selection.leftOutEnvFiles)}. Use cloudgate vars set for secrets.`,
      );
    }
    if (selection.symlinks.length > 0) {
      out.note(
        `Warning: left out ${listed(selection.symlinks)}, ${selection.symlinks.length === 1 ? 'a symlink' : 'symlinks'}; an upload keeps no symlinks.`,
      );
    }
    const summary = summarizeUpload(selection.files);
    if (summary.large) {
      out.note(
        `Warning: this upload is ${describeSize(summary.totalSize)}, more than 100 MB. Its biggest folders:`,
      );
      for (const biggest of summary.biggestFolders) {
        out.note(
          `  ${describeSize(biggest.size).padStart(9)}  ${biggest.path}/`,
        );
      }
      out.note('  A .cloudgateignore can leave some out.');
    }
    out.note(
      `Uploading ${summary.count} ${summary.count === 1 ? 'file' : 'files'}, ${describeSize(summary.totalSize)}…`,
    );
    const applicationId = target.service.id;
    const archive = packUpload(folder, selection.files);
    const form = new FormData();
    form.set('dropBuildPath', '/');
    form.set(
      'zip',
      new Blob([archive], { type: 'application/zip' }),
      'folder.zip',
    );
    // The server refuses an upload while a build is in progress (409), so
    // one that started since the check above is waited for, then the upload
    // is made again.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await out.withSpinner('Uploading…', () =>
          session.client.post(
            `/applications/${encodeURIComponent(applicationId)}/drop`,
            form,
            uploadedDropSchema,
          ),
        );
        break;
      } catch (error) {
        if (
          !(error instanceof CliError) ||
          error.code !== DEPLOYMENT_IN_PROGRESS_CODE ||
          attempt >= UPLOAD_ATTEMPTS
        ) {
          throw error;
        }
        out.note('A build started meanwhile.');
        const stopped = await untilNoBuildInProgress(context, session);
        if (stopped !== undefined) return stopped;
      }
    }

    const queued = await startDeployment(session.client, applicationId, out);
    const consoleUrl = `${instance.url}/applications/${encodeURIComponent(applicationId)}/deployments`;
    out.note(`Deployment ${queued.deploymentId} queued`);

    if (values.detach) {
      if (values.json) {
        out.json({
          deploymentId: queued.deploymentId,
          status: queued.status,
          consoleUrl,
        });
      } else {
        out.data(
          columns([
            ['Deployment', queued.deploymentId],
            ['Status', queued.status],
            ['Console', consoleUrl],
          ]),
        );
      }
      return EXIT.ok;
    }
    return follow(context, session, queued.deploymentId, consoleUrl);
  },
};

/** How many times an upload the server refuses during a build is made. */
const UPLOAD_ATTEMPTS = 3;

/** Saves the link the run's questions just answered, as `cloudgate link` does. */
function saveLink(folder: string, instance: string, target: Target): void {
  writeLink(folder, {
    instance,
    organizationId: target.organization.id,
    projectId: target.project.id,
    environmentId: target.environment.id,
    serviceConfigName: target.service.configName,
    names: {
      organization: target.organization.name,
      project: target.project.name,
      environment: target.environment.name,
      service: target.service.configName,
    },
  });
}

/** The Application's source now (`GET /applications/:id`, its source fields only). */
async function currentSource(
  session: TargetSession,
): Promise<ServiceSource | null> {
  const row = await session.client.get(
    `/applications/${encodeURIComponent(session.target.service.id)}`,
    serviceRowSchema,
  );
  return sourceOf(row, 'application');
}

/**
 * The repository the Project config names as this Service's source, if it
 * names one, and where the config is kept; a repository-kept config that
 * could not be read is passed on as such, for the guard to refuse.
 */
async function configRepositoryOf(
  session: TargetSession,
): Promise<SourceFacts['configRepository']> {
  const { keptIn, readable, services } = await session.client.get(
    `/environments/${encodeURIComponent(session.target.environment.id)}/config/repository-sources`,
    configRepositorySourcesSchema,
  );
  if (keptIn === 'repository' && !readable) {
    return { keptIn, readable: false };
  }
  const named = services.find(
    (service) => service.configName === session.target.service.configName,
  );
  return named && keptIn
    ? { keptIn, provider: named.provider, repository: named.repository }
    : null;
}

/**
 * Deploy step 10: while the Service has a build pending or running, say
 * so once per build and wait, asking again every two seconds; then go on,
 * after any warning {@link runningBuildVerdict} has (a held or stuck build is
 * not waited for). Ctrl-C stops the wait with nothing uploaded: exit 130.
 */
async function untilNoBuildInProgress(
  context: CommandContext,
  session: TargetSession,
): Promise<ExitCode | undefined> {
  const { out } = context;
  const applicationId = session.target.service.id;
  let waitingFor: string | undefined;
  return withInterrupts(context.interrupts, async (signal) => {
    const stopped = abortOf(signal);
    for (;;) {
      const rows = await session.client.get(
        `/applications/${encodeURIComponent(applicationId)}/deployments`,
        applicationBuildListSchema,
      );
      const verdict = runningBuildVerdict(applicationId, rows, context.now());
      if (verdict.kind === 'go') {
        for (const warning of verdict.warnings) out.note(warning);
        return undefined;
      }
      if (verdict.deploymentId !== waitingFor) {
        waitingFor = verdict.deploymentId;
        out.note(`waiting for Deployment ${waitingFor} to finish`);
      }
      await Promise.race([context.sleep(POLL_MILLISECONDS), stopped]);
      if (signal.aborted) {
        out.note('Stopped waiting. Nothing was uploaded.');
        return EXIT.interrupted;
      }
    }
  });
}

/**
 * Deploy step 7: the folder holding the nearest `.cloudgate/`, never the
 * subfolder the run stands in; `[folder]` names another; with no link, the
 * current folder.
 */
function uploadFolder(context: CommandContext): string {
  const [named] = context.positionals;
  if (named !== undefined) {
    const folder = resolve(context.cwd, named);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      throw usageError(`${named} is not a folder`);
    }
    return folder;
  }
  return nearestLinkedFolder(context.cwd) ?? context.cwd;
}

/** The folder as the target line names it, from where the run stands: `./`, `./dist/`, `../`. */
function shownFolder(cwd: string, folder: string): string {
  const path = relative(cwd, folder).split(sep).join('/');
  if (!path) return './';
  return path.startsWith('..') ? `${path}/` : `./${path}/`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The second call (deploy step 11). Upload and deploy stay two calls (CLI
 * spec, Server changes), so when this one fails the files are already on
 * the Instance: the run says so, because running `deploy` again is safe and
 * is the fix, then fails as the refusal says, its hint included.
 */
async function startDeployment(
  client: ApiClient,
  applicationId: string,
  out: CommandContext['out'],
): Promise<DeploymentView> {
  try {
    return await client.post(
      `/applications/${encodeURIComponent(applicationId)}/deployments`,
      { title: 'cloudgate deploy' },
      deploymentSchema,
    );
  } catch (error) {
    out.note(
      'The files are uploaded, but no Deployment started: run cloudgate deploy again.',
    );
    if (error instanceof CliError) {
      throw new CliError(error.message, EXIT.failed, error.hint);
    }
    throw error;
  }
}

/**
 * Step 12: follow the Deployment log while asking `GET /deployments/:id`,
 * until the Deployment is done, failed or cancelled; or until Ctrl-C, which
 * stops only the watching.
 */
async function follow(
  context: CommandContext,
  session: TargetSession,
  deploymentId: string,
  consoleUrl: string,
): Promise<ExitCode> {
  const { out } = context;
  const websocket = session.checked.endpoints.websocket;
  if (!websocket) {
    out.note(
      'This Instance names no address for its log stream (CLOUDGATE_API_URL); waiting for the Deployment without its log.',
    );
  }
  let endsInNewline = true;
  const result = await withInterrupts(context.interrupts, (signal) =>
    watchDeployment({
      read: () =>
        session.client.get(
          `/deployments/${encodeURIComponent(deploymentId)}`,
          deploymentSchema,
        ),
      ...(websocket
        ? {
            follow: deploymentLogFollower({
              open: context.openSocket,
              websocket,
              deploymentId,
              headers: session.client.socketHeaders(),
            }),
          }
        : {}),
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

  if (result.kind === 'interrupted') {
    out.note('Stopped watching. The build goes on.');
    out.note(`  Follow it:  cloudgate logs --deployment ${deploymentId} -f`);
    out.note(`  Cancel it:  ${consoleUrl}`);
    return EXIT.interrupted;
  }
  const { deployment } = result;
  const took = tookFor(deployment);
  if (deployment.status === 'done') {
    out.note(`✓ Deployment ${deploymentId} done${took ? ` in ${took}` : ''}`);
    return EXIT.ok;
  }
  if (deployment.status === 'cancelled') {
    throw new CliError(`Deployment ${deploymentId} was cancelled`, EXIT.failed);
  }
  throw new CliError(
    `Deployment ${deploymentId} failed${took ? ` after ${took}` : ''}`,
    EXIT.failed,
    `Its log: cloudgate logs --deployment ${deploymentId}`,
  );
}

/** From the build's start (or, before that was kept, the Deployment's) to its end. */
function tookFor(deployment: DeploymentView): string | undefined {
  if (!deployment.finishedAt) return undefined;
  const from = Date.parse(deployment.startedAt ?? deployment.createdAt);
  const to = Date.parse(deployment.finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return describeDuration(to - from);
}
