import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  configRepositorySourcesSchema,
  configSourcesSchema,
  serviceRowSchema,
} from 'api-schemas';

import type { Command, CommandContext } from '../command.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import type { ExitCode } from '../exit-codes.js';
import { sourceVerdict } from '../deploy-guards.js';
import type { SourceFacts } from '../deploy-guards.js';
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
} from '../deploy-steps.js';
import {
  findNearestLink,
  isProjectFolder,
  nearestLinkedFolder,
  writeLink,
} from '../folder-link.js';
import { columns } from '../format.js';
import { askFirstDeploy, asksFirstDeploy } from '../first-deploy.js';
import { createProjectHere } from '../new-project.js';
import { deployProjectFolder } from '../project-deploy.js';
import { kindRefusal, sourceOf } from '../service-status.js';
import type { ServiceSource } from '../service-status.js';
import { TARGET_OPTIONS } from '../target.js';
import type { Target } from '../target.js';
import { chooserFor, describeTarget, lookUpTarget } from '../target-session.js';
import type { TargetSession } from '../target-session.js';
import { selectUploadFiles } from '../upload-files.js';

/**
 * `cloudgate deploy [folder] [--detach]` (CLI spec "Deploy
 * behaviour", the twelve deploy steps): uploads the folder as it is on
 * disk, starts a Deployment, follows its Deployment log, and exits 0 only if
 * it ended done.
 *
 * The upload sends only the files the build host lacks or holds different
 * (spec #10), on an Instance at {@link CHANGED_FILES_SERVER_VERSION} or newer;
 * `--full`, or an older Instance, sends every file through the full `/drop`.
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
                   [--switch-source] [--full] [--yes]

  Uploads the linked folder (the one holding the nearest .cloudgate/), or
  [folder]; with no link, the current folder. Uncommitted files are
  included. Left out: .git, .cloudgate, anything any .gitignore or a
  .cloudgateignore lists (same syntax; ! brings a file back), and .env
  files except .env.example (put secrets in with cloudgate vars set).
  Symlinks are left out with a warning, and file modes are not kept.
  Only the files that changed since the last upload are sent, and files
  deleted here are deleted on the Instance too; --full sends every file.
  Waits for any running build first, then uploads, then follows the
  Deployment log until the Deployment ends, and exits 0 only if it is
  done. Ctrl-C stops watching; the build goes on. Applications only.

  In a folder with no link, in a terminal and with no target flag or
  variable, it first asks which Project (or Create a new Project), then
  One app or the whole Project? (one app by default). One app asks the
  Environment and Service and links this folder to it; the whole Project
  links it as cloudgate link --whole-project does and deploys it whole.
  Create a new Project asks its name (this folder's by default) and once
  where its apps run, from your Servers and Cloud accounts, then makes it
  with one Environment, production, links this folder to it and writes a
  starter cloudgate.yaml. Add your apps there and run deploy again.

  In a Project folder (cloudgate link --whole-project), it first sends
  cloudgate.yaml as a plan and applies it, as cloudgate config plan does.
  Then it uploads the whole folder to each app whose config entry names a
  subfolder of it as its source (source: { folder: apps/web }), builds
  each from that subfolder, follows each build to its end, and prints one
  line per app. Apps from a repository or an image, console-managed
  entries and databases are skipped. --service deploys one app only.

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
  --full                 Upload every file, not only the changed ones
  --yes                  In a Project folder, apply the plan without
                         asking; one that destroys a Service or makes a
                         major upgrade is still refused
  --instance <url>       The Instance to deploy to (CLOUDGATE_INSTANCE)
`,
  options: {
    ...TARGET_OPTIONS,
    detach: { type: 'boolean' },
    json: { type: 'boolean' },
    'switch-source': { type: 'boolean' },
    full: { type: 'boolean' },
    yes: { type: 'boolean' },
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
    // A Project folder (ADR-0080) is deployed whole: every app its config
    // builds from a subfolder of it.
    const found = findNearestLink(context.cwd);
    if (found && isProjectFolder(found.link)) {
      if (context.positionals.length > 0) {
        throw usageError(
          'a Project folder is deployed whole, not a folder in it',
          'Run cloudgate deploy with no folder to build every app from its subfolder, or --service <name> for one of them.',
        );
      }
      return deployProjectFolder(context, { ...found, link: found.link });
    }
    const folder = uploadFolder(context);
    let asked = false;
    let session: TargetSession;
    if (asksFirstDeploy(context, findNearestLink(folder))) {
      // A first deploy here, in a terminal: which Project, and one app of
      // it or the whole Project (ADR-0080).
      const first = await askFirstDeploy(context, folder);
      if (first.kind === 'kept') {
        out.note('Nothing was uploaded.');
        return EXIT.failed;
      }
      if (first.kind === 'new project') {
        return createProjectHere(
          context,
          first.connection,
          first.organization,
          folder,
        );
      }
      if (first.kind === 'whole project') {
        return deployProjectFolder(context, first.project, first.connection);
      }
      session = first.session;
      asked = true;
    } else {
      // The lookup starts in the folder uploaded, so `cloudgate deploy
      // ../other` deploys to the Service ../other is linked to.
      const choose = out.mode.canAsk ? chooserFor(context.prompter) : undefined;
      session = await lookUpTarget(
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
    }
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

    // An app of a Project folder built from its subfolder gets what a root
    // deploy sends it: the whole Project folder, from that subfolder (#33).
    const place = (await projectFolderPlace(session, folder)) ?? {
      folder,
      buildPath: '/',
    };
    const selection = selectUploadFiles(place.folder);
    noteLeftOut(out, selection);
    const applicationId = target.service.id;
    const stopped = await uploadFiles(
      context,
      session,
      place.folder,
      selection.files,
      {
        full: values.full === true,
        buildPath: place.buildPath,
      },
    );
    if (stopped !== undefined) return stopped;

    const queued = await startDeployment(session.client, applicationId, out);
    const consoleUrl = deploymentsPage(instance.url, applicationId);
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

/**
 * Where a one-Service deploy uploads from when `folder` is inside a
 * **Project folder** of the same Project and the Service's config entry is
 * a folder source (ADR-0080): the Project folder, with the entry's
 * subfolder as the build path, as a root deploy uploads it. Uploading only
 * `folder` left out the shared code beside it, and its `/` build path
 * turned the entry into `managed: console` (#33). Undefined otherwise: the
 * folder itself, from its top.
 */
async function projectFolderPlace(
  session: TargetSession,
  folder: string,
): Promise<{ folder: string; buildPath: string } | undefined> {
  const above = dirname(folder);
  const found = above === folder ? undefined : findNearestLink(above);
  if (
    !found ||
    !isProjectFolder(found.link) ||
    found.link.projectId !== session.target.project.id
  ) {
    return undefined;
  }
  const sources = await session.client.get(
    `/environments/${encodeURIComponent(session.target.environment.id)}/config/sources`,
    configSourcesSchema,
  );
  const entry = sources.services.find(
    (one) => one.configName === session.target.service.configName,
  );
  if (entry?.source !== 'folder' || entry.folder === null) return undefined;
  return { folder: found.folder, buildPath: entry.folder };
}

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

/**
 * Step 12: follow the Deployment log until the Deployment is done, failed or
 * cancelled, then say how it ended; or until Ctrl-C, which stops only the
 * watching.
 */
async function follow(
  context: CommandContext,
  session: TargetSession,
  deploymentId: string,
  consoleUrl: string,
): Promise<ExitCode> {
  const { out } = context;
  const result = await watchBuild(context, session, deploymentId);
  if (result.kind === 'interrupted') {
    stoppedWatching(out, deploymentId, consoleUrl);
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
