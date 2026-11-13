import {
  environmentListSchema,
  environmentWithServicesSchema,
  organizationListSchema,
  projectConfigLocationSchema,
  projectListSchema,
} from 'api-schemas';

import { ApiClient } from './api-client.js';
import type { CommandContext } from './command.js';
import { credentialFor, endedLogin } from './credentials.js';
import type { Credential } from './credentials.js';
import { findNearestLink } from './folder-link.js';
import { configMatchesFolder, folderInGit } from './git-origin.js';
import type { FolderInGit } from './git-origin.js';
import type { FoundLink } from './folder-link.js';
import { chooseInstance, instanceAddress } from './instance.js';
import type { InstanceChoice } from './instance.js';
import { checkInstance } from './instance-check.js';
import type { CheckedInstance } from './instance-check.js';
import type { Prompter } from './prompt.js';
import { resolveTarget, targetInputs } from './target.js';
import type {
  Candidate,
  ResolveOptions,
  Target,
  TargetCatalog,
  TargetLevel,
} from './target.js';

/**
 * A run's way onto an Instance: the address it chose, the key it acts with,
 * the Instance's public answer, and a client (no Organization named yet).
 */
export interface Connection {
  instance: InstanceChoice;
  credential: Credential;
  checked: CheckedInstance;
  client: ApiClient;
}

/**
 * Everything every command that talks to an Instance does first, in the one
 * order the spec fixes: choose the Instance (`--instance`, `CLOUDGATE_INSTANCE`,
 * the nearest Folder link, the current Instance, the default — refusing a flag or variable that
 * disagrees with the link), give it its one spelling (`instanceAddress`), say
 * `Using instance <url>` on stderr, find the key for it (refusing with the
 * login to run when there is none for the link's Instance), and ask the public
 * "this is a Cloudgate" question before the key is sent.
 *
 * `link` passes no Folder link: it is the command that replaces one.
 */
export async function connectToInstance(
  context: Pick<
    CommandContext,
    'env' | 'out' | 'fetch' | 'instanceFlag' | 'allowHttp' | 'logins'
  >,
  link?: FoundLink,
): Promise<Connection> {
  const { logins } = context;
  const choice = chooseInstance({
    flag: context.instanceFlag,
    env: context.env,
    link: link && { instance: link.link.instance, file: link.file },
    current: await logins.current(),
  });
  const instance: InstanceChoice = {
    ...choice,
    url: instanceAddress(choice.url, { allowHttp: context.allowHttp }),
  };
  context.out.note(context.out.noteStyle.dim(`Using instance ${instance.url}`));
  const credential = await credentialFor(instance, context.env, logins);
  const checked = await context.out.withSpinner(
    `Checking ${instance.url}…`,
    () => checkInstance({ address: instance.url, fetch: context.fetch }),
  );
  const client = new ApiClient({
    instance: instance.url,
    key: credential.key,
    fetch: context.fetch,
    refusal: { keyFrom: credential.from },
    // A saved key the Instance refuses is a login that has ended: forgotten
    // here, and the person told how to log in again (CLI spec). A key from
    // `CLOUDGATE_KEY` is the person's to fix, and keeps the Instance's 401.
    ...(credential.from === 'login'
      ? {
          onKeyRefused: async () => {
            await logins.forget(instance.url);
            return endedLogin(instance.url);
          },
        }
      : {}),
  });
  return { instance, credential, checked, client };
}

/**
 * What a command that acts on a Service (`deploy`, `status`, `logs`, `vars`)
 * gets from {@link lookUpTarget}: where it is going, with what key, and a
 * client already acting in the target's Organization.
 */
export interface TargetSession extends Connection {
  /** The nearest Folder link, when one applied. */
  link?: FoundLink;
  target: Target;
  /** Sends `x-organization-id` for the target's Organization on every request. */
  client: ApiClient;
}

/**
 * The whole lookup a Service command starts with (CLI spec): the nearest
 * Folder link at or above `cwd`, {@link connectToInstance} with it, then the
 * target, each level from its flag, its variable or the link
 * (`targetInputs`), resolved by id then by name (`resolveTarget`).
 *
 * Pass `choose` (see {@link chooserFor}) to ask for missing levels in a
 * terminal; without it a missing level is refused with exit 2, naming its
 * flag.
 */
