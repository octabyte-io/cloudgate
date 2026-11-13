import { relative, sep } from 'node:path';

import {
  applicationBuildListSchema,
  DEPLOYMENT_IN_PROGRESS_CODE,
  deploymentSchema,
  dropComparisonSchema,
  UPLOAD_CONFLICT_CODE,
  uploadedDropSchema,
} from 'api-schemas';
import type { DeploymentView, DropFile } from 'api-schemas';

import type { ApiClient } from './api-client.js';
import type { CommandContext } from './command.js';
import { deploymentLogFollower } from './deployment-log-stream.js';
import { watchDeployment } from './deployment-watch.js';
import type { WatchResult } from './deployment-watch.js';
import { runningBuildVerdict } from './deploy-guards.js';
import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { describeDuration, describeSize } from './format.js';
import {
  CHANGED_FILES_SERVER_VERSION,
  serverVersionAgainst,
} from './server-version.js';
import { abortOf, POLL_MILLISECONDS, withInterrupts } from './stopping.js';
import type { TargetSession } from './target-session.js';
import { fingerprintFiles, summarizeUpload } from './upload-files.js';
import type { UploadFile } from './upload-files.js';
import { packUpload } from './zip.js';

/**
 * The steps `cloudgate deploy` takes for one Application, shared by a deploy
 * of one Service and a root deploy in a **Project folder** (ADR-0080): wait
 * for its own build in progress, upload, start a Deployment, and watch it.
 */

/** How many times an upload the server refuses during a build is made. */
const UPLOAD_ATTEMPTS = 3;

/** How many times the files are compared when an apply finds they changed. */
const COMPARE_ATTEMPTS = 2;

/**
 * The upload (deploy step 11's first call): only the changed files on an
 * Instance that compares them, every file with `full` or on an older one,
 * landing with `buildPath` as the folder the build starts in. The server
 * refuses an upload while a build is in progress (409), so one that started
 * since the caller's wait is waited for, then the upload is made again.
 * Answers an exit code when that wait was stopped.
 */
export async function uploadFiles(
  context: CommandContext,
  session: TargetSession,
  folder: string,
  files: readonly UploadFile[],
  options: { readonly full: boolean; readonly buildPath: string },
): Promise<ExitCode | undefined> {
  const onlyChanges =
    !options.full &&
    serverVersionAgainst(
      session.checked.version,
      CHANGED_FILES_SERVER_VERSION,
    ) === 'supported';
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (onlyChanges) {
        await uploadChanges(context, session, folder, files, options.buildPath);
      } else {
        await uploadWhole(context, session, folder, files, options.buildPath);
      }
      return undefined;
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.code !== DEPLOYMENT_IN_PROGRESS_CODE ||
        attempt >= UPLOAD_ATTEMPTS
      ) {
        throw error;
      }
      context.out.note('A build started meanwhile.');
      const stopped = await untilNoBuildInProgress(context, session);
      if (stopped !== undefined) return stopped;
    }
  }
}

/**
 * Names the `.env` files and symlinks an upload of `selection` leaves out
 * (deploy step 8).
 */
export function noteLeftOut(
  out: CommandContext['out'],
  selection: {
    leftOutEnvFiles: readonly string[];
    symlinks: readonly string[];
  },
): void {
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
}

/**
 * The full upload (`POST /applications/:id/drop`): every file, zipped, as
 * the console and older CLIs send it.
 */
async function uploadWhole(
  context: CommandContext,
  session: TargetSession,
  folder: string,
  files: readonly UploadFile[],
  buildPath: string,
): Promise<void> {
  const { out } = context;
  const zip = zipBlob(folder, files);
  const summary = announceUpload(out, files, zip);
  out.note(
    `Uploading ${summary.count} ${summary.count === 1 ? 'file' : 'files'}, ${describeSize(summary.totalSize)}…`,
  );
  const form = new FormData();
  form.set('dropBuildPath', buildPath);
  form.set('zip', zip, 'folder.zip');
  await out.withSpinner('Uploading…', () =>
    session.client.post(
      `/applications/${encodeURIComponent(session.target.service.id)}/drop`,
      form,
      uploadedDropSchema,
    ),
  );
}

/**
 * The upload of only what changed (spec #10): the file list is compared with
 * the build host's files, and the apply sends the list with a zip of only the
 * files the build host is missing. An apply refused with a 409
 * `UPLOAD_CONFLICT` (the build host's files changed since the comparison, or
 * the apply failed) is compared and applied once more, then fails.
 */
