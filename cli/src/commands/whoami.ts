import { whoamiSchema } from 'api-schemas';

import type { Command } from '../command.js';
import { EXIT } from '../exit-codes.js';
import { findNearestLink } from '../folder-link.js';
import { columns, describeKeyEnd } from '../format.js';
import { connectToInstance } from '../target-session.js';

/**
 * `cloudgate whoami [--json]`: the Instance, the email, the Organization in use
 * and when the key ends. It exits 0 whenever it could read the facts.
 */
export const whoami: Command = {
  name: 'whoami',
  group: 'LOG IN',
  summary: 'Show who you are logged in as, and where',
  help: `Show who you are logged in as, and where.

USAGE
  cloudgate whoami [--json]

  Prints the Instance, your email, the Organization in use and when your
  key ends.

FLAGS
  --instance <url>   The Instance to ask        (CLOUDGATE_INSTANCE)
  --json             Print the result as JSON; it adds keyFrom, where the
                     key came from ("login" for a saved login, "env" for
                     CLOUDGATE_KEY)
`,
  options: { json: { type: 'boolean' } },
  maxPositionals: 0,
  async run(context) {
    const { out, now, values } = context;
    const {
      instance: choice,
      credential,
      client,
    } = await connectToInstance(context, findNearestLink(context.cwd));
    const instance = choice.url;
    const facts = await out.withSpinner(`Asking ${instance}…`, () =>
      client.get('/users/me/whoami', whoamiSchema),
    );
    const keyEndsAt = facts.key?.expiresAt ?? null;

    if (values.json) {
      out.json({
        instance,
        email: facts.email,
        organization: facts.organization,
        keyFrom: credential.from,
        keyEndsAt,
      });
      return EXIT.ok;
    }
    out.data(
      columns(
        [
          ['Instance', instance],
          ['Logged in as', facts.email],
          ['Organization', facts.organization?.name ?? 'none'],
          ['Key ends', describeKeyEnd(keyEndsAt, now())],
        ],
        out.dataStyle.dim,
      ),
    );
    return EXIT.ok;
  },
};
