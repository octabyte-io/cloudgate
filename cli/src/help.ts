import type { Command } from './command.js';

const GROUPS: ReadonlyArray<Command['group']> = [
  'LOG IN',
  'THIS FOLDER',
  'TEMPLATES',
];

/**
 * `cloudgate --help`, from the accepted help text (CLI spec): its sections,
 * flags, variables and exit codes are locked, and its command list is built
 * from the registry so it never names a command this version lacks.
 */
export function overviewHelp(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((command) => command.name.length)) + 2;
  const sections = GROUPS.map((group) => {
    const members = commands.filter((command) => command.group === group);
    if (members.length === 0) return '';
    const lines = members
      .map(
        (command) =>
          `  ${command.name.padEnd(Math.max(width, 19))}${command.summary}`,
      )
      .join('\n');
    return `${group}\n${lines}\n\n`;
  }).join('');

  return `Deploy a folder to Cloudgate from your terminal.

USAGE
  cloudgate <command> [flags]

${sections}FLAGS
  --instance <url>   The Instance to use          (CLOUDGATE_INSTANCE)
  --json             Print the result as JSON
  --no-input         Never ask a question; refuse instead (also when CI is set)
  --no-color         Print without colour         (also NO_COLOR)
  -h, --help         Show help for a command
  --version          Show the CLI's version

PICKING THE SERVICE  (link, deploy, status, logs, vars)
  --org <name|id>        Organization            (CLOUDGATE_ORG)
  --project <name|id>    Project                 (CLOUDGATE_PROJECT)
  --env <name|id>        Environment             (CLOUDGATE_ENV)
  --service <name|id>    Service, by Config name (CLOUDGATE_SERVICE)
  A flag wins over its variable, and both win over this folder's link.

IN CI
  CLOUDGATE_KEY      A Personal key made in the console. It wins over any
                     saved login and is never saved.

EXIT CODES
  0    it worked
  1    it failed (the Instance refused, or the Deployment failed or was cancelled)
  2    wrong use (unknown flag, or input missing and no one to ask)
  3    not logged in, or the login ended or was refused
  130  stopped with Ctrl-C

Learn more: cloudgate <command> --help
`;
}