async function uploadChanges(
  context: CommandContext,
  session: TargetSession,
  folder: string,
  files: readonly UploadFile[],
  buildPath: string,
): Promise<void> {
  const { out } = context;
  const path = `/applications/${encodeURIComponent(session.target.service.id)}/drop`;
  const list = fingerprintFiles(folder, files);
  for (let attempt = 1; ; attempt += 1) {
    const compareForm = new FormData();
    compareForm.set('dropBuildPath', buildPath);
    compareForm.set('files', listBlob(list), 'files.json');
    const comparison = await out.withSpinner('Comparing…', () =>
      session.client.post(`${path}/compare`, compareForm, dropComparisonSchema),
    );
    const counts = [
      `${comparison.unchanged} unchanged`,
      ...(comparison.deleted > 0 ? [`${comparison.deleted} deleted`] : []),
    ].join(', ');
    if (comparison.missing.length === 0) {
      // Nothing to send, and when nothing goes either and the source is
      // already this upload, nothing to apply (#31).
      if (comparison.deleted === 0 && comparison.upToDate === true) {
        out.note(`Nothing changed since the last upload (${counts}).`);
        return;
      }
      out.note(`No changed files to upload (${counts})…`);
    } else {
      const missing = new Set(comparison.missing);
      const changed = files.filter((file) => missing.has(file.path));
      const summary = announceUpload(out, changed, zipBlob(folder, changed));
      out.note(
        `Uploading ${summary.count} changed ${summary.count === 1 ? 'file' : 'files'}, ${describeSize(summary.totalSize)} (${counts})…`,
      );
    }
    const missing = new Set(comparison.missing);
    const zip = zipBlob(
      folder,
      files.filter((file) => missing.has(file.path)),
    );
    const applyForm = new FormData();
    applyForm.set('dropBuildPath', buildPath);
    applyForm.set('files', listBlob(list), 'files.json');
    applyForm.set('zip', zip, 'changes.zip');
    try {
      await out.withSpinner('Uploading…', () =>
        session.client.post(`${path}/apply`, applyForm, uploadedDropSchema),
      );
      return;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== UPLOAD_CONFLICT_CODE) {
        throw error;
      }
      // The Instance's message says which of its causes it was (the build
      // host's files changed, or the apply failed or never reached it), so
      // it is printed rather than guessed at. Nothing is claimed about the
      // build host's files: a connection lost after the swap answers the same.
      if (attempt >= COMPARE_ATTEMPTS) {
        throw new CliError(
          error.message,
          EXIT.failed,
          'It was compared and refused twice. Run cloudgate deploy again, or cloudgate deploy --full to send every file.',
        );
      }
      out.note(`${error.message}; comparing again.`);
    }
  }
}

/**
 * Warns, naming the biggest folders, when `zip`, what is about to be sent,
 * passes 100 MB (deploy step 9), and answers its summary, whose size is the
 * zip's: the bytes sent, not the files' (spec #10).
 */
function announceUpload(
  out: CommandContext['out'],
  files: readonly UploadFile[],
  zip: Blob,
): ReturnType<typeof summarizeUpload> {
  const summary = summarizeUpload(files, zip.size);
  if (summary.large) {
    out.note(
      `Warning: this upload is ${describeSize(summary.totalSize)}, more than 100 MB. Its biggest folders:`,
    );
    for (const biggest of summary.biggestFolders) {
      out.note(`  ${describeSize(biggest.size).padStart(9)}  ${biggest.path}/`);
    }
    out.note('  A .cloudgateignore can leave some out.');
  }
  return summary;
}

function zipBlob(folder: string, files: readonly UploadFile[]): Blob {
  return new Blob([packUpload(folder, files)], { type: 'application/zip' });
}

/** The file list as the `files` part carries it: JSON. */
function listBlob(list: readonly DropFile[]): Blob {
  return new Blob([JSON.stringify(list)], { type: 'application/json' });
}

/**
 * Deploy step 10: while the Service has a build pending or running, say
 * so once per build and wait, asking again every two seconds; then go on,
 * after any warning {@link runningBuildVerdict} has (a held or stuck build is
 * not waited for). Ctrl-C stops the wait with nothing uploaded: exit 130.
 */
export async function untilNoBuildInProgress(
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

/** `a`, `a and b`, `a, b and c`. */
export function listed(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The second call (deploy step 11). Upload and deploy stay two calls (CLI
 * spec, Server changes), so when this one fails the files are already on
 * the Instance: the run says so, because running `deploy` again is safe and
 * is the fix, then fails as the refusal says, its hint included.
 */
export async function startDeployment(
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
 * Step 12's watch: follows the Deployment log on stdout while asking `GET
 * /deployments/:id`, until the Deployment is done, failed or cancelled; or
 * until Ctrl-C, which stops only the watching.
 */
export async function watchBuild(
  context: CommandContext,
  session: TargetSession,
  deploymentId: string,
): Promise<WatchResult> {
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
  return result;
}

/** What Ctrl-C during a watch prints: the build goes on, and how to reach it. */
export function stoppedWatching(
  out: CommandContext['out'],
  deploymentId: string,
  consoleUrl: string,
): void {
  out.note('Stopped watching. The build goes on.');
  out.note(`  Follow it:  cloudgate logs --deployment ${deploymentId} -f`);
  out.note(`  Cancel it:  ${consoleUrl}`);
}

/** Where the console shows an Application's Deployments. */
export function deploymentsPage(
  instance: string,
  applicationId: string,
): string {
  return `${instance}/applications/${encodeURIComponent(applicationId)}/deployments`;
}

/** From the build's start (or, before that was kept, the Deployment's) to its end. */
export function tookFor(deployment: DeploymentView): string | undefined {
  if (!deployment.finishedAt) return undefined;
  const from = Date.parse(deployment.startedAt ?? deployment.createdAt);
  const to = Date.parse(deployment.finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return describeDuration(to - from);
}

/** The folder as the target line names it, from where the run stands: `./`, `./dist/`, `../`. */
export function shownFolder(cwd: string, folder: string): string {
  const path = relative(cwd, folder).split(sep).join('/');
  if (!path) return './';
  return path.startsWith('..') ? `${path}/` : `./${path}/`;
}
