/**
 * A `env` column, read.
 *
 * Both a `project` row and an `environment` row carry one, and it is the same
 * thing in both: a single encrypted text blob in dotenv shape
 * (`db/columns.ts` — `encryptedText`, AES-256-GCM, decrypted on the way out).
 * There is no per-variable row, no per-variable endpoint, and **no flag saying
 * which line is a secret**. Everything below follows from that.
 *
 * Nothing here writes. The blob is edited as a block and sent whole, because
 * that is the only shape `PATCH /projects/:id` and `PATCH /environments/:id`
 * accept — parsing it, editing a row and reassembling it would silently reorder
 * someone's comments.
 */

export type EnvVariable = {
  key: string;
  value: string;
  /** 1-based, so a parse error can name the line the way an editor does. */
  line: number;
  secret: boolean;
};

/**
 * Keys whose *value* is hidden until someone asks for it.
 *
 * This is a guess made from the name, and it is the only guess available: the
 * column is encrypted as a whole precisely because any line in it might be a
 * credential, and nothing in the data distinguishes them. So the list is
 * deliberately **wide** — `DATABASE_URL` is on it because a connection string
 * carries a password in the middle of it, and a rule that missed that would be
 * worse than no rule at all. The screen says out loud that the match is on the
 * name, so a hidden `PUBLIC_KEY` reads as cautious rather than as broken.
 */
const SECRET_KEY =
  /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|SALT|SIGNATURE|CERT|DSN|_URL|_URI)/i;

export function looksSecret(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * The variables a blob defines, in the order their keys first appear, **read
 * the way a deploy reads them**.
 *
 * The backend hands the same blob to `dotenv.parse` (`docker/docker.utils.ts`,
 * `prepareEnvironmentVariables`), and whatever that yields is what a container
 * gets. So this is a port of that parser, not a reading of our own: a line
 * split read `B="x` + `y=z"` as a variable `B` holding `"x` and a second
 * variable `y`, while the container got one `B` holding two lines. The
 * rules below are dotenv's (17.x), and `env-blob.fixtures.json` is the table
 * that holds both sides to them — the console's test and the backend's
 * `test/docker/env-blob-parity.spec.ts` run the same rows.
 *
 * - A single-, double- or back-quoted value runs to its closing quote, across
 *   lines; the quotes are not part of it. Inside double quotes `\n` and `\r`
 *   are line breaks.
 * - An unquoted value ends at the line's end or at a `#`.
 * - `export KEY=value` and `KEY: value` are variables too.
 * - A key set twice is one variable, holding the last value.
 *
 * Comments and blank lines are dropped — this is the reading view, and a
 * comment is guidance for whoever edits the block, which is the other view. A
 * line with no `=` (or `: `) is not a variable and is dropped too rather than rendered as
 * a key with an empty value, which would be a claim the file does not make.
 */
export function parseEnvBlob(env: string | null | undefined): EnvVariable[] {
  if (!env) return [];

  const text = env.replace(/\r\n?/g, "\n");
  const byKey = new Map<string, EnvVariable>();
  for (const match of text.matchAll(LINE)) {
    const key = match[1];
    const raw = (match[2] ?? "").trim();
    let value = raw.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (raw.startsWith('"')) {
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }

    const keyAt = match.index + match[0].indexOf(key);
    const line = text.slice(0, keyAt).split("\n").length;
    // A repeated key keeps its first place and takes the last value, which is
    // what assigning into dotenv's result object does.
    const first = byKey.get(key);
    byKey.set(key, { key, value, line: first?.line ?? line, secret: looksSecret(key) });
  }
  return [...byKey.values()];
}

/**
 * dotenv's own line grammar, verbatim (`dotenv/lib/main.js`, 17.4.2). Copied
 * rather than rewritten, because the point of it is to be *that* grammar; if
 * the backend upgrades `dotenv` and the grammar moves, the backend's parity
 * spec reds on the shared fixtures and this is the line to re-copy.
 */
export const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** How many variables a blob defines. The figure the lists and asides show. */
export function countVariables(env: string | null | undefined): number {
  return parseEnvBlob(env).length;
}