export async function lookUpTarget(
  context: Pick<
    CommandContext,
    | 'env'
    | 'cwd'
    | 'out'
    | 'fetch'
    | 'instanceFlag'
    | 'allowHttp'
    | 'values'
    | 'logins'
  >,
  options: ResolveOptions = {},
): Promise<TargetSession> {
  const link = findNearestLink(context.cwd);
  const connection = await connectToInstance(context, link);
  const target = await context.out.withSpinner(
    `Looking up the Service on ${connection.instance.url}…`,
    () =>
      resolveTarget(
        targetInputs({
          values: context.values,
          env: context.env,
          link: link?.link,
        }),
        instanceCatalog(connection.client),
        options,
      ),
  );
  return {
    ...connection,
    ...(link ? { link } : {}),
    target,
    client: connection.client.inOrganization(
      target.organization.id,
      target.organization.name,
    ),
  };
}

/**
 * The {@link TargetCatalog} an Instance answers, over its REST routes. Every
 * read below the Organization list is made in that Organization, through
 * `x-organization-id`, so a link in a non-default Organization keeps working.
 */
export function instanceCatalog(client: ApiClient): TargetCatalog {
  return {
    async organizations() {
      const rows = await client.get('/organizations', organizationListSchema);
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },
    async projects(organizationId) {
      const rows = await client
        .inOrganization(organizationId)
        .get('/projects', projectListSchema);
      return rows.map((row) => ({ id: row.projectId, name: row.name }));
    },
    async environments(organizationId, projectId) {
      const rows = await client
        .inOrganization(organizationId)
        .get(
          `/environments?projectId=${encodeURIComponent(projectId)}`,
          environmentListSchema,
        );
      return rows.map((row) => ({ id: row.environmentId, name: row.name }));
    },
    async services(organizationId, environmentId) {
      const environment = await client
        .inOrganization(organizationId)
        .get(
          `/environments/${encodeURIComponent(environmentId)}`,
          environmentWithServicesSchema,
        );
      return environment.services.map((service) => ({
        id: service.serviceId,
        name: service.configName,
        displayName: service.name,
        kind: service.serviceType,
      }));
    },
  };
}

const QUESTION: Record<TargetLevel, string> = {
  organization: 'Organization',
  project: 'Project',
  environment: 'Environment',
  service: 'Service',
};

/**
 * The one target line commands print (CLI spec): `./ to api in staging of
 * Project shop on cloudgate.octabyte.app`. The Service by its Config name, the
 * Instance without its scheme.
 */
export function describeTarget(
  folder: string,
  target: Target,
  instance: string,
): string {
  return `${folder} to ${target.service.configName} in ${target.environment.name} of Project ${target.project.name} on ${hostOf(instance)}`;
}

/** An Instance address without its scheme, as the target line prints it. */
export function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

/** A `choose` for {@link resolveTarget} that asks through `prompter`. */
export function chooserFor(prompter: Prompter): ResolveOptions['choose'] {
  return async <C extends Candidate>(level: TargetLevel, candidates: C[]) => {
    const index = await prompter.choose(
      QUESTION[level],
      candidates.map((candidate) => ({
        label: candidate.name,
        ...(candidate.note ? { note: candidate.note } : {}),
      })),
    );
    return candidates[index];
  };
}

/**
 * The catalog `link`, and a first `deploy` in an unlinked folder, ask from: the Project whose config is kept in this
 * folder's git repository, at or above it, is listed first and says so. Only
 * the order changes; a read that fails leaves the Project where it was.
 */
export function projectsInThisRepositoryFirst(
  catalog: TargetCatalog,
  client: ApiClient,
  cwd: string,
): TargetCatalog {
  let folder: FolderInGit | undefined | null = null;
  return {
    ...catalog,
    async projects(organizationId) {
      const projects = await catalog.projects(organizationId);
      folder ??= folderInGit(cwd);
      if (!folder) return projects;
      const scoped = client.inOrganization(organizationId);
      const here = folder;
      const matches = await Promise.all(
        projects.map(async (project) => {
          try {
            const { location } = await scoped.get(
              `/projects/${encodeURIComponent(project.id)}/config`,
              projectConfigLocationSchema,
            );
            return configMatchesFolder(location, here);
          } catch {
            return false;
          }
        }),
      );
      return [
        ...projects
          .filter((_, index) => matches[index])
          .map((project) => ({
            ...project,
            note: 'its config is in this repository',
          })),
        ...projects.filter((_, index) => !matches[index]),
      ];
    },
  };
}
