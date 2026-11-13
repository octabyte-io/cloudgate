import type { Command } from '../command.js';
import { usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import {
  holdsLink,
  isProjectFolder,
  LINK_FOLDER,
  readLinkIn,
  WORKING_COPY_FILE,
  writeLink,
} from '../folder-link.js';
import type { FolderLink } from '../folder-link.js';
import {
  resolveProjectTarget,
  resolveTarget,
  TARGET_OPTIONS,
  targetInputs,
} from '../target.js';
import {
  chooserFor,
  connectToInstance,
  describeTarget,
  instanceCatalog,
  projectsInThisRepositoryFirst,
} from '../target-session.js';
import { linkWholeProject } from '../working-copy.js';

/**
 * `cloudgate link`: saves a Folder link here (CLI spec).
 *
 * It looks the target up the shared way — flags, then `CLOUDGATE_*` — but not
 * from an existing link, because it is the command that makes one: a link
 * above this folder (or one here being replaced) neither fills its answers
 * nor picks its Instance, so `--instance` never "disagrees" with the link it
 * is replacing. It never creates a Service, and never changes the Project
 * config.
 *
 * With `--whole-project` it names no Service and makes the folder a
 * **Project folder** (ADR-0080): it downloads the Cloudgate-kept Project
 * config into `cloudgate.yaml` and records the version downloaded.
 */
export const link: Command = {
  name: 'link',
  group: 'THIS FOLDER',
  summary: 'Link this folder to a Service, or a whole Project',
  help: `Link this folder to a Service, so later commands know where to go.

USAGE
  cloudgate link [--org] [--project] [--env] [--service] [--yes]
  cloudgate link --whole-project [--org] [--project] [--env] [--yes]

  Asks for the Organization, Project, Environment and Service, skipping
  any a flag answers. Saves ${LINK_FOLDER}/link.json here and adds ${LINK_FOLDER}/
  to .gitignore. It never creates a Service: make one in the console.
  With no terminal, or with --yes, it asks nothing and refuses instead,
  naming the first flag it needs.

  With --whole-project it links no Service, making this a Project folder:
  it saves the Project config here as ${WORKING_COPY_FILE}, a working copy
  Cloudgate never reads on its own, and adds it to .gitignore too. A
  Project whose config is kept in a repository is refused. In a Project
  folder, status, logs and vars ask for the Service, or take --service.

FLAGS
  --org <name|id>        Organization            (CLOUDGATE_ORG)
  --project <name|id>    Project                 (CLOUDGATE_PROJECT)
  --env <name|id>        Environment             (CLOUDGATE_ENV)
  --service <name|id>    Service, by Config name (CLOUDGATE_SERVICE)
  --whole-project        Link the whole Project, with no Service
  --yes                  Replace an existing link, and ${WORKING_COPY_FILE},
                         without asking
  --instance <url>       The Instance to link to (CLOUDGATE_INSTANCE)
`,
  options: {
    ...TARGET_OPTIONS,
    yes: { type: 'boolean' },
    'whole-project': { type: 'boolean' },
  },
  maxPositionals: 0,
  async run(context) {
    const { env, cwd, out, prompter, values } = context;
    const yes = values.yes === true;
    const wholeProject = values['whole-project'] === true;
    const canAsk = out.mode.canAsk && !yes;
    if (wholeProject && typeof values.service === 'string') {
      throw usageError(
        '--whole-project links no Service, so it takes no --service',
        'Leave out --service; status, logs and vars ask for it there.',
      );
    }

    // Before any question or request: a refusal to replace should come first.
    if (holdsLink(cwd) && !yes) {
      const existing = readLinkIn(cwd);
      const what = existing
        ? describeExisting(existing)
        : `(${LINK_FOLDER}/link.json)`;
      if (!canAsk) {
        throw usageError(
          `this folder is already linked ${what}`,
          'Pass --yes to replace the link.',
        );
      }
      if (
        !(await prompter.confirm(`This folder is linked ${what}. Replace it?`))
      ) {
        out.note(`Kept the link ${what}. Nothing changed.`);
        return EXIT.ok;
      }
    }

    const { instance, client } = await connectToInstance(context);
    const catalog = instanceCatalog(client);
    const inputs = targetInputs({ values, env });

    const lookup = canAsk
      ? projectsInThisRepositoryFirst(catalog, client, cwd)
      : catalog;
    const choose = canAsk ? { choose: chooserFor(prompter) } : {};

    if (wholeProject) {
      const target = await resolveProjectTarget(inputs, lookup, choose);
      await linkWholeProject(context, { instance, client }, cwd, target, yes);
      return EXIT.ok;
    }

    const target = await resolveTarget(inputs, lookup, choose);

    writeLink(cwd, {
      instance: instance.url,
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
    out.note(`✓ Linked ${describeTarget('./', target, instance.url)}`);
    return EXIT.ok;
  },
};

/** How a refusal or question names the link a folder already holds. */
function describeExisting(existing: FolderLink): string {
  return isProjectFolder(existing)
    ? `to the whole Project ${existing.names.project}`
    : `to ${existing.names.service} in ${existing.names.environment} of Project ${existing.names.project}`;
}
