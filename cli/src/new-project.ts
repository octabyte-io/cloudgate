import { basename } from 'node:path';

import {
  cloudAccountListSchema,
  createdEnvironmentSchema,
  createdProjectSchema,
  projectConfigCopySchema,
  savedConfigPlansSchema,
  serverListSchema,
  STARTER_PROJECT_CONFIG,
} from 'api-schemas';

import type { ApiClient } from './api-client.js';
import type { CommandContext } from './command.js';
import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { WORKING_COPY_FILE } from './folder-link.js';
import type { Connection } from './target-session.js';
import { linkWholeProject, readWorkingCopy } from './working-copy.js';

/**
 * "Create a new Project", as a first `cloudgate deploy` in a folder with no
 * link offers it (spec #14, ADR-0080): a Project made from the CLI, in
 * `organization`, with one Environment, `production`, whose **Deploy
 * target** is asked once from the Organization's Servers and Cloud
 * accounts, and a Cloudgate-kept config holding the starter text
 * ({@link STARTER_PROJECT_CONFIG}). `folder` becomes its Project folder,
 * holding that text as its working copy, and the run ends there: the
 * starter has no app to build yet.
 *
 * Everything that can stop it before anything is made is settled first:
 * where its apps could run, a `cloudgate.yaml` already in the folder, the
 * name and the Deploy target. Then it is made over the console's own routes
 * (`POST /projects`, which makes the empty config, `POST /environments`, and
 * the whole-YAML edit). A failure after the Project exists says what was made
 * and how to finish or remove it.
 */
export async function createProjectHere(
  context: CommandContext,
  connection: Connection,
  organization: { id: string; name: string },
  folder: string,
): Promise<ExitCode> {
  const { out, prompter } = context;
  const client = connection.client.inOrganization(
    organization.id,
    organization.name,
  );
  const consoleUrl = connection.instance.url;

  const targets = await out.withSpinner('Reading where apps can run…', () =>
    deployTargets(client),
  );
  if (targets.length === 0) {
    throw new CliError(
      `${organization.name} has no Server or Cloud account a new Project can deploy to; nothing was created`,
      EXIT.failed,
      `Add a Server at ${consoleUrl}/servers or connect a Cloud account at ${consoleUrl}/settings/cloud-accounts, then run cloudgate deploy here again.`,
    );
  }
  if (
    readWorkingCopy(folder) !== undefined &&
    !(await prompter.confirm(
      `${WORKING_COPY_FILE} is already here. Replace it with a starter for the new Project?`,
    ))
  ) {
    out.note(`Kept ${WORKING_COPY_FILE}. No Project was created.`);
    return EXIT.failed;
  }

  let name = await askName(prompter, basename(folder));
  const picked =
    targets[
      await prompter.choose(
        'Where do its apps run?',
        targets.map(({ label, note }) => ({ label, note })),
      )
    ];
  const target = await picked.choose(prompter);

  let project: { projectId: string; name: string };
  for (;;) {
    try {
      project = await out.withSpinner(`Creating Project ${name}…`, () =>
        client.post('/projects', { name }, createdProjectSchema),
      );
      break;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      if (error.status === 409) {
        out.note(
          `A Project named ${name} is already in ${organization.name}. Choose another name.`,
        );
        name = await askName(prompter);
        continue;
      }
      if (error.status === 403 && error.code === undefined) {
        throw new CliError(
          `creating a Project needs the project: create statement, which your role in ${organization.name} does not have; nothing was created`,
          EXIT.failed,
          `Ask an owner of ${organization.name} for a role that has it.`,
        );
      }
      throw error;
    }
  }
  const projectPage = `${consoleUrl}/projects/${encodeURIComponent(project.projectId)}`;

  let environment: { environmentId: string; name: string };
  try {
    environment = await out.withSpinner(
      'Creating Environment production…',
      () =>
        client.post(
          '/environments',
          {
            name: 'production',
            projectId: project.projectId,
            deployTarget: target.deployTarget,
          },
          createdEnvironmentSchema,
        ),
    );
  } catch (error) {
    throw new CliError(
      `Project ${project.name} was created, but not its Environment production: ${messageOf(error)}`,
      EXIT.failed,
      `Add an Environment to it at ${projectPage} and run cloudgate link --whole-project here, or delete it at ${projectPage}/settings.`,
    );
  }
  out.note(
    `✓ Created Project ${project.name}, its Environment ${environment.name} deploying to ${target.shown}`,
  );

  try {
    await out.withSpinner('Saving the starter config…', () =>
      storeStarter(client, project.projectId),
    );
    await linkWholeProject(
      context,
      connection,
      folder,
      {
        organization,
        project: { id: project.projectId, name: project.name },
        environment: { id: environment.environmentId, name: environment.name },
      },
      // A copy already here was asked about before anything was made.
      true,
    );
  } catch (error) {
    throw new CliError(
      `Project ${project.name} and its Environment ${environment.name} were created, but this folder was not linked to them: ${messageOf(error)}`,
      EXIT.failed,
      `Run cloudgate link --whole-project --project ${project.name} here to finish, or delete the Project at ${projectPage}/settings.`,
    );
  }
  out.note(
    `Add your apps to ${WORKING_COPY_FILE}, then run cloudgate deploy again.`,
  );
  return EXIT.ok;
}

