import type { Command } from '../command.js';
import { CliError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import { instanceAddress } from '../instance.js';

/**
 * `cloudgate instance list [--json]`: the Instances this computer is
 * logged in to, the current one marked. It reads the saved logins only and
 * asks no Instance anything, so it works offline.
 */
export const instanceList: Command = {
  name: 'instance list',
  group: 'LOG IN',
  summary: 'Show the Instances you are logged in to',
  help: `Show the Instances you are logged in to, marking the current one with *.

USAGE
  cloudgate instance list [--json]

  The current Instance is the one commands use when no --instance,
  CLOUDGATE_INSTANCE or folder link names another. Asks no Instance.

FLAGS
  --json             Print the result as JSON: one entry per Instance, with
                     instance, email, current and keyEndsAt
`,
  options: { json: { type: 'boolean' } },
  maxPositionals: 0,
  async run({ out, logins, values }) {
    const { current, logins: saved } = await logins.list();
    if (values.json) {
      out.json(
        saved.map((login) => ({
          instance: login.instance,
          email: login.email,
          current: login.instance === current,
          keyEndsAt: login.keyEndsAt,
        })),
      );
      return EXIT.ok;
    }
    if (saved.length === 0) {
      out.note('You are not logged in to any Instance. Run: cloudgate login');
      return EXIT.ok;
    }
    const width = Math.max(
      'INSTANCE'.length,
      ...saved.map((login) => login.instance.length),
    );
    const lines = [
      `   ${'INSTANCE'.padEnd(width + 3)}LOGGED IN AS`,
      ...saved.map(
        (login) =>
          `${login.instance === current ? '*' : ' '}  ${login.instance.padEnd(width + 3)}${login.email}`,
      ),
    ];
    out.data(`${lines.join('\n')}\n`);
    return EXIT.ok;
  },
};

/**
 * `cloudgate instance use <url>`: makes a saved login's Instance the
 * current one. Refuses (exit 3) an Instance with no login here, naming the
 * login to run: it never starts one by itself.
 */
export const instanceUse: Command = {
  name: 'instance use',
  group: 'LOG IN',
  summary: 'Switch the current Instance',
  help: `Switch the current Instance.

USAGE
  cloudgate instance use <url>

  Commands then use this Instance when no --instance, CLOUDGATE_INSTANCE
  or folder link names another. You must be logged in to it already.
`,
  options: {},
  maxPositionals: 1,
  async run({ out, logins, positionals, allowHttp }) {
    const [given] = positionals;
    if (!given) {
      throw new CliError(
        'name the Instance to use',
        EXIT.usage,
        'Run: cloudgate instance use <url>. cloudgate instance list shows yours.',
      );
    }
    const instance = instanceAddress(given, { allowHttp });
    if (!(await logins.use(instance))) {
      throw new CliError(
        `you are not logged in to ${instance}`,
        EXIT.notLoggedIn,
        `Run: cloudgate login --instance ${instance}`,
      );
    }
    out.note(`✓ Now using ${instance}`);
    return EXIT.ok;
  },
};
