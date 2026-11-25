import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { projectConfigCopySchema } from 'api-schemas';

import type { ApiClient } from './api-client.js';
import type { CommandContext } from './command.js';
import { CliError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';
import {
  findNearestLink,
  isProjectFolder,
  linkFileIn,
  readLinkIn,
  workingCopyFileIn,
  writeLink,
} from './folder-link.js';
import type {
  FoundLink,
  ProjectFolderLink,
  WorkingCopyFile,
} from './folder-link.js';
import type { Output } from './output.js';
import type { ProjectTarget } from './target.js';
import { hostOf } from './target-session.js';
import type { Connection } from './target-session.js';

/**
 * A **Project folder**'s working copy of the Project config (ADR-0080):
 * `cloudgate.yaml`, or `cloudgate.yml` when that is the only one (ADR-0089),
 * beside `.cloudgate/`, downloaded by `cloudgate link --whole-project` and
 * `cloudgate config pull`, which record in the link the version downloaded
 * and the hash of the text written. Cloudgate keeps the
 * config; this file is never a place it is kept, and is never committed.
 */

/** The nearest link, found to make a Project folder. */
export interface FoundProjectFolder extends FoundLink {
  link: ProjectFolderLink;
}

/**
 * The Project folder `cwd` is in, for `cloudgate <command>`: its nearest
 * link must name no Service. Refuses (exit 2) a folder with no link, or one
 * whose nearest link is to one Service, saying how to make one.
 */
export function findProjectFolder(
  cwd: string,
  command: string,
): FoundProjectFolder {
  const found = findNearestLink(cwd);
  if (found === undefined) {
    throw usageError(
      'this folder is not in a Project folder',
      'Run cloudgate link --whole-project at the root of the Project first.',
    );
  }
  const { link } = found;
  if (!isProjectFolder(link)) {
    throw usageError(
      `this folder is linked to the Service ${link.names.service} of Project ${link.names.project}, not to a whole Project`,
      `Run cloudgate ${command} in the Project folder, or cloudgate link --whole-project to make one.`,
    );
  }
  return { ...found, link };
}

/** The SHA-256 of `text` as written, hex: what a link records of its copy. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * `folder`'s working copy file ({@link workingCopyFileIn}): `cloudgate.yaml`,
 * else `cloudgate.yml`. A folder holding both is warned about once a run,
 * naming the one not read.
 */
export function workingCopyIn(
  folder: string,
  out: Pick<Output, 'noteOnce'>,
): WorkingCopyFile {
  const found = workingCopyFileIn(folder);
  if (found.unread !== undefined) {
    out.noteOnce(
      `Warning: this Project folder holds both ${found.name} and ${found.unread}; using ${found.name}, and ${found.unread} is not read.`,
    );
  }
  return found;
}

/**
 * The working copy `folder` holds, as {@link workingCopyIn} finds it: its
 * name, and its text, or undefined when there is none.
 */
export function readWorkingCopy(
  folder: string,
  out: Pick<Output, 'noteOnce'>,
): { name: string; text: string | undefined } {
  const found = workingCopyIn(folder, out);
  return {
    name: found.name,
    text: found.held ? readFileSync(found.file, 'utf8') : undefined,
  };
}

/** A Cloudgate-kept Project config as downloaded. */
export interface DownloadedConfig {
  text: string;
  version: number;
}

/**
 * Reads the Project's config (`GET /projects/:id/config`) for a working
 * copy. `client` acts in the Project's Organization. A config kept in a
 * repository is refused, naming it: only a Cloudgate-kept config can have a
 * Project folder, and moving one is the console's move, with its preview.
 */
export async function downloadProjectConfig(
  client: ApiClient,
  project: { id: string; name: string },
): Promise<DownloadedConfig> {
  const { location } = await client.get(
    `/projects/${encodeURIComponent(project.id)}/config`,
    projectConfigCopySchema,
  );
  if (location === null) {
    throw new CliError(
      `Project ${project.name} has no Project config yet`,
      EXIT.failed,
      'Open the Project in the console, which makes one, then run this again.',
    );
  }
  if (location.kind === 'repository') {
    throw new CliError(
      `Project ${project.name}'s config is kept in the repository ${location.repository} at ${location.path}, so no folder can hold a working copy of it`,
      EXIT.failed,
      "To edit it from a folder, move it into Cloudgate in the console: the Project's Config page, Move into Cloudgate.",
    );
  }
  return { text: location.text, version: location.version };
}

/**
 * Settles whether a working copy in `folder` may be replaced by version
 * `version`: one that is not what `recorded` says was downloaded is asked
 * about in a terminal, and refused without one (exit 2) unless `yes`.
 * Answers false when the person said no.
 */
export async function mayReplaceWorkingCopy(
  context: Pick<CommandContext, 'out' | 'prompter'>,
  folder: string,
  recorded: ProjectFolderLink['workingCopy'] | undefined,
  incoming: DownloadedConfig,
  yes: boolean,
): Promise<boolean> {
  const { name, text: held } = readWorkingCopy(folder, context.out);
  // No copy at all is not edited; one that is not the text downloaded is,
  // as is one there before any download.
  if (held === undefined || hashText(held) === recorded?.sha256) return true;
  if (held === incoming.text) return true;
  if (yes) return true;
  if (!context.out.mode.canAsk) {
    throw usageError(
      `${name} has edits not sent to Cloudgate`,
      `Pass --yes to replace them with the Project config, version ${incoming.version}.`,
    );
  }
  return context.prompter.confirm(
    `${name} has edits not sent to Cloudgate. Replace them with the Project config, version ${incoming.version}?`,
  );
}

/**
 * Writes `downloaded` to `folder`'s working copy, under the name already
 * there ({@link workingCopyFileIn}; `cloudgate.yaml` when there is none),
 * and saves `link` there recording it (the version and the hash of the
 * text), adding both to `.gitignore`. Answers the link as saved and the name
 * written.
 */
export function saveWorkingCopy(
  folder: string,
  link: Omit<ProjectFolderLink, 'workingCopy'>,
  downloaded: DownloadedConfig,
): { link: ProjectFolderLink; name: string } {
  const { name, file } = workingCopyFileIn(folder);
  writeFileSync(file, downloaded.text);
  const saved: ProjectFolderLink = {
    ...link,
    workingCopy: {
      version: downloaded.version,
      sha256: hashText(downloaded.text),
    },
  };
  writeLink(folder, saved);
  return { link: saved, name };
}

/**
 * Makes `folder` a Project folder linked to `target`, as `cloudgate link
 * --whole-project` does: downloads the Project config (refusing one kept in
 * a repository), settles a working copy already there
 * ({@link mayReplaceWorkingCopy}), then saves the copy and the link and says
 * so. Answers the Project folder, or undefined when the person kept the copy
 * there, which changes nothing.
 */
export async function linkWholeProject(
  context: Pick<CommandContext, 'out' | 'prompter'>,
  connection: Pick<Connection, 'instance' | 'client'>,
  folder: string,
  target: ProjectTarget,
  yes: boolean,
): Promise<FoundProjectFolder | undefined> {
  const { out } = context;
  const downloaded = await downloadProjectConfig(
    connection.client.inOrganization(
      target.organization.id,
      target.organization.name,
    ),
    target.project,
  );
  const replacing = readLinkIn(folder);
  const recorded =
    replacing && isProjectFolder(replacing) ? replacing.workingCopy : undefined;
  if (
    !(await mayReplaceWorkingCopy(context, folder, recorded, downloaded, yes))
  ) {
    out.note(`Kept ${workingCopyIn(folder, out).name}. Nothing changed.`);
    return undefined;
  }
  const { link, name } = saveWorkingCopy(
    folder,
    {
      instance: connection.instance.url,
      organizationId: target.organization.id,
      projectId: target.project.id,
      environmentId: target.environment.id,
      names: {
        organization: target.organization.name,
        project: target.project.name,
        environment: target.environment.name,
      },
    },
    downloaded,
  );
  out.note(
    `✓ Linked ./ to the whole Project ${target.project.name}, ${target.environment.name} by default, on ${hostOf(connection.instance.url)}`,
  );
  out.note(
    `✓ Saved the Project config, version ${downloaded.version}, as ${name}`,
  );
  return { folder, file: linkFileIn(folder), link };
}
