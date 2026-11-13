import type { Command } from '../command.js';
import { EXIT } from '../exit-codes.js';
import { WORKING_COPY_FILE } from '../folder-link.js';
import { runPlanStep } from '../plan-step.js';
import { connectToInstance } from '../target-session.js';
import { findProjectFolder } from '../working-copy.js';

/**
 * `cloudgate config plan`: the nearest **Project folder**'s working copy
 * sent back as a plan, each Environment's shown, and applied on a yes
 * (ADR-0080). It builds nothing beyond what applying the plans queues; a
 * root `cloudgate deploy` runs the same step first.
 */
export const configPlan: Command = {
  name: 'config plan',
  group: 'THIS FOLDER',
  summary: "Send this Project folder's cloudgate.yaml as a plan, and apply it",
  help: `Send this Project folder's ${WORKING_COPY_FILE} to Cloudgate as a plan, and apply it.

USAGE
  cloudgate config plan [--yes]

  Sends ${WORKING_COPY_FILE} at the Project folder (made by cloudgate link
  --whole-project), refused when the Project config has changed in
  Cloudgate since it was downloaded (cloudgate config pull gets it again).
  Prints what each Environment's plan creates, changes and destroys, and
  asks before applying it. A Service it destroys, or upgrades to a new major
  version, is applied only once its Config name is typed. With no terminal
  it needs --yes. A no, or a wrong name, applies nothing and exits 1.

FLAGS
  --yes                  Apply without asking; a plan that destroys a Service
                         or makes a major upgrade is still refused
`,
  options: { yes: { type: 'boolean' } },
  maxPositionals: 0,
  async run(context) {
    const found = findProjectFolder(context.cwd, 'config plan');
    const { link } = found;
    const { client } = await connectToInstance(context, found);
    const outcome = await runPlanStep(
      context,
      client.inOrganization(link.organizationId, link.names.organization),
      found,
      { yes: context.values.yes === true },
    );
    // A no, or a wrong Config name, applied nothing: exit 1, as a root
    // `cloudgate deploy` does, so a script can tell it from an apply.
    if (outcome.kind === 'declined') return EXIT.failed;
    return outcome.kind === 'applied' && outcome.failed > 0
      ? EXIT.failed
      : EXIT.ok;
  },
};