/** The Project's name, asked until it is not empty. */
async function askName(
  prompter: CommandContext['prompter'],
  byDefault?: string,
): Promise<string> {
  const options = byDefault ? { default: byDefault } : {};
  for (;;) {
    const name = await prompter.text('Project name', options);
    if (name !== '') return name;
  }
}

/** A Deploy target as `POST /environments` takes it. */
type DeployTarget =
  | { kind: 'server'; serverId: string }
  | { kind: 'cloud'; cloudAccountId: string; region: string };

/** One answer to "Where do its apps run?", and what picking it asks next. */
interface TargetChoice {
  label: string;
  note: string;
  choose(prompter: CommandContext['prompter']): Promise<{
    deployTarget: DeployTarget;
    /** How the run's line names it. */
    shown: string;
  }>;
}

/** Each cloud's name, and a region of it a person would recognise. */
const CLOUDS: Record<string, { name: string; example: string }> = {
  aws: { name: 'AWS', example: 'us-east-1' },
  gcp: { name: 'Google Cloud', example: 'europe-west1' },
};

/**
 * Where a new Project's apps can run: the Organization's deploy Servers that
 * are ready (a build Server runs no Service, and a Bought Server takes none
 * until it is), then its Cloud accounts, each with a region asked. A list
 * the caller's role may not read is none to pick from, never a failure.
 */
async function deployTargets(client: ApiClient): Promise<TargetChoice[]> {
  const [servers, accounts] = await Promise.all([
    readable(client.get('/servers', serverListSchema)),
    readable(client.get('/cloud-accounts', cloudAccountListSchema)),
  ]);
  return [
    ...servers
      .filter(
        (server) =>
          server.serverType === 'deploy' &&
          (!server.boughtServer || server.boughtServer.stage === 'ready'),
      )
      .map((server): TargetChoice => ({
        label: server.name,
        note: server.ipAddress,
        choose: () =>
          Promise.resolve({
            deployTarget: { kind: 'server', serverId: server.serverId },
            shown: server.name,
          }),
      })),
    ...accounts.map((account): TargetChoice => {
      const cloud = CLOUDS[account.cloud] ?? {
        name: account.cloud,
        example: '',
      };
      return {
        label: account.name,
        note: [cloud.name, account.cloudId].filter(Boolean).join(' '),
        async choose(prompter) {
          let region = '';
          while (region === '') {
            region = await prompter.text(
              `Region in ${account.name}${cloud.example ? ` (such as ${cloud.example})` : ''}`,
            );
          }
          return {
            deployTarget: {
              kind: 'cloud',
              cloudAccountId: account.cloudAccountId,
              region,
            },
            shown: `${account.name} in ${region}`,
          };
        },
      };
    }),
  ];
}

/** A list read, with a role's refusal to read it taken as an empty list. */
async function readable<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof CliError && error.status === 403) return [];
    throw error;
  }
}

/**
 * Makes the new Project's config the starter text, as a whole-YAML edit
 * from the version `POST /projects` made. Its one Environment is empty and
 * the starter names no app, so the plan has no step and the text is stored
 * at once.
 */
async function storeStarter(
  client: ApiClient,
  projectId: string,
): Promise<void> {
  const path = `/projects/${encodeURIComponent(projectId)}/config`;
  const { location } = await client.get(path, projectConfigCopySchema);
  await client.post(
    `${path}/plans`,
    {
      text: STARTER_PROJECT_CONFIG,
      ...(location?.kind === 'cloudgate' ? { version: location.version } : {}),
    },
    savedConfigPlansSchema,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
