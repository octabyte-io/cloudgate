import { projectConfigLocationSchema } from 'api-schemas';

import type { ApiClient } from './api-client.js';
import type { CommandContext } from './command.js';
import type { FoundLink } from './folder-link.js';
import {
  resolveOrganization,
  resolveProjectTarget,
  resolveTarget,
  targetInputs,
} from './target.js';
import type { TargetInputs } from './target.js';
import {
  chooserFor,
  connectToInstance,
  instanceCatalog,
  projectsInThisRepositoryFirst,
} from './target-session.js';
import type { Connection, TargetSession } from './target-session.js';
import { linkWholeProject } from './working-copy.js';
import type { FoundProjectFolder } from './working-copy.js';

/**
 * The questions a first `cloudgate deploy` asks in a folder with no link
 * (spec #14, ADR-0080): which Project, listing the one whose config this
 * repository keeps first, plus "Create a new Project"; then, for an
 * existing one, "One app or the whole Project?", one app by default.
 */

/** The last choice of the Project question. */
export const CREATE_A_NEW_PROJECT = 'Create a new Project';

const ONE_APP_OR_WHOLE = 'One app or the whole Project?';

/** What the person chose, and what it led to. */
export type FirstDeploy =
  /** One Service, every level resolved: deployed, then linked, as before. */
  | { kind: 'one app'; session: TargetSession }
  /** The folder, now a Project folder, as `link --whole-project` makes one. */
  | {
      kind: 'whole project';
      project: FoundProjectFolder;
      connection: Connection;
    }
  /** The person kept a `cloudgate.yaml` already there: nothing changed. */
  | { kind: 'kept' }
  | {
      kind: 'new project';
      connection: Connection;
      organization: { id: string; name: string };
    };

/**
 * Whether a `deploy` asks these questions: only in a folder with no link at
 * or above it, in a terminal, with no target flag and no `CLOUDGATE_ORG`,
 * `_PROJECT`, `_ENV` or `_SERVICE`. Any of those keeps the run as it was.
 */
export function asksFirstDeploy(
  context: Pick<CommandContext, 'out' | 'values' | 'env'>,
  link: FoundLink | undefined,
): boolean {
  if (link !== undefined || !context.out.mode.canAsk) return false;
  const inputs = targetInputs({ values: context.values, env: context.env });
  return Object.keys(inputs).length === 0;
}

/** Asks the questions for `folder`, the folder `deploy` uploads. */
export async function askFirstDeploy(
  context: CommandContext,
  folder: string,
): Promise<FirstDeploy> {
  const { out, prompter } = context;
  const connection = await connectToInstance(context);
  const catalog = projectsInThisRepositoryFirst(
    instanceCatalog(connection.client),
    connection.client,
    folder,
  );
  const choose = { choose: chooserFor(prompter) };

  const organization = await resolveOrganization({}, catalog, choose);
  const projects = await catalog.projects(organization.id);
  const picked = await prompter.choose('Project', [
    ...projects.map((project) => ({
      label: project.name,
      ...(project.note ? { note: project.note } : {}),
    })),
    { label: CREATE_A_NEW_PROJECT },
  ]);
  if (picked === projects.length) {
    return { kind: 'new project', connection, organization };
  }
  const project = projects[picked];
  // The two answers, by id, so the lookup asks only what is left.
  const inputs: TargetInputs = {
    organization: { value: organization.id, from: 'flag' },
    project: { value: project.id, from: 'flag' },
  };

  const keptIn = await repositoryKeeping(
    connection.client.inOrganization(organization.id, organization.name),
    project,
  );
  let whole = false;
  if (keptIn) {
    out.note(
      `Project ${project.name}'s config is kept in ${keptIn}, so this folder deploys one app of it, not the whole Project.`,
    );
  } else {
    const answer = await prompter.choose(
      ONE_APP_OR_WHOLE,
      [{ label: 'One app' }, { label: 'The whole Project' }],
      { default: 0 },
    );
    whole = answer === 1;
  }

  if (!whole) {
    const target = await resolveTarget(inputs, catalog, choose);
    return {
      kind: 'one app',
      session: {
        ...connection,
        target,
        client: connection.client.inOrganization(
          target.organization.id,
          target.organization.name,
        ),
      },
    };
  }
  const target = await resolveProjectTarget(inputs, catalog, choose);
  // A copy already here is asked about even with --yes, which answers
  // only the plan.
  const linked = await linkWholeProject(
    context,
    connection,
    folder,
    target,
    false,
  );
  return linked
    ? { kind: 'whole project', project: linked, connection }
    : { kind: 'kept' };
}

/**
 * Where the Project's config is kept when that is a repository, as "the
 * repository owner/repo at path"; undefined when Cloudgate keeps it, so it
 * can have a Project folder (ADR-0080).
 */
async function repositoryKeeping(
  client: ApiClient,
  project: { id: string },
): Promise<string | undefined> {
  const { location } = await client.get(
    `/projects/${encodeURIComponent(project.id)}/config`,
    projectConfigLocationSchema,
  );
  if (location?.kind !== 'repository') return undefined;
  if (!location.repository) return 'a repository';
  const at = location.path ? ` at ${location.path}` : '';
  return `the repository ${location.repository}${at}`;
}
