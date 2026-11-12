import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  createInstanceOrganization,
  InstanceOrganizationRefusal,
} from '../auth/instance-organization';
import type { DrizzleDB } from '../db/drizzle.module';
import * as schema from '../db/schema';

/**
 * `create-instance-organization` — run on the platform host, once, to make the
 * first account and the Instance organization (ADR-0051).
 *
 *     cd /opt/cloudgate/backend
 *     set -a; . /etc/default/cloudgate-backend; set +a
 *     node dist/commands/create-instance-organization.js \
 *       --email ops@octabyte.io --first-name Ada --last-name Lovelace \
 *       --organization-name Octabyte [--password-stdin]
 *
 * (`pnpm --filter backend create-instance-organization -- …` is the same.)
 *
 * The password is read from stdin with `--password-stdin` (its first line);
 * without it one is generated and printed once. It needs only `DATABASE_URL`,
 * and runs against the database the backend uses — the backend need not be
 * stopped, and the console's sign-up form opens the moment this commits.
 *
 * Exit codes: 0 created; 1 refused (an Instance organization already exists,
 * the address is taken, a field is invalid) with nothing written; 2 a usage
 * error.
 */
export const COMMAND = 'create-instance-organization';

export const EXIT_CREATED = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

export interface CommandIo {
  /** The whole of stdin, read only with `--password-stdin`. */
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: ${COMMAND} --email <address> --first-name <name> [--last-name <name>] --organization-name <name> [--password-stdin]`;

/** A password nobody chose, for a run with no `--password-stdin`. */
function generatedPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * The command, given its database and its terminal: what `main` runs, and what
 * the e2e drives against the test database.
 */
export async function runCreateInstanceOrganization(
  argv: string[],
  db: DrizzleDB,
  io: CommandIo,
): Promise<number> {
  let values: {
    email?: string;
    'first-name'?: string;
    'last-name'?: string;
    'organization-name'?: string;
    'password-stdin'?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        email: { type: 'string' },
        'first-name': { type: 'string' },
        'last-name': { type: 'string' },
        'organization-name': { type: 'string' },
        'password-stdin': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (values.help) {
    io.out(USAGE);
    return EXIT_CREATED;
  }

  const missing = (['email', 'first-name', 'organization-name'] as const)
    .filter((name) => values[name] === undefined)
    .map((name) => `--${name}`);
  if (missing.length > 0) {
    io.err(`Missing ${missing.join(', ')}.`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const fromStdin = values['password-stdin'] === true;
  const password = fromStdin
    ? (await io.readStdin()).split(/\r?\n/)[0]
    : generatedPassword();

  try {
    const created = await createInstanceOrganization(db, {
      email: values.email!,
      firstName: values['first-name']!,
      lastName: values['last-name'] ?? '',
      organizationName: values['organization-name']!,
      password,
    });
    io.out(
      `Created ${created.email}, owner of the Instance organization "${created.organizationName}". Sign-up is now open.`,
    );
    if (!fromStdin) {
      io.out(`Password (shown once): ${password}`);
    }
    return EXIT_CREATED;
  } catch (error) {
    if (error instanceof InstanceOrganizationRefusal) {
      io.err(error.message);
      return EXIT_REFUSED;
    }
    throw error;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write(
      'DATABASE_URL is not set. Load /etc/default/cloudgate-backend first.\n',
    );
    process.exitCode = EXIT_USAGE;
    return;
  }
  const pool = new Pool({ connectionString: url });
  try {
    const db: DrizzleDB = drizzle(pool, { schema });
    process.exitCode = await runCreateInstanceOrganization(argv, db, {
      readStdin: () => readAll(process.stdin),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT_REFUSED;
  });
}
