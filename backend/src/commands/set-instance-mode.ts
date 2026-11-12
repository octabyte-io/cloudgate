import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DrizzleDB } from '../db/drizzle.module';
import * as schema from '../db/schema';
import {
  instanceModeSetting,
  SET_INSTANCE_MODE_COMMAND,
} from '../instance-mode/instance-mode';
import type { InstanceModeName } from '../instance-mode/instance-mode';
import {
  changeRecordedMode,
  ServicesOnPlatformHostRefusal,
} from '../instance-mode/recorded-mode';

/**
 * `set-instance-mode` — run on the platform host, by hand, to change the
 * Instance's recorded mode on purpose (ADR-0049). Every start compares
 * its setting against that record and refuses on a mismatch, so this is the
 * one way to switch modes:
 *
 *     cd /opt/cloudgate/backend
 *     set -a; . /etc/default/cloudgate-backend; set +a
 *     node dist/commands/set-instance-mode.js --mode hosted
 *
 * (`pnpm --filter backend set-instance-mode -- --mode hosted` is the same.)
 * Then change the setting in `/etc/default/cloudgate-backend` to match and
 * restart the backend; the backend already running keeps its old mode until
 * then, and a restart before the setting is changed refuses.
 *
 * Turning hosted on refuses while any Service has the platform host as its
 * place, and lists them (ADR-0053): the Hosted instance never runs Services
 * there. Needs only `DATABASE_URL`, and reads no instance mode of its own.
 *
 * Exit codes: 0 changed, or already that mode; 1 refused, nothing written;
 * 2 a usage error.
 */
export const COMMAND = SET_INSTANCE_MODE_COMMAND;

export const EXIT_CHANGED = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

export interface CommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const MODES: readonly InstanceModeName[] = ['hosted', 'self-hosted'];

const USAGE = `Usage: ${COMMAND} --mode <hosted|self-hosted>`;

/**
 * The command, given its database and its terminal: what `main` runs, and
 * what the e2e drives against the test database.
 */
export async function runSetInstanceMode(
  argv: string[],
  db: DrizzleDB,
  io: CommandIo,
): Promise<number> {
  let values: { mode?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: 'string' },
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
    return EXIT_CHANGED;
  }
  if (values.mode === undefined) {
    io.err('Missing --mode.');
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const to = values.mode as InstanceModeName;
  if (!MODES.includes(to)) {
    io.err(`--mode must be hosted or self-hosted, not "${values.mode}".`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  try {
    const change = await changeRecordedMode(db, to);
    if (!change.changed) {
      io.out(`The recorded mode is already ${to}. Nothing changed.`);
      return EXIT_CHANGED;
    }
    io.out(
      `Recorded mode changed from ${change.from ?? 'none recorded'} to ${to}. ` +
        `Set ${instanceModeSetting(to)} in /etc/default/cloudgate-backend ` +
        'and restart the backend; until then it keeps running in its old ' +
        'mode, and a start with the old setting refuses.',
    );
    return EXIT_CHANGED;
  } catch (error) {
    if (error instanceof ServicesOnPlatformHostRefusal) {
      io.err(error.message);
      for (const service of error.services) {
        io.err(
          `  - ${service.kind} "${service.name}" (${service.serviceId}) in ` +
            `${service.organizationName} / ${service.projectName} / ` +
            service.environmentName,
        );
      }
      return EXIT_REFUSED;
    }
    throw error;
  }
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
    process.exitCode = await runSetInstanceMode(argv, db, {
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
