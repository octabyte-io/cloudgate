import { eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { cloudAccount, server } from '../db/schema';

/** What a `null` Server id is (ADR-0008), in the console's own words. */
const PLATFORM_HOST = "Cloudgate's own host";

/**
 * The line that opens a Deployment's log with where it builds and where it
 * runs.
 *
 * With a dedicated build Server the log named neither machine, so an operator
 * reading a failed or slow build could not tell where it had happened — and
 * the console's "Builds on" card shows the *current* setting, not the one a
 * past Deployment used. The log is the one record written at deploy time, so
 * this is where the answer is kept.
 *
 * `buildServerId` is the resolved build host ({@link buildHostServerId}), not
 * the raw column, so a Server that builds where it runs reads as one machine.
 * Each Server is named by its row's `name` and `ipAddress` — neither is a
 * secret, and both are what the operator typed when adding it. A row that is
 * gone (deleted between the queue and this read) is named by its id rather
 * than failing a deploy over a log line, and so is every Server when the read
 * itself fails: this line is read ahead of every refusal so that each can
 * carry it, and a log line must never be what fails a deploy or what replaces
 * the reason a refusal gives. The platform host has no row and costs no query.
 *
 * The name is operator-authored and has no charset, so the caller `quote()`s
 * the whole line into the program like every other word the engine
 * interpolates (H-34).
 */
export async function deployHostsLogLine(
  db: DrizzleDB,
  buildServerId: string | null,
  runServerId: string | null | undefined,
): Promise<string> {
  const build = buildServerId || null;
  const run = runServerId || null;
  const ids = [...new Set([build, run].filter((id) => id !== null))];
  const rows = ids.length === 0 ? [] : await namedRows(db, ids);
  const describe = (serverId: string | null): string => {
    if (serverId === null) return PLATFORM_HOST;
    const row = rows.find((candidate) => candidate.serverId === serverId);
    return row
      ? `Server '${row.name}' (${row.ipAddress})`
      : `Server '${serverId}'`;
  };

  if (build === run) {
    return `🔧 [Build] Building and running on ${describe(build)}.`;
  }
  return `🔧 [Build] Building on build ${describe(build)}; the service runs on ${describe(run)}.`;
}

/** The two rows' names and addresses, or none when they cannot be read. */
async function namedRows(
  db: DrizzleDB,
  ids: string[],
): Promise<{ serverId: string; name: string; ipAddress: string }[]> {
  try {
    return await db
      .select({
        serverId: server.serverId,
        name: server.name,
        ipAddress: server.ipAddress,
      })
      .from(server)
      .where(inArray(server.serverId, ids));
  } catch {
    return [];
  }
}

/**
 * {@link deployHostsLogLine} for a stack on its own Stack VM (ADR-0070),
 * which both builds and runs it: named as the stack's Stack VM in its Cloud
 * account (by the name the operator gave it) and region, never as a Server.
 * As there, an account that cannot be read is named by its id rather than
 * failing a deploy over a log line.
 */
export async function stackVmHostsLogLine(
  db: DrizzleDB,
  place: { cloudAccountId: string; region: string | null },
): Promise<string> {
  let account = `'${place.cloudAccountId}'`;
  try {
    const [row] = await db
      .select({ name: cloudAccount.name })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, place.cloudAccountId));
    if (row) account = `'${row.name}'`;
  } catch {
    // Named by its id, as above.
  }
  return `🔧 [Build] Building and running on the stack's Stack VM in Cloud account ${account}, region ${place.region ?? 'unknown'}.`;
}
