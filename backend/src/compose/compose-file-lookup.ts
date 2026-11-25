import { quote } from 'shell-quote';
import type { RunTarget } from '../remote/run-target';
import type { Compose } from './compose.schema';
import { composeCodeDirectory } from './compose.utils';
import { stackRootId } from './stack-root';

/**
 * The names Docker looks for when no compose file is given, in Docker's own
 * order (ADR-0091). A Compose Service with no file named finds its file among
 * these, in the clone each deploy makes, and so picks up a rename the next
 * deploy after it lands.
 */
export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

/** The file a lookup chose, and any other of the four it saw beside it. */
export interface FoundComposeFile {
  readonly file: string;
  readonly others: readonly string[];
}

/**
 * Prints, one per line, each of {@link COMPOSE_FILE_NAMES} that is a regular
 * file directly inside `directory`, and exits 0 whatever it finds, a missing
 * directory included: `RemoteExecService` rejects on a non-zero exit, so
 * "nothing there" is said on stdout. {@link findComposeFile} reads the answer.
 */
export function composeFileLookupCommand(directory: string): string {
  return `cd ${quote([directory])} 2>/dev/null && for f in ${COMPOSE_FILE_NAMES.join(' ')}; do if [ -f "$f" ]; then echo "$f"; fi; done; true`;
}

/**
 * The file Docker would use out of what {@link composeFileLookupCommand}
 * printed: the first of the four names present, with the rest that are
 * present, in the same order. `null` when none of the four is there.
 *
 * Pure, and the order comes from {@link COMPOSE_FILE_NAMES} rather than from
 * the order of the lines, so the choice does not hang on how the target
 * listed them.
 */
export function findComposeFile(listing: string): FoundComposeFile | null {
  const present = new Set(listing.split('\n').map((line) => line.trim()));
  const found = COMPOSE_FILE_NAMES.filter((name) => present.has(name));
  if (found.length === 0) return null;
  return { file: found[0], others: found.slice(1) };
}

/** The deploy log's line for a file the lookup found. */
export function composeFileLookupLogLine(found: FoundComposeFile): string {
  const line = `No compose file named: using ${found.file}`;
  return found.others.length === 0
    ? line
    : `${line} (also present, not used: ${found.others.join(', ')})`;
}

/** Why a deploy with no file named, and none of the four present, is refused. */
export function composeFileNotFoundMessage(): string {
  const names = [...COMPOSE_FILE_NAMES];
  const last = names.pop();
  return `No compose file named, and none found: looked for ${names.join(', ')} and ${last}`;
}

/** The row columns resolving a Compose's file reads. */
type ComposeFileRow = Pick<
  Compose,
  'appName' | 'sourceType' | 'composePath' | 'serverId'
> &
  Partial<Pick<Compose, 'composeId' | 'cloudAccountId'>>;

/** A row with its compose file known, which every command builder reads. */
export type WithComposeFile<T extends ComposeFileRow> = Omit<
  T,
  'composePath'
> & { composePath: string };

/**
 * How a Compose's file was settled for one run on its target:
 *
 * - `named`: the row names a path, or the source is `raw` (which keeps its own
 *   `docker-compose.yml`) — no lookup ran.
 * - `found`: no path is named, and the lookup found one of the four.
 * - `missing`: no path is named, and none of the four is in the clone.
 */
export type ComposeFileResolution<T extends ComposeFileRow> =
  | { readonly kind: 'named'; readonly compose: WithComposeFile<T> }
  | {
      readonly kind: 'found';
      readonly compose: WithComposeFile<T>;
      readonly found: FoundComposeFile;
    }
  | { readonly kind: 'missing' };

/**
 * Settles `row`'s compose file on `target`, in the clone that is there now
 * (ADR-0091). A named path always wins, with no lookup; a `raw` source never
 * looks either. Otherwise one program on the target lists which of the four
 * names the clone holds, and Docker's order picks.
 *
 * The deploy runs this after its clone, so a rename in a commit is what the
 * next deploy uses. Start, the Converted tab and the file card run it over
 * the clone the last deploy left, which holds the converted file under the
 * name that deploy found, so they read the file that deploy ran.
 */
export async function resolveComposeFile<T extends ComposeFileRow>(
  target: Pick<RunTarget, 'exec'>,
  row: T,
): Promise<ComposeFileResolution<T>> {
  if (row.composePath !== null || row.sourceType === 'raw') {
    return {
      kind: 'named',
      compose: { ...row, composePath: row.composePath ?? RAW_COMPOSE_PATH },
    };
  }
  const { stdout } = await target.exec(
    composeFileLookupCommand(
      composeCodeDirectory(stackRootId(row), row.appName),
    ),
  );
  const found = findComposeFile(stdout);
  if (!found) return { kind: 'missing' };
  return {
    kind: 'found',
    compose: { ...row, composePath: `./${found.file}` },
    found,
  };
}

/**
 * {@link resolveComposeFile} for a read that is not a deploy: a clone holding
 * none of the four reads as the first name, which is absent there, so the
 * read fails as a named file that is not on disk does.
 */
export async function composeFileForRead<T extends ComposeFileRow>(
  target: Pick<RunTarget, 'exec'>,
  row: T,
): Promise<WithComposeFile<T>> {
  const resolved = await resolveComposeFile(target, row);
  return resolved.kind === 'missing'
    ? { ...row, composePath: `./${COMPOSE_FILE_NAMES[0]}` }
    : resolved.compose;
}

/** What a `raw` source's builders read: it always writes its own file. */
const RAW_COMPOSE_PATH = './docker-compose.yml';
