import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { createHostedTraefikConfig } from '../traefik/config/hosted';

/**
 * `hosted-traefik-config` — prints the Hosted instance's Traefik routing
 * as a dynamic file-provider YAML document on stdout:
 *
 *     node dist/commands/hosted-traefik-config.js \
 *       --host cloudgate.octabyte.app \
 *       --console-url http://172.18.0.1:3000 --api-url http://172.18.0.1:4000
 *
 * `deploy/install.sh`'s hosted path runs it and writes the output to
 * `/etc/cloudgate/traefik/dynamic/hosted.yml`. A command rather than a shell
 * heredoc so the routing is the code `backend/test/traefik/hosted.spec.ts`
 * tests, and its gateway paths are the list held to the gateways.
 *
 * Needs nothing from the environment. Exit codes: 0 printed; 2 a usage error
 * (a missing flag, a host that is not a hostname, a URL that is not http(s)).
 */
export const EXIT_PRINTED = 0;
export const EXIT_USAGE = 2;

const USAGE =
  'Usage: hosted-traefik-config --host <hostname> --console-url <url> --api-url <url>';

/** Lower-case DNS labels, at least two: the one name a certificate is for. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface CommandIo {
  out: (text: string) => void;
  err: (line: string) => void;
}

export function runHostedTraefikConfig(argv: string[], io: CommandIo): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        host: { type: 'string' },
        'console-url': { type: 'string' },
        'api-url': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (values.help) {
    io.out(`${USAGE}\n`);
    return EXIT_PRINTED;
  }

  const missing = (['host', 'console-url', 'api-url'] as const)
    .filter((name) => typeof values[name] !== 'string' || values[name] === '')
    .map((name) => `--${name}`);
  if (missing.length > 0) {
    io.err(`Missing ${missing.join(', ')}.`);
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const host = values.host as string;
  const consoleUrl = values['console-url'] as string;
  const apiUrl = values['api-url'] as string;

  const problems: string[] = [];
  if (!HOSTNAME.test(host)) {
    problems.push(`--host "${host}" is not a lower-case hostname.`);
  }
  for (const [flag, value] of [
    ['--console-url', consoleUrl],
    ['--api-url', apiUrl],
  ] as const) {
    if (!isHttpOrigin(value)) {
      problems.push(`${flag} "${value}" is not an http(s) origin.`);
    }
  }
  if (problems.length > 0) {
    problems.forEach((line) => io.err(line));
    return EXIT_USAGE;
  }

  io.out(stringify(createHostedTraefikConfig({ host, consoleUrl, apiUrl })));
  return EXIT_PRINTED;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

if (require.main === module) {
  process.exitCode = runHostedTraefikConfig(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
