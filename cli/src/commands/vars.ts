import { variableListSchema, variableNameSchema } from 'api-schemas';
import type { ChangeVariables, VariableList } from 'api-schemas';

import type { Command, CommandContext } from '../command.js';
import { usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import { columns } from '../format.js';
import { kindRefusal } from '../service-status.js';
import { TARGET_OPTIONS } from '../target.js';
import { chooserFor, lookUpTarget } from '../target-session.js';
import type { TargetSession } from '../target-session.js';

/** What the words after `vars` ask for, decided before any request. */
export type VarsAction =
  | { readonly action: 'list' }
  | {
      readonly action: 'set';
      readonly set: Readonly<Record<string, string>>;
      /** A bare `KEY`, whose value is asked for or read from stdin. */
      readonly ask?: string;
    }
  | { readonly action: 'unset'; readonly names: readonly string[] };

const HELP = 'Run cloudgate vars --help.';

/**
 * A word as a refusal may quote it: anything after its first `=` could be a
 * value, so it is left out (`A=…`), whichever way the word was misused.
 */
function shown(word: string): string {
  const at = word.indexOf('=');
  return at === -1 ? word : `${word.slice(0, at)}=…`;
}

function checkName(name: string): string {
  if (!variableNameSchema.safeParse(name).success) {
    throw usageError(`"${shown(name)}" is not a variable name`, HELP);
  }
  return name;
}

function once(names: readonly string[]): void {
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw usageError(`${twice} is named twice`, HELP);
}

/**
 * The words after `vars`, as an action, or wrong use (exit 2):
 * `list`; `set KEY=VALUE …`, split at each pair's first `=`; `set KEY` alone,
 * whose value comes from a hidden question or stdin; `unset KEY …`.
 */
export function varsAction(words: readonly string[]): VarsAction {
  const [action, ...rest] = words;
  switch (action) {
    case 'list':
      if (rest.length > 0) {
        throw usageError(
          `cloudgate vars list takes no arguments, not "${rest.map(shown).join(' ')}"`,
          HELP,
        );
      }
      return { action: 'list' };
    case 'set': {
      if (rest.length === 0) {
        throw usageError(
          'cloudgate vars set needs KEY=VALUE, or one KEY',
          HELP,
        );
      }
      const bare = rest.filter((word) => !word.includes('='));
      if (bare.length > 0) {
        if (rest.length > 1) {
          throw usageError(
            'cloudgate vars set asks for one KEY at a time; give the others as KEY=VALUE in a second run',
            HELP,
          );
        }
        return { action: 'set', set: {}, ask: checkName(bare[0]) };
      }
      const pairs = rest.map((word) => {
        const at = word.indexOf('=');
        if (at === 0) throw usageError('a KEY=VALUE with no KEY', HELP);
        return [checkName(word.slice(0, at)), word.slice(at + 1)] as const;
      });
      once(pairs.map(([name]) => name));
      return { action: 'set', set: Object.fromEntries(pairs) };
    }
    case 'unset':
      if (rest.length === 0) {
        throw usageError('cloudgate vars unset needs KEY', HELP);
      }
      rest.forEach((word) => checkName(word));
      once(rest);
      return { action: 'unset', names: rest };
    case undefined:
      throw usageError('cloudgate vars needs list, set or unset', HELP);
    default:
      throw usageError(
        `unknown action "${shown(action)}" for cloudgate vars`,
        HELP,
      );
  }
}

/**
 * The value of a bare `KEY`: asked with hidden typing at a terminal, read
 * from stdin otherwise (one last line break dropped, as `echo` adds one).
 * A terminal that may not be asked is refused rather than read, so the run
 * never sits waiting on a keyboard nobody is told about.
 */
async function valueFor(
  name: string,
  context: CommandContext,
): Promise<string> {
  const { stdin, out, prompter } = context;
  const missing = usageError(
    `no value for ${name}`,
    `Pipe it in (printf %s "$VALUE" | cloudgate vars set ${name}), or pass ${name}=VALUE.`,
  );
  if (stdin.isTTY) {
    if (!out.mode.canAsk) throw missing;
    return prompter.secret(`Value for ${name} (hidden): `);
  }
  const piped = (await stdin.read()).replace(/\r?\n$/, '');
  if (piped === '') throw missing;
  return piped;
}

/** The target's Application, or the refusal of any other kind. */
function applicationOf(session: TargetSession): string {
  const { service } = session.target;
  const wrongKind = kindRefusal(service, 'vars');
  if (wrongKind) throw wrongKind;
  return `/applications/${encodeURIComponent(service.id)}/variables`;
}

function printList(context: CommandContext, list: VariableList): void {
  const { out, values } = context;
  const entries = list.variables.map((variable) => ({
    name: variable.name,
    linkedTo: variable.linkedTo
      ? `${variable.linkedTo.source}.${variable.linkedTo.output}`
      : null,
  }));
  if (values.json) {
    out.json(entries);
    return;
  }
  if (entries.length === 0) {
    out.note('No variables.');
    return;
  }
  out.data(
    columns(
      [
        ['NAME', 'VALUE'],
        ...entries.map(
          (entry) =>
            [
              entry.name,
              entry.linkedTo ? `linked to ${entry.linkedTo}` : 'set',
            ] as const,
        ),
      ],
      out.dataStyle.dim,
    ),
  );
  out.note(
    `${entries.length} ${entries.length === 1 ? 'variable' : 'variables'}. Values are never shown.`,
  );
}

/**
 * `cloudgate vars list | set | unset` (CLI spec): the Service's own
 * runtime variables in the Environment `--env` or the Folder link picks, by
 * name. No value is ever printed or asked of the Instance; the routes it uses
 * never answer with one (ADR 0019). The Environment's and Project's shared
 * variables, build arguments and build secrets stay in the console, and
 * nothing is deployed.
 */
export const vars: Command = {
  name: 'vars',
  group: 'THIS FOLDER',
  summary: "List, set and unset the Service's variables",
  help: `List, set and unset the Service's own variables in one Environment.
Values are never printed.

USAGE
  cloudgate vars list [--json]
  cloudgate vars set KEY=VALUE [KEY=VALUE …]
  cloudgate vars set KEY          Asks for the value (hidden), or reads stdin
  cloudgate vars unset KEY [KEY …]

  Changes take effect at the next deploy. A variable linked to another
  Service's value can't be set here. Applications only.

FLAGS
  --org <name|id>        Organization            (CLOUDGATE_ORG)
  --project <name|id>    Project                 (CLOUDGATE_PROJECT)
  --env <name|id>        Environment             (CLOUDGATE_ENV)
  --service <name|id>    Service, by Config name (CLOUDGATE_SERVICE)
  --json                 vars list only: entries with name and linkedTo
  --instance <url>       The Instance to use     (CLOUDGATE_INSTANCE)
`,
  options: { ...TARGET_OPTIONS, json: { type: 'boolean' } },
  maxPositionals: Number.POSITIVE_INFINITY,
  async run(context) {
    const { out, prompter, values } = context;
    const wanted = varsAction(context.positionals);
    if (values.json && wanted.action !== 'list') {
      throw usageError('--json is for cloudgate vars list only', HELP);
    }

    const session = await lookUpTarget(
      context,
      out.mode.canAsk ? { choose: chooserFor(prompter) } : {},
    );
    const path = applicationOf(session);
    const { client, target } = session;

    if (wanted.action === 'list') {
      printList(
        context,
        await out.withSpinner('Reading the variable names…', () =>
          client.get(path, variableListSchema),
        ),
      );
      return EXIT.ok;
    }

    const change: ChangeVariables =
      wanted.action === 'unset'
        ? { unset: [...wanted.names] }
        : {
            set: wanted.ask
              ? { [wanted.ask]: await valueFor(wanted.ask, context) }
              : { ...wanted.set },
          };
    await out.withSpinner('Saving…', () =>
      client.patch(path, change, variableListSchema),
    );
    const named = Object.keys(change.set ?? {}).concat(change.unset ?? []);
    out.note(
      `✓ ${wanted.action === 'unset' ? 'Unset' : 'Set'} ${named.join(', ')} on ${target.service.configName} in ${target.environment.name}. Run cloudgate deploy to pick it up.`,
    );
    return EXIT.ok;
  },
};
