import type { Command } from '../command.js';
import { EXIT } from '../exit-codes.js';
import { columns, describeAgo } from '../format.js';
import {
  describeSource,
  kindLabel,
  readServiceStatus,
} from '../service-status.js';
import { TARGET_OPTIONS } from '../target.js';
import { chooserFor, lookUpTarget } from '../target-session.js';

/**
 * `cloudgate status [--json]`: one Service's whole picture — kind,
 * Environment, Project, Instance, state, source, Domains and the latest
 * Deployment. It reports and does not judge: it exits 0 whenever it could
 * read the facts, a stopped Service or a failed Deployment included.
 */
export const status: Command = {
  name: 'status',
  group: 'THIS FOLDER',
  summary: 'Show the Service and its latest Deployment',
  help: `Show the Service and its latest Deployment.

USAGE
  cloudgate status [--json]

  Prints the Service and its kind, Environment, Project, Instance, whether
  it is running, where its source comes from, its Domains and its latest
  Deployment. Exits 0 whenever it could read them, even when the Service is
  stopped or its last Deployment failed.

FLAGS
  --org <name|id>        Organization            (CLOUDGATE_ORG)
  --project <name|id>    Project                 (CLOUDGATE_PROJECT)
  --env <name|id>        Environment             (CLOUDGATE_ENV)
  --service <name|id>    Service, by Config name (CLOUDGATE_SERVICE)
  --json                 Print the result as JSON
  --instance <url>       The Instance to ask     (CLOUDGATE_INSTANCE)
`,
  options: { ...TARGET_OPTIONS, json: { type: 'boolean' } },
  maxPositionals: 0,
  async run(context) {
    const { out, now, values, prompter } = context;
    const { instance, target, client } = await lookUpTarget(
      context,
      out.mode.canAsk ? { choose: chooserFor(prompter) } : {},
    );
    const facts = await out.withSpinner(`Asking ${instance.url}…`, () =>
      readServiceStatus(client, target.service),
    );

    if (values.json) {
      out.json({
        instance: instance.url,
        organization: target.organization,
        project: target.project,
        environment: target.environment,
        service: target.service,
        ...facts,
      });
      return EXIT.ok;
    }
    const latest = facts.latestDeployment;
    out.data(
      columns(
        [
          [
            'Service',
            `${target.service.configName} (${kindLabel(target.service.kind)})`,
          ],
          ['Environment', target.environment.name],
          ['Project', target.project.name],
          ['Instance', instance.url],
          ['State', facts.state ?? 'unknown'],
          ['Source', describeSource(facts.source)],
          ['Domains', facts.domains.length ? facts.domains.join(', ') : 'none'],
          [
            'Latest',
            latest
              ? `Deployment ${latest.id}  ${latest.status}  ${describeAgo(latest.createdAt, now())}`
              : 'no Deployment yet',
          ],
        ],
        out.dataStyle.dim,
      ),
    );
    return EXIT.ok;
  },
};
