import { getTableColumns, is, Table } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { createBackupSchema } from '../../src/backups/dto/backup.dto';
import * as schema from '../../src/db/schema';

/**
 * The property, stated once:
 *
 * > a column whose name says it holds a credential is stored encrypted at rest
 * > (ADR 0006), or the reason it is not is written down
 *
 * **What broke.** `application.refreshToken` is the deploy-webhook secret —
 * a nanoid Cloudgate mints, rotates through
 * `ApplicationsService.refreshToken`, and shows the operator as the thing that
 * authorizes an inbound trigger. `RollbacksService`'s `EXCLUDED_FROM_CONTEXT`
 * had classified it as a secret since that list was written, on the stated
 * ground that an excluded name "would land in this JSON as plaintext"; the
 * table stored it as plain `text`. So the two disagreed about what the column
 * was, for the entire life of the column, and `compose.refreshToken` — the
 * identical column on the object a webhook would redeploy *every* service of —
 * was never noticed at all.
 *
 * **Nothing was ever going to say so.** `encryptedText` and `text` have the
 * same `dataType()`, so the two are indistinguishable to the compiler and to
 * `drizzle-kit`: `meta/0064_snapshot.json` records `refresh_token` and the
 * `encryptedText` column `env` beside it as the same four keys, and running
 * `drizzle-kit generate` against the changed schema answers "No schema
 * changes, nothing to migrate", which is why encrypting them shipped no
 * migration. They are
 * indistinguishable to a suite too, except where a spec happened to go and
 * look at the bytes at rest — `gitlab.e2e-spec.ts` does, for the three secrets
 * it knows about — and a column nobody wrote that assertion for is invisible
 * in exactly the direction that matters. That is the definition of something
 * to assert over the tree rather than fix one column at a time
 * (`parent-id-writes.spec.ts`' argument).
 *
 * **What this can and cannot see.** It reads names, so it finds the failure
 * mode the deploy-webhook secret was — a column *called* a token, secret,
 * password or key that is not one of the encrypted types — and it cannot find a
 * secret whose name says nothing, or one that is a *field* rather than a
 * column. Three of those were read by hand in the original sweep and are
 * recorded here rather than in a ticket nobody opens, because a later reader
 * deserves to know the sweep was not only a regex:
 *
 * - **`schedule.script`** — a shell script an operator writes and Cloudgate
 *   materializes as `script.sh` on a Server, then runs there on a cron.
 *   `mount.content` and `patch.content` are `encryptedText` on precisely the
 *   argument that a file body is where an operator puts a credential, and a
 *   script is that with a shebang. **Closed** by a change that established that
 *   nothing queries the column by value, pinned the author's own round trip
 *   and the plaintext the host receives, and wrote the rule the three of them
 *   are instances of as ADR 0015. It is now held by
 *   {@link ENCRYPTED_BY_ARGUMENT} below, which is the half of this file that
 *   reads an argument instead of a name.
 * - **`compose.composeFile`** — a docker-compose file, which routinely carries
 *   literal `environment:` values even though `compose.env` exists beside it.
 *   **Closed since.** This bullet used to carry the original sweep's recorded
 *   reason for leaving it — that the file is *edited in a code editor, diffed
 *   and templated* — and none of the three was a reason: `encryptedText`
 *   converts at the driver boundary, so all nine readers in the four modules
 *   the `schedule.script` change could not own needed no edit at all, which the
 *   closing change verified rather than assumed. Nothing queried it either, so
 *   the one property that *would* have exempted it never applied. It is now
 *   held by {@link ENCRYPTED_BY_ARGUMENT} below, and the argument lives in ADR
 *   0015 rather than in this comment — which is the shape of comment that let
 *   the question be decided twice, and is the reason a bullet here now points
 *   at an ADR instead of carrying a reason of its own.
 * - **`MetricsConfig.server.token`** — the deploy-webhook failure mode a level
 *   down, and the one worth a ticket. It is a live shared secret
 *   (`monitoring.service`'s "token-authenticated receive endpoint"),
 *   operator-supplied through `admin.setupMonitoring`, and it sat inside the
 *   `jsonb` `metricsConfig` on *both* `server` and `web_server_settings`.
 *   **Closed** by the change that converted both columns to `encryptedJson` and
 *   moved the token comparison out of SQL into `NotificationsService`; the
 *   second property below is the one that now holds it, and the paragraph on
 *   {@link IN_SCOPE} records what changed about this file's reach.
 *
 * None of the three is a name this file could have found — the first two
 * because adding `script`, `file` or `content` to the vocabulary would only
 * produce false positives on `dockerfile` and `command`, and the third because
 * it is not a column at all. The vocabulary is a floor, not the whole duty of
 * care.
 */

/**
 * The words that make a column name a claim about its contents. Matched
 * against whole words, not substrings: `sshKeyId`, `uniqueConfigKey` and
 * `publicKey` all end in `key` and none of them is a secret, so a substring
 * match would make the exception list longer than the property.
 *
 * Single words only, because {@link namesACredential} splits a camelCase name
 * before matching: a compound entry like `apikey` or `privatekey` could only
 * ever match a column property spelled in one lowercase run, which is not a
 * shape a drizzle property name takes anywhere in `src` — `ai.apiKey` and
 * `certificate.privateKey` are found through `key`. Three such entries were
 * dropped from this regex for reading as coverage while matching nothing.
 */
const VOCABULARY =
  /^(token|secret|secrets|password|passwd|credential|credentials|passphrase|salt|signature|key|keys)$/;

/**
 * Only `text` columns are in scope, which is also what both secret-bearing
 * types report: `encryptedText` and `encryptedJson` are `text` at rest, so a
 * column that satisfies this property is in scope alongside the ones that do
 * not.
 *
 * What that excludes is a `serial`, `integer`, `boolean` or `timestamp`, none
 * of which can hold a credential or be given either type — so
 * `domain.uniqueConfigKey` (a `serial` Traefik counter) and
 * `account.accessTokenExpiresAt` (a `timestamp`) are out by construction
 * rather than by being argued about below. It also excludes `jsonb`, which is
 * *not* the same kind of exclusion: a `jsonb` blob can hold a credential and
 * `metricsConfig` did. That gap is what {@link jsonDefaults} below covers, on
 * a different signal — a name-based property over a `jsonb` column can only
 * read the column's *own* name, and no `jsonb` column in this schema is
 * called anything a credential vocabulary would match (`metricsConfig`,
 * `whitelabelingConfig`, `permission`, `metrics`, `metadata`, `features`).
 * The secret was a *field*, and fields are in the type argument.
 */
const IN_SCOPE = /^text(\[\])?$/;

/**
 * better-auth's own tables, exempt as a set (§2.6: they "keep the shape
 * better-auth gives them"), and for a reason stronger than convention.
 *
 * better-auth writes these rows through its own drizzle adapter, so the column
 * type here is not the only thing that would have to agree — and three of the
 * columns are looked up **by value** (`session.token`, `apikey.key`,
 * `verification.value`), which AES-256-GCM under a random IV makes impossible:
 * the same plaintext encrypts to different bytes every time, so `where token =
 * $1` matches nothing. Each is already protected by better-auth itself rather
 * than left bare: `account.password` is scrypt-hashed, `apikey.key` is hashed
 * (which the deploy-webhook secret, handed back on its row, is not),
 * `twoFactor.secret` and `backupCodes` are symmetrically encrypted by the
 * two-factor plugin under `BETTER_AUTH_SECRET`, and `account.accessToken` /
 * `refreshToken` / `idToken` are social-sign-in columns that `auth.config.ts`
 * configures no provider for and nothing populates.
 *
 * Listed by table so that a *Cloudgate* table is never waved through here.
 */
const BETTER_AUTH_TABLES: readonly string[] = [
  'account',
  'apikey',
  'session',
  'twoFactor',
  'user',
  'verification',
];

/**
 * The plain-`text` exceptions, each with the sentence that makes it one. A
 * reason rather than a bare name: the deploy-webhook bug existed because
 * `refreshToken` sat on a secrets list with nothing next to it saying why, and
 * a list of names with no arguments is the same artefact one level down.
 */
const NOT_SECRETS: Readonly<Record<string, string>> = {
  'destination.accessKey':
    'the S3 access key *id* — the public half of the pair, and the half that ' +
    'appears in request signatures and logs. `secretAccessKey` beside it is ' +
    'encrypted, which is the whole credential.',
  'cloudAccount.accessKeyId':
    'the AWS access key *id*, which AWS shows in its console and logs and the ' +
    'Cloud accounts screen shows on purpose. ' +
    '`secretAccessKey` beside it is encrypted.',
  'cloudAccount.signingKeyId':
    'the id of a Google Cloud account’s signing key, the `kid` every token ' +
    'it signs carries in the clear and the JWKS the operator uploads names ' +
    '(slice 6, S12). `signingKey` beside it is encrypted.',
  'cloudAccount.signingPublicKey':
    'the public half of a Google Cloud account’s signing key, which the ' +
    'operator uploads to their OIDC provider and the Cloud accounts screen ' +
    'shows on purpose (slice 6, S12). `signingKey` and `pendingSigningKey` ' +
    'beside it are encrypted.',
  'cloudAccount.tokenIssuer':
    'the `iss` every token a Google Cloud account signs carries in the clear, ' +
    'which the setup script hands its OIDC provider and the Cloud accounts ' +
    'screen shows on purpose (slice 6, S16). An address, not a secret.',
  'server.sshKeyId':
    'a foreign key to `ssh_key`, not a key. The material it points at is ' +
    '`sshKey.privateKey`, which is encrypted.',
  'sshKey.sshKeyId': 'the table’s own `nanoidPk` primary key.',
  'boughtServer.sshKeyId':
    'a foreign key to `ssh_key`, as `server.sshKeyId` is: the key made for ' +
    'a Bought Server, whose private half is `sshKey.privateKey`, encrypted.',
  'bucket.googleKeySlot':
    'which of a Google bucket’s two key slots in its state holds the live ' +
    'HMAC key: `key` or `key_b`, an address, not a key. The key ' +
    'itself is `accessKeyId` / `secretAccessKey`, and a rotation’s in ' +
    '`rotationKeys`, which are encrypted.',
  'sshKey.publicKey':
    'the public half of a keypair. It is handed to remote hosts on purpose; ' +
    '`privateKey` beside it is encrypted.',
  'server.hostKeyFingerprint':
    'the SHA-256 of the public host key a Server presents to anyone who ' +
    'connects, in the form `ssh-keygen -lf` prints. The API answers it so an ' +
    'operator can compare it by eye (ADR-0074); there is no private half.',
};

/**
 * The columns encrypted **by argument rather than by name** — operator-authored
 * program text that Cloudgate hands a machine it manages, which no credential
 * vocabulary can find and which {@link namesACredential} is asserted below not
 * to match. One entry is a credential outright whose name the vocabulary
 * cannot reach — `uptimeCheck.headerValue` — and says so beside it.
 *
 * *"A file body"* is what that phrase used to say, and a later amendment
 * widened it: four of the first five are file bodies and `schedule.command` is
 * not one — it is a program Cloudgate hands `docker exec` without ever
 * materializing it. ADR 0015 carries the amendment and the reason the file was
 * never the load-bearing half.
 *
 * This is the mirror of {@link NOT_SECRETS}: that list holds a plain column to
 * a written reason, this one holds an encrypted column to one. Both exist
 * because the deploy-webhook bug came from a list of names with no arguments
 * beside them, and an encryption whose whole argument is *"a file body is where
 * an operator puts a credential"* is exactly the kind that gets undone by
 * someone who reads `text` and sees no reason for anything else —
 * `encryptedText` `dataType()`s to `'text'`, so neither the compiler nor
 * `drizzle-kit` will say a word (ADR 0006, and the top of this file).
 *
 * **`compose.composeFile` used to be excluded here with a pointer to ADR 0015,
 * and that has since been closed.** The pointer was right and the exclusion was
 * scheduling: nine reader sites across four modules the `schedule.script`
 * change did not own, every one of which turned out to need no edit, because
 * `encryptedText` converts at the driver boundary and every reader goes through
 * drizzle. It is the strongest of the four on the merits rather than the
 * weakest — `compose.env` is `encryptedText` on the same table and operators
 * write `environment:` values into the file anyway, and one file's blast radius
 * is every service in a stack.
 */
const ENCRYPTED_BY_ARGUMENT: Readonly<Record<string, string>> = {
  'mount.content':
    'the body of a file mount — an env file or a config file with credentials ' +
    'in it, per the column’s own comment.',
  'patch.content':
    'file content headed for the build tree, which is the same argument one ' +
    'module over.',
  'schedule.script':
    'a shell script an operator writes, which Cloudgate materializes as ' +
    '`script.sh` on a Server and runs there on a cron. It is where ' +
    '`curl -H "Authorization: …"` and `PGPASSWORD=…` get written, and nothing ' +
    'in the tree queries the column by value (ADR 0015).',
  'compose.composeFile':
    'a docker-compose file an operator authors, which Cloudgate materializes ' +
    'on a build server and runs `docker compose` over. It routinely carries ' +
    'literal `environment:` values even though the `encryptedText` ' +
    '`compose.env` sits beside it for exactly those, and nothing in the tree ' +
    'queries the column by value (ADR 0015).',
  'schedule.command':
    'the shell program an operator writes for a container schedule, which ' +
    'Cloudgate hands `docker exec` on a cron. It is `script`’s ' +
    'container-side sibling — same authorship, same `PGPASSWORD=…`, and it ' +
    'is *not* a file body, which is the amendment made to ADR 0015. Its ' +
    'journal echo was closed by never-carry before the column was ' +
    'reclassified, because encrypting a column the code prints is worse than ' +
    'leaving it plain.',
  'projectConfigLocation.text':
    'a Cloudgate-kept Project config, which an operator authors and pastes ' +
    'whole on the Project config page. Its fields are names, never ' +
    'values, but a YAML comment carries anything at all, a credential ' +
    'included, and nothing queries the column by value; staleness is a hash ' +
    'stored on the plan (ADR 0015).',
  'uptimeCheck.headerValue':
    'the value of the one header an HTTP Uptime check sends — a bearer token ' +
    'or an API key for a protected health endpoint, as often as not. It is ' +
    'not program text, and it is here rather than above because neither ' +
    '`header` nor `value` is a word the vocabulary can hold without matching ' +
    'every `headerName` and `defaultValue` in the schema. Write-only: no read ' +
    'answers it, only `hasHeaderValue`.',
};

/**
 * One column's type by `table.property`: `true` encrypted, `false` plain, and
 * `undefined` when the schema has no such column — which is how a rename or a
 * deletion fails {@link ENCRYPTED_BY_ARGUMENT}'s assertion instead of emptying
 * it into a pass.
 *
 * Separate from {@link claimed}, and not a filter over it, because these three
 * columns are here precisely *because* the vocabulary cannot see them — asking
 * `claimed()` for one would always answer nothing.
 */
function encryptedAt(at: string): boolean | undefined {
  const [table, key] = at.split('.');
  const found = tables().find(([name]) => name === table);
  if (!found) return undefined;
  const column = getTableColumns(found[1])[key];
  if (!column || !IN_SCOPE.test(column.getSQLType())) return undefined;
  return column.columnType === 'PgCustomColumn';
}

function tables(): [string, PgTable][] {
  const found: [string, PgTable][] = [];
  for (const [name, value] of Object.entries(schema)) {
    if (!is(value, Table)) continue;
    found.push([name, value]);
  }
  return found.sort(([left], [right]) => left.localeCompare(right));
}

interface Named {
  readonly at: string;
  readonly encrypted: boolean;
  readonly betterAuth: boolean;
}

/**
 * Whether a column's property name claims to hold a credential: any whole word
 * of it is in {@link VOCABULARY}, where the words of a camelCase name are its
 * humps. Separate from {@link claimed} so it can be held to literal names
 * below — a schema walk that finds nothing and a matcher that matches nothing
 * fail the same assertions, and only one of the two is a bug in this file.
 */
function namesACredential(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .some((word) => VOCABULARY.test(word));
}

/** Every in-scope column whose name makes a claim about its contents. */
function claimed(): Named[] {
  const found: Named[] = [];
  for (const [table, value] of tables()) {
    for (const [key, column] of Object.entries(getTableColumns(value))) {
      if (!IN_SCOPE.test(column.getSQLType())) continue;
      if (!namesACredential(key)) continue;
      found.push({
        at: `${table}.${key}`,
        // `encryptedText` and `encryptedJson` are drizzle `customType`s, so
        // the table reports them as `PgCustomColumn` and nothing else in the
        // schema is one. Detected rather than listed, so a later encrypted
        // column satisfies this on its own.
        encrypted: column.columnType === 'PgCustomColumn',
        betterAuth: BETTER_AUTH_TABLES.includes(table),
      });
    }
  }
  return found;
}

describe('encryptedText, on the columns whose names oblige it', () => {
  it('leaves no secret-named column stored in cleartext without a reason', () => {
    const unexplained = claimed()
      .filter(
        (column) =>
          !column.encrypted &&
          !column.betterAuth &&
          NOT_SECRETS[column.at] === undefined,
      )
      .map((column) => column.at);

    expect(unexplained).toEqual([]);
  });

  it('reads a name by its whole words rather than its substrings', () => {
    // The assertion above is satisfied perfectly by a matcher that matches
    // nothing, and a regex is one edit away from being one. Held to literal
    // names and not to a count of what it finds in the schema today: a count
    // has to be raised every time a column is added, which makes it a
    // maintenance tax that says nothing, while these are the two directions
    // the matcher can actually break in — going quiet, or going greedy and
    // being widened back into silence by exceptions.
    const credentials = [
      'refreshToken',
      'secretAccessKey',
      'password',
      'apiKey',
    ];
    const notCredentials = ['monkey', 'tokenized', 'composeFile', 'appName'];

    expect({
      missed: credentials.filter((name) => !namesACredential(name)),
      overreached: notCredentials.filter(namesACredential),
    }).toEqual({ missed: [], overreached: [] });
  });

  it('finds the two deploy-webhook secrets this gate was written for', () => {
    // Named, because these two are what the change was: the Application's copy
    // is what the ticket described, the Compose one is the copy it did not
    // know existed, and a revert of either is a security regression rather
    // than a style one. Reading them back off the schema walk is also what
    // says the walk reached a real table — `claimed()` returning nothing fails
    // here rather than passing everything above.
    const byName = new Map(claimed().map((column) => [column.at, column]));

    expect(byName.get('application.refreshToken')?.encrypted).toBe(true);
    expect(byName.get('compose.refreshToken')?.encrypted).toBe(true);
  });

  it('finds the Trace store credentials encrypted', () => {
    // Named for the reason the two above are: a traced Service's `basicauth`
    // credential is what keeps another Service from writing into its store,
    // and the query credential is what keeps every container on
    // `cloudgate-network` from reading it (ADR-0028). Both are held by the
    // vocabulary already; this says the walk reached them.
    const byName = new Map(claimed().map((column) => [column.at, column]));

    expect(byName.get('traceStore.credential')?.encrypted).toBe(true);
    expect(byName.get('traceStore.queryCredential')?.encrypted).toBe(true);
  });

  it('finds an AI model’s upstream secret encrypted', () => {
    // Named for the same reason: the per-AI-model secret is what the run
    // Server's Traefik checks before it lets the gateway through to the
    // runtime, so a plaintext copy is a way round the gateway.
    const byName = new Map(claimed().map((column) => [column.at, column]));

    expect(byName.get('aiModelFacet.upstreamSecret')?.encrypted).toBe(true);
  });

  it('finds an AI model’s Hugging Face token encrypted', () => {
    // The operator's own credential at Hugging Face, which can fetch every
    // gated repo their account can: write-only, and only ever `hasHfToken`.
    const byName = new Map(claimed().map((column) => [column.at, column]));

    expect(byName.get('aiModelFacet.hfToken')?.encrypted).toBe(true);
  });

  it('keeps encrypted the operator program text no vocabulary could have named', () => {
    // `schedule.script` is why this assertion exists: the argument that
    // made `mount.content` and `patch.content` `encryptedText` — a file body
    // is where an operator puts a credential — applies to a cron script
    // without modification, and for the whole life of the column the schema
    // disagreed with its two siblings. Nothing above can hold any of them,
    // because `script`, `file`, `content` and `command` are not words a
    // credential vocabulary may contain: adding them would match `dockerfile`,
    // `composePath` and `description` and be widened straight back into
    // silence.
    //
    // It began as three. Then came `compose.composeFile`, which the original
    // sweep had left on a reason that did not survive being read; then
    // `schedule.command`, which is the one entry
    // that is **not** a file body — operator program text handed to
    // `docker exec` and never materialized — and is the amendment ADR 0015
    // carries. Encrypting it needed its journal echo closed first, so the
    // ordering is part of the argument and not a detail of it. Then
    // `uptimeCheck.headerValue`, which is not program text at all but a
    // credential under a name no vocabulary can safely hold.
    //
    // `undefined` rather than `false` for a column that is gone, so a rename
    // fails here rather than quietly emptying the list — the same rot
    // `NOT_SECRETS`' `stale` check watches for, in the other direction.
    const names = Object.keys(ENCRYPTED_BY_ARGUMENT);

    expect(
      Object.fromEntries(names.map((at) => [at, encryptedAt(at)])),
    ).toEqual(Object.fromEntries(names.map((at) => [at, true])));

    // And the premise of the list: none of them is reachable by name, so if the
    // vocabulary ever grows to cover one, it belongs above and not here.
    expect(names.filter((at) => namesACredential(at.split('.')[1]))).toEqual(
      [],
    );
  });

  it('holds every exception to a column that still needs one', () => {
    // Two ways a list like this rots. An exception outliving its column is
    // permission for whatever takes the name next; an exception outliving its
    // *reason* — the column was encrypted afterwards, so the sentence beside
    // it is now false — is a standing invitation to undo that. Both are about
    // every entry rather than about a count of them.
    const columns = claimed();
    const named = new Set(columns.map((column) => column.at));
    const stale = Object.keys(NOT_SECRETS).filter((at) => !named.has(at));
    const settled = columns
      .filter((column) => column.encrypted && NOT_SECRETS[column.at])
      .map((column) => column.at);
    const missingTables = BETTER_AUTH_TABLES.filter(
      (table) => !tables().some(([name]) => name === table),
    );

    expect({ stale, settled, missingTables }).toEqual({
      stale: [],
      settled: [],
      missingTables: [],
    });
  });
});

/**
 * The `metricsConfig` change's question, answered: **should this file reach
 * into declared JSON shapes, or is that beyond what a name-based property
 * should attempt?**
 *
 * It should reach in, and it can — but not through the type, which is where
 * the question points and where the answer is no. `jsonb('metrics_config')
 * .$type<MetricsConfig>()` is a compile-time phantom: at runtime
 * `getTableColumns` reports `PgJsonb` and the type argument is gone, so
 * walking `MetricsConfig`'s members from a spec means running the TypeScript
 * compiler over `src/db/schema.ts`, resolving a type argument, and following
 * interface members across files. That is a second mechanism — a whole
 * `ts.Program` in a jest spec — to read a shape the schema *also* states in a
 * form that survives to runtime.
 *
 * That form is **the declared default**, and it is the signal this property
 * uses. `.default(defaultMetricsConfig)` keeps the literal object on the
 * column, so `column.default` is `{ server: { token: '', … }, containers: … }`
 * — the field names, at every depth, with no compiler involved. Walk it with
 * the same {@link VOCABULARY} the column names are held to and
 * `MetricsConfig.server.token` falls out on its own. Reading a default rather
 * than a type is also the narrower claim: a default is what a fresh row
 * *actually holds*, so a field in it is a field the table stores, whereas a
 * declared type can describe a shape nothing ever writes.
 *
 * **The blind spot, stated when this was written and it was worse than
 * stated.** The `metricsConfig` change recorded that a `jsonb` column with no
 * default is invisible here, named the three it knew of — `backup.metadata`,
 * `organizationRole.permission` and `containerMetric.metrics` — and added
 * *"none holds a credential today"*. That sentence was false about the first
 * one when it was typed. `backup.metadata` held `mariadb.databasePassword`,
 * `mongo.databasePassword` and `mysql.databaseRootPassword` in cleartext
 * `jsonb`, and it is the reason the census below exists: the blind spot was
 * documented and then reasoned across, which is the same move
 * `compose.composeFile`'s bullet above was written to stop. A property's gap is
 * not a licence to assert into it — and the count was wrong too: this schema
 * has **79** JSON-shaped columns, not seven, because 70 of them are `json`
 * rather than `jsonb`.
 *
 * The honest fix proposed then for such a column was "a default or a `text`
 * column". Half of that is unavailable and worth writing down: a default for
 * `backup.metadata` could only carry a credential to be walkable at all, and
 * ADR 0006 forbids a secret in DDL outright. So the column took the other
 * half, and what holds it now is {@link jsonColumns} below rather than either
 * property here. The vocabulary was already "a floor, not the whole duty of
 * care" (top of this file); so is this.
 */
function credentialFieldsIn(
  value: unknown,
  path: readonly string[] = [],
): string[] {
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    // An array's keys are its indices, which no vocabulary word can be, so
    // arrays need no special case — `services.include` is walked and its
    // elements contribute nothing.
    if (namesACredential(key)) found.push([...path, key].join('.'));
    found.push(...credentialFieldsIn(child, [...path, key]));
  }
  return found;
}

interface JsonShaped {
  readonly at: string;
  readonly encrypted: boolean;
  /** The credential-named fields, as dotted paths inside the blob. */
  readonly fields: readonly string[];
}

/**
 * Every column whose declared default is a JSON *structure* holding at least
 * one credential-named field.
 *
 * Keyed on the default being an object rather than on the column being
 * `PgJsonb`, which is what lets one assertion cover both sides of the
 * `metricsConfig` conversion: `metricsConfig` was `PgJsonb` before it and is
 * `PgCustomColumn` (`encryptedJson`, `text` at rest) after, and the default
 * object is the same either way. A scalar default is skipped —
 * `sshKey.privateKey` and `project.env` default to `''`, which is not a shape
 * and is already covered by the property above.
 */
function jsonDefaults(): JsonShaped[] {
  const found: JsonShaped[] = [];
  for (const [table, value] of tables()) {
    for (const [key, column] of Object.entries(getTableColumns(value))) {
      const declared: unknown = column.default;
      if (declared === null || typeof declared !== 'object') continue;
      const fields = credentialFieldsIn(declared);
      if (fields.length === 0) continue;
      found.push({
        at: `${table}.${key}`,
        encrypted: column.columnType === 'PgCustomColumn',
        fields,
      });
    }
  }
  return found;
}

describe('encryptedJson, on the JSON columns whose declared shape obliges it', () => {
  it('leaves no JSON column holding a credential-named field in cleartext', () => {
    const unexplained = jsonDefaults()
      .filter((column) => !column.encrypted)
      .map((column) => `${column.at} (${column.fields.join(', ')})`);

    expect(unexplained).toEqual([]);
  });

  it('finds the metrics token on both tables that carry it', () => {
    // Named for the reason the two `refreshToken` columns are named above: a
    // property satisfied by a walk that finds nothing is not a property, and
    // this walk has two ways to go quiet — `column.default` ceasing to hold
    // the literal object (a drizzle upgrade), and someone dropping
    // `.default()` from the column. Both leave the assertion above passing.
    //
    // `web_server_settings` is here as well as `server` because the two must
    // convert together: the token on the settings singleton authenticates the
    // *instance-wide* branch of `NotificationsService.receiveServerThreshold`,
    // which fans an alert out to every organization, so encrypting one table
    // and not the other leaves the wider of the two blast radii in cleartext.
    const byName = new Map(jsonDefaults().map((column) => [column.at, column]));

    expect(byName.get('server.metricsConfig')).toEqual({
      at: 'server.metricsConfig',
      encrypted: true,
      fields: ['server.token'],
    });
    expect(byName.get('webServerSettings.metricsConfig')).toEqual({
      at: 'webServerSettings.metricsConfig',
      encrypted: true,
      fields: ['server.token'],
    });

    // The negative that makes the walk a filter rather than a rubber stamp.
    // `whitelabelingConfig` is a `jsonb` blob on the same row, deliberately
    // not encrypted — it is branding and `GET /settings/whitelabeling` is
    // `@Public()` — and its seven fields name no credential, so it must not
    // appear here at all.
    expect(byName.has('webServerSettings.whitelabelingConfig')).toBe(false);
  });

  it('reads a declared default to its leaves, not only its top level', () => {
    // `server.token` is two levels down and inside no array; `include` is an
    // array of strings. Both shapes are in `MetricsConfig`, so a walk that
    // stopped at depth one or threw on an array would have found nothing and
    // passed everything above.
    expect(
      credentialFieldsIn({
        server: { token: '', port: 4500 },
        containers: { services: { include: ['web'] } },
      }),
    ).toEqual(['server.token']);
    expect(credentialFieldsIn({ a: [{ b: { secret: 'x' } }] })).toEqual([
      'a.0.b.secret',
    ]);
    expect(
      credentialFieldsIn({ monkey: 1, dockerfile: 'x', appName: null }),
    ).toEqual([]);
    expect(credentialFieldsIn('a string')).toEqual([]);
    expect(credentialFieldsIn(null)).toEqual([]);
  });
});

/**
 * The census's question, which is the `metricsConfig` one turned around: **a
 * JSON column that declares no default states nothing about its contents at
 * runtime — so what holds it?**
 *
 * The gap is not hypothetical and it is not narrow. `backup.metadata` sat in
 * cleartext `jsonb` carrying three database passwords, and *four* separate
 * properties looked straight past it:
 *
 * - {@link claimed} reads column *names* and only `text` ones. `metadata` is
 *   no credential vocabulary's word, and a `jsonb` column is out of
 *   {@link IN_SCOPE} by construction.
 * - {@link jsonDefaults} reads a column's declared default. This column has
 *   none, so `column.default` is `undefined` and the walk skips it before it
 *   ever reaches a field name.
 * - `$type<ComposeBackupMetadata | null>()` is erased at runtime, so the type
 *   argument that *does* name the three passwords is unreadable from a spec
 *   without a `ts.Program` (that trade was argued above and has not changed).
 * - And the tree already agreed the column was a secret everywhere except the
 *   column: `BackupListItem` is `Omit<Backup, 'metadata'>`, `listByService`
 *   passes `columns: { metadata: false }`, and the comment over both says the
 *   column "holds the stack engine's user and password". The deploy-webhook
 *   failure mode exactly — every reader classifying a value one way and the
 *   schema the other — one level down, in a blob.
 *
 * **So this property changes the signal from a shape to a census.** Not "does
 * a credential-named field appear in something I can read", which is what the
 * two properties above ask and what this column defeats, but "**is every
 * column that stores a JSON structure accounted for**". A column cannot escape
 * an enumeration by declaring nothing, and the failure mode this closes is the
 * one that actually happened: a JSON column added or left in cleartext with
 * nobody having had to write a sentence about what goes in it.
 *
 * **Reached by asking the column rather than reading a type.** A `json`/`jsonb`
 * column reports `PgJsonb`/`PgJson`; an `encryptedJson` one is a
 * `customType` indistinguishable from `encryptedText` in its `dataType()`, its
 * snapshot entry and its `columnType` — so it is detected by *probing*
 * `mapFromDriverValue` with plain JSON text, which `encryptedJson` parses to
 * an object and `encryptedText` hands back as a string. That needs no
 * `APP_ENCRYPTION_SECRET`, because ADR 0006's pass-through returns an
 * unprefixed value unchanged. It is also what makes the census survive a
 * conversion: `backup.metadata` is in it as `jsonb` and still in it as
 * `encryptedJson`, so the entry's `encrypted` flag is the assertion rather
 * than the column's mere presence.
 *
 * **The Swarm fragments are exempt as a set, which is what keeps this a
 * property and not a 79-line table.** 70 of the 79 are the `*Swarm`
 * service-spec columns — `healthCheckSwarm`, `placementSwarm`,
 * `endpointSpecSwarm` and seven more, repeated on every deployable table.
 * They are one kind of thing with one argument: each is a fragment of a Docker
 * `ServiceSpec` that Cloudgate passes to the Swarm API, none of them is where
 * a credential goes (a Swarm secret is *referenced by name* from
 * `ContainerSpec.Secrets`, which is not one of these columns), and they are
 * `docker service inspect`-visible by design. Exempting them by suffix, with
 * that sentence, is `BETTER_AUTH_TABLES`' shape: a set with an argument, so a
 * *Cloudgate* JSON column is never waved through by accident. The nine that
 * are left are named individually.
 *
 * **And the answer to "can a defaultless column be read automatically after
 * all": yes, through the zod schema at its boundary.** That is the second
 * runtime-surviving statement of a blob's shape after the declared default,
 * and unlike the TypeScript type it is an ordinary value — `createBackupSchema
 * .shape.metadata` walks to `mariadb.databasePassword`,
 * `mongo.databasePassword` and `mysql.databaseRootPassword` with the same
 * {@link VOCABULARY}. So an entry may carry the schema its column is written
 * through, and then the census's `encrypted` expectation is *derived* from the
 * vocabulary instead of asserted by whoever typed the entry: take the
 * passwords out of the DTO and the requirement lifts; add a `token` to a plain
 * column's DTO and it fails. `backup.metadata` carries one. The rest do not,
 * and that is deliberate rather than unfinished — a schema pinned against a
 * column that no credential vocabulary flags proves only that it still flags
 * nothing, at the cost of importing nine DTO modules into this file.
 */

/** JSON-shaped columns whose fields are Docker `ServiceSpec` fragments. */
const SWARM_FRAGMENT = /Swarm$/;

/** What a census entry says about one JSON-shaped column. */
interface JsonColumnEntry {
  /** `true` when the column must be `encryptedJson`, `false` when plain. */
  readonly encrypted: boolean;
  /** The sentence that makes it one or the other. */
  readonly reason: string;
  /**
   * Optional: the zod schema this column is written through, so `encrypted`
   * above is checked against {@link VOCABULARY} rather than trusted.
   */
  readonly writtenBy?: z.ZodType;
}

const JSON_COLUMNS: Readonly<Record<string, JsonColumnEntry>> = {
  'bucket.adminCredential': {
    encrypted: true,
    reason:
      'Cloudgate’s own credential for a bucket’s Garage container — its RPC ' +
      'secret and admin token — which no Service sees and which is written ' +
      'into that container’s config (ADR-0037).',
  },
  'bucket.keyRotation': {
    encrypted: false,
    reason:
      'where a bucket’s Rotate key is and how it ended: which ' +
      'Services it redeploys, their Deployments and the sentence naming one ' +
      'that failed — never a key, which waits in `rotationKeys`.',
  },
  'bucket.rotationKeys': {
    encrypted: true,
    reason:
      'a Rotate key’s new Garage key, ID and secret, while the Services ' +
      'linking the bucket are redeployed with it, and the IDs of keys still ' +
      'to remove (ADR-0037).',
  },
  'backup.metadata': {
    encrypted: true,
    reason:
      'a compose backup carries the stack engine’s credentials in the row, ' +
      'because the engine runs inside the user’s stack and there is no ' +
      'database row to read them from — three of the four members are a ' +
      'password, and every engine table’s own copy of the identical value is ' +
      '`encryptedText` already.',
    writtenBy: createBackupSchema.shape.metadata,
  },
  'custom.headers': {
    encrypted: true,
    reason:
      'the header map a custom webhook authenticates with, which is why it is ' +
      '`encryptedJson` rather than `jsonb`. No ' +
      'vocabulary reaches it either: `headers` is not a credential word, and ' +
      'the values are the secret while the keys are `Authorization`.',
  },
  'dnsChallenge.credentials': {
    encrypted: true,
    reason:
      'the `KEY=value` credentials a machine’s DNS-01 resolver authenticates ' +
      'to a DNS provider with — an API token that can rewrite the zone. ' +
      'No vocabulary reaches the values: the keys are the operator’s ' +
      '(`CF_DNS_API_TOKEN`, `AWS_SECRET_ACCESS_KEY`), and a response answers ' +
      'the key names and never a value (ADR-0019).',
  },
  'server.metricsConfig': {
    encrypted: true,
    reason:
      '`server.token` authenticates the unauthenticated metrics receive ' +
      'endpoint. Held field-by-field by `jsonDefaults` above as well, ' +
      'because this column declares a default.',
  },
  'webServerSettings.metricsConfig': {
    encrypted: true,
    reason:
      'the same token on the settings singleton, which authenticates the ' +
      'instance-wide alert branch.',
  },
  'webServerSettings.whitelabelingConfig': {
    encrypted: false,
    reason:
      'branding — an app name, two image URLs, colours, CSS and error-page ' +
      'copy. `GET /settings/whitelabeling` is `@Public()`, so this blob is ' +
      'served to anonymous callers on purpose.',
  },
  'deployment.cronRun': {
    encrypted: false,
    reason:
      'what marks a Run record of a Cron service: its Swarm job ' +
      'name, the image it started from and who started it (a user id and ' +
      'display name, or the timetable). Names and ids, read by both ' +
      'deployment feeds; the registry login a run pulls with is the ' +
      'Registry row’s, never copied here.',
  },
  'deployment.queuedAs': {
    encrypted: false,
    reason:
      'the job a Build deployment was queued as: its arm and ' +
      'whether it is a deploy or a redeploy — two enums, which start-up ' +
      'reads to queue a `pending` build again as exactly that job.',
  },
  'deployment.cloudRun': {
    encrypted: false,
    reason:
      'a Cloud run’s shape: its kind, the state key it locks, its ' +
      'Environment id and whether it touches the network — ids and an enum, ' +
      'which start-up reads to queue a `pending` cloud row again. No ' +
      'credential reaches it; the run’s AWS credential is the Cloud ' +
      'account’s, read when the run starts.',
  },
  'bucket.cloudDelete': {
    encrypted: false,
    reason:
      'a bucket on AWS’s Delete under way or incomplete (ADR-0038): ' +
      'its status, the Deployment of its run, whether it asked for the ' +
      'files to go, who asked (a user and Organization id), and what is ' +
      'left in AWS — each by type, AWS id, region and Cloudgate’s tag. No ' +
      'credential reaches it.',
  },
  'boughtServer.changeTarget': {
    encrypted: false,
    reason:
      'a Bought Server change in progress (ADR-0071): its target size code, ' +
      'backups on or off, and extra storage in GB. Facts the customer chose ' +
      'and the console shows, with nothing secret among them.',
  },
  'boughtServerOrphan.labels': {
    encrypted: false,
    reason:
      'the provider labels on a machine no Bought Server owns (ADR-0071): ' +
      'Organization and Server ids Cloudgate wrote itself, shown to ' +
      'Operators, with nothing secret among them.',
  },
  'application.cloudDelete': {
    encrypted: false,
    reason:
      'a cloud Service’s Delete under way or incomplete (ADR-0038): ' +
      'its status, the Deployment of its run, who asked (a user and ' +
      'Organization id), and what is left in AWS — each by type, AWS id, ' +
      'region and Cloudgate’s tag. Ids the console lists to the operator; ' +
      'no credential reaches it.',
  },
  'organizationRole.permission': {
    encrypted: false,
    reason:
      'an RBAC permission map: resource names to allowed verbs. It grants ' +
      'access rather than proving it, and `PermissionService` reads it on ' +
      'every request.',
  },
  'containerMetric.metrics': {
    encrypted: false,
    reason:
      'one sampled metrics reading — CPU, memory, block IO. Written per ' +
      'sample by the monitoring ingest and pruned by retention; nothing in it ' +
      'authenticates anything.',
  },
  'compose.deployedPublishedPorts': {
    encrypted: false,
    reason:
      'the fixed TCP ports a successful repository deploy published, as ' +
      '`{ published, target, service }`: numbers and compose service ' +
      'names, which `domain.serviceName` and the published-ports picker ' +
      'already carry in the clear. No value from the file is kept.',
  },
  'compose.stackVm': {
    encrypted: false,
    reason:
      "a Stack VM's machine type, data disk size, snapshot days, its " +
      '`native.aws` block, and the image, Docker pins and AWS ids its ' +
      'Apply recorded (ADR-0070): what the plan lines and the cloud ' +
      'console show anyone who may read the stack. No secret is kept.',
  },
  'compose.cloudDelete': {
    encrypted: false,
    reason:
      'a Stack VM stack’s Delete under way or incomplete (ADR-0038, ' +
      '#1367): its status, the Deployment of its run, who asked (a user ' +
      'and Organization id), the final snapshot’s name, id and size, and ' +
      'what is left in the cloud — each by type, id, region and ' +
      'Cloudgate’s tag. No credential reaches it.',
  },
  'compose.deployedVolumes': {
    encrypted: false,
    reason:
      'the names of the volumes a successful deploy’s compose file ' +
      'declares, which its Delete removes and a plan’s destroy line names ' +
      '(ADR-0069): Docker volume names, shown by `docker volume ls` to ' +
      'anyone on the Server. No other value from the file is kept.',
  },
  'environment.deployTarget': {
    encrypted: false,
    reason:
      'where a Service a plan creates in the Environment will run, as ' +
      '`{ kind: "server", serverId }` or `{ kind: "platform-host" }`: ' +
      'a kind and a Server id, which `serverId` columns on every Service ' +
      'already carry in the clear. Nothing in it authenticates anything. ' +
      'A cloud one is `{ kind: "cloud", cloudAccountId, region }`: ' +
      'an id and a region name, no credential.',
  },
  'plan.deployTarget': {
    encrypted: false,
    reason:
      'the Environment’s Deploy target when a plan was made, the ' +
      'same value `environment.deployTarget` holds in the clear: a kind ' +
      'and a Server or Cloud account id, and a region.',
  },
  'pendingSetup.parts': {
    encrypted: false,
    reason:
      'what a Template setup waiting on an Environment will create: Config ' +
      'names, kinds and how each value is made (`generated (base64, 32 ' +
      'bytes)`, `asked`), never a value. A plan reads it to say so, and a ' +
      'plan is readable by an Agent; the values are in `body`.',
  },
  'pendingSetup.body': {
    encrypted: true,
    reason:
      'every value a Template setup made — generated secrets and asked ' +
      'values — with the Domain hosts it picked and the files it filled ' +
      'in, until the Apply that creates each Service (ADR-0064, ADR-0065).',
  },
  'setupRecord.configNames': {
    encrypted: false,
    reason:
      'the Config names a Template setup made: the same names the ' +
      'Project config lists in the clear.',
  },
  'expiredSetup.configNames': {
    encrypted: false,
    reason:
      'the Config names a Pending setup the 30-day sweep dropped still ' +
      'held: names a Project config lists in the clear, never a value.',
  },
  'plan.steps': {
    encrypted: false,
    reason:
      'what a plan would create, change and destroy: Config names, ' +
      'kinds, Service ids and each config-owned field’s before and after — ' +
      'a port, an image, a command, variable *names* — every one of which ' +
      'is already a cleartext column on its Service, or a key of a blob ' +
      'whose values never leave it. A cloud step adds the plan ' +
      'reader’s AWS lines: resource addresses, field names, and drift ' +
      'values with every sensitive one masked by the reader.',
  },
  'environmentNetwork.publicSubnetIds': {
    encrypted: false,
    reason:
      'the two public subnet ids of an Environment network, ' +
      'AWS resource ids an operator reads in the AWS console. Not secrets.',
  },
  'environmentNetwork.privateSubnetIds': {
    encrypted: false,
    reason:
      'the two private subnet ids of an Environment network, AWS ' +
      'resource ids an operator reads in the AWS console. Not secrets.',
  },
  'domain.validationRecord': {
    encrypted: false,
    reason:
      'the DNS record ACM asks for to validate a cloud Domain’s certificate ' +
      ': a CNAME name and value AWS hands out, which the console ' +
      'shows the operator to add at their DNS host. Public by design; no ' +
      'credential reaches it.',
  },
  'environment.cloudDelete': {
    encrypted: false,
    reason:
      'an Environment’s Delete in a Cloud account under way or incomplete ' +
      '(ADR-0038): a status, who asked, each AWS resource left by its ' +
      'type, id, region and Cloudgate tag, and the DNS records its Domains ' +
      'left, all of which the console shows the operator. No credential.',
  },
  'environmentNetwork.dnsRecordsLeft': {
    encrypted: false,
    reason:
      'the DNS records the Domains of an Environment network’s Services ' +
      'left at the operator’s DNS provider: host names and the ' +
      'validation and load balancer names they point at, which the Domains ' +
      'tab already showed in the clear.',
  },
  'environmentNetwork.leftovers': {
    encrypted: false,
    reason:
      'what a removal of an Environment network left: AWS ' +
      'resource types and ids, named so the operator can remove them. Not secrets.',
  },
  'postgres.rdsApplied': {
    encrypted: false,
    reason:
      'the RDS settings a postgres’s last Apply wrote: an instance ' +
      'class, storage sizes, Multi-AZ and backup retention in days, the ' +
      'same values its own plain columns hold. Not secrets.',
  },
  'postgres.cloudSqlApplied': {
    encrypted: false,
    reason:
      'the backup retention a postgres on Cloud SQL’s last Apply wrote ' +
      ': a number of days, the value its plain column holds. Not ' +
      'secrets.',
  },
  'redis.elasticacheApplied': {
    encrypted: false,
    reason:
      'the ElastiCache settings a redis’s last Apply wrote: a node ' +
      'type, a replica on or off and snapshot retention in days, the same ' +
      'values its own plain columns hold. Not secrets.',
  },
  'redis.memorystoreApplied': {
    encrypted: false,
    reason:
      'the high availability a redis on Memorystore’s last Apply wrote ' +
      ': on or off, the same value its own plain column holds. Not a ' +
      'secret.',
  },
  'existingDatabase.address': {
    encrypted: false,
    reason:
      'where an Existing database answers: a hostname and a port its ' +
      'last lookup read from AWS. Its login stays in the postgres row’s ' +
      'encrypted password column. Not secrets.',
  },
  'existingDatabase.serviceAttachments': {
    encrypted: false,
    reason:
      'where an existing Valkey’s two endpoints point: the service ' +
      'attachments its last lookup read from Memorystore, resource names ' +
      'Google lists to anyone who may read the instance. Not secrets.',
  },
  'existingDatabase.endpoints': {
    encrypted: false,
    reason:
      'the endpoints Cloudgate made for an existing Valkey: each ' +
      'one’s name, private address and connection id, which the page’s ' +
      '`--add-endpoints` command names. Not secrets.',
  },
  'redis.memorystoreEndpoint': {
    encrypted: true,
    reason:
      'where a Memorystore instance answers: its primary endpoint and ' +
      'port, and its own CA, which is its `ca` Output; every Output is a ' +
      'secret, so it is kept encrypted.',
  },
  'postgres.cloudSqlEndpoint': {
    encrypted: true,
    reason:
      'where a Cloud SQL instance answers: its PSC DNS name and port, ' +
      'and its own CA, which is its `ca` Output; every Output is a secret, ' +
      'so it is kept encrypted.',
  },
  'environmentNetwork.privateLinks': {
    encrypted: false,
    reason:
      'the kinds of private link a Google Environment network holds, ' +
      'such as `cloud-sql`: names of what Cloudgate made. Not secrets.',
  },
  'postgres.rdsEndpoint': {
    encrypted: false,
    reason:
      'where an RDS instance answers inside its Environment network: ' +
      'a hostname and a port, read from tofu’s outputs. No Output value is ' +
      'kept beside it; the password stays in its own encrypted column. Not secrets.',
  },
  'redis.elasticacheEndpoint': {
    encrypted: false,
    reason:
      'where an ElastiCache replication group answers inside its Environment ' +
      'network: a hostname and a port, read from tofu’s outputs. The ' +
      'AUTH token stays in its own encrypted column. Not secrets.',
  },
  'mysql.rdsApplied': {
    encrypted: false,
    reason:
      'the RDS settings a mysql’s last Apply wrote, as a ' +
      'postgres’s: an instance class, storage sizes, Multi-AZ and backup ' +
      'retention in days. Not secrets.',
  },
  'mysql.rdsEndpoint': {
    encrypted: false,
    reason:
      'where a mysql’s RDS instance answers inside its Environment network ' +
      ', as a postgres’s: a hostname and a port. Its passwords stay ' +
      'in their own encrypted columns. Not secrets.',
  },
  'mysql.cloudSqlEndpoint': {
    encrypted: true,
    reason:
      'where a mysql’s Cloud SQL instance answers, as a postgres’s: ' +
      'its PSC DNS name and port, and its own CA, which is its `ca` Output; ' +
      'every Output is a secret, so it is kept encrypted.',
  },
  'mysql.cloudSqlApplied': {
    encrypted: false,
    reason:
      'the backup retention and point-in-time recovery a mysql on Cloud ' +
      'SQL’s last Apply wrote, as a postgres’s: a number of days ' +
      'and a switch. Not secrets.',
  },
  'mysql.nativeGcp': {
    encrypted: false,
    reason:
      'the `native.gcp` a mysql’s config entry last applied, as a ' +
      'postgres’s: provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. Its ' +
      'root password and user are Cloudgate’s and locked, never here.',
  },
  'mysql.cloudDelete': {
    encrypted: false,
    reason:
      'a mysql on RDS’s Delete under way or incomplete, as a ' +
      'postgres’s: ids and the final snapshot’s name. No credential.',
  },
  'postgres.cloudDelete': {
    encrypted: false,
    reason:
      'a postgres on RDS’s Delete under way or incomplete (ADR-0038): ' +
      'as a cloud Service’s, plus the name of the final snapshot it keeps. ' +
      'Ids the console lists to the operator; no credential reaches it.',
  },
  'redis.cloudDelete': {
    encrypted: false,
    reason:
      'a redis on ElastiCache’s Delete under way or incomplete (' +
      'ADR-0038): as a postgres on RDS’s. Ids and a snapshot name; no ' +
      'credential reaches it.',
  },
  'plan.notes': {
    encrypted: false,
    reason:
      'a plan’s notes: a variable name with no value, or a ' +
      'console-managed Service’s Config name and kind. Names only.',
  },
  ...Object.fromEntries(
    ['application', 'postgres', 'mysql', 'redis'].map((table) => [
      `${table}.configLinks`,
      {
        encrypted: false,
        reason:
          'the wired variables a Service’s config entry last applied (' +
          'ADR-0031): variable names to a source’s Config name and Output ' +
          'name, as the config itself writes them. Never a value — that is ' +
          'built at each deploy and never stored.',
      },
    ]),
  ),
  'application.nativeAws': {
    encrypted: false,
    reason:
      'the `native.aws` a Service’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. A ' +
      'variable reaches AWS only through its SSM parameter, never here.',
  },
  'bucket.nativeAws': {
    encrypted: false,
    reason:
      'the `native.aws` a bucket’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. Its ' +
      'key is never here.',
  },
  'application.nativeGcp': {
    encrypted: false,
    reason:
      'the `native.gcp` a Service’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. A ' +
      'variable reaches Google only through its Secret Manager secret, ' +
      'never here, and the container’s env is locked.',
  },
  'postgres.nativeAws': {
    encrypted: false,
    reason:
      'the `native.aws` a postgres’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. Its ' +
      'login is Cloudgate’s and locked, never here.',
  },
  'mysql.nativeAws': {
    encrypted: false,
    reason:
      'the `native.aws` a mysql’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. Its ' +
      'login is Cloudgate’s and locked, never here.',
  },
  'redis.nativeAws': {
    encrypted: false,
    reason:
      'the `native.aws` a redis’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. Its ' +
      'login is Cloudgate’s and locked, never here.',
  },
  'postgres.nativeGcp': {
    encrypted: false,
    reason:
      'the `native.gcp` a postgres’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. Its ' +
      'root password and user are Cloudgate’s and locked, never here.',
  },
  'redis.nativeGcp': {
    encrypted: false,
    reason:
      'the `native.gcp` a redis’s config entry last applied (' +
      'ADR-0044): provider arguments exactly as the Project config writes ' +
      'them, which the stored config text already holds in the clear. ' +
      'Memorystore has no password, and its authorization is locked.',
  },
  'plan.outline': {
    encrypted: false,
    reason:
      'which Services the config a plan read listed (US34): ' +
      'Config names, kinds and whether each was `managed: console` — no ' +
      'field and no value, all of which `plan.steps` and the Service ' +
      'tables already carry in the clear.',
  },
  'projectConfigLocation.movedOutOf': {
    encrypted: false,
    reason:
      'where a config moved out of a repository was read: a provider ' +
      'type, an owner/repo, a file path and a time — the same values ' +
      '`repository` and `path` held in the clear before the move.',
  },
  'plan.results': {
    encrypted: false,
    reason:
      'what an Apply did per step: a Config name, a Service id, ' +
      'a generated sslip.io host, a Deployment id and a refusal sentence — ' +
      'each a cleartext column elsewhere (`domain.host`, `deployment`) or ' +
      'a message the API already answered in the clear.',
  },
  'licenseKey.features': {
    encrypted: false,
    reason:
      'the feature flags a validated licence carries, as an array of strings. ' +
      '`licenseKey.key` beside it is the credential and is `encryptedText`.',
  },
  'rollback.fullContext': {
    encrypted: false,
    reason:
      'the deployment context a rollback replays, which is scrubbed on the ' +
      'way in rather than encrypted: `RollbacksService.EXCLUDED_FROM_CONTEXT` ' +
      'drops every credential-bearing field before the row is written, and ' +
      '`0062` scrubbed the rows that predate it. Encrypting the blob ' +
      'would have preserved the values that list exists to not store.',
  },
};

interface JsonColumn {
  readonly at: string;
  readonly encrypted: boolean;
  /** `true` for a `json`/`jsonb` column, `false` for an `encryptedJson` one. */
  readonly plainJson: boolean;
}

/**
 * Whether a column stores a JSON structure: a `json`/`jsonb` column, or a
 * `customType` that parses plain JSON text into an object.
 *
 * The probe is the only way to tell `encryptedJson` from `encryptedText` at
 * runtime — same `columnType`, same `dataType()`, same snapshot entry — and it
 * is safe on either: `decryptValue` returns an unprefixed value unchanged
 * (ADR 0006), so no key is derived and nothing throws. `try` around it anyway,
 * so a future `customType` with a stricter `fromDriver` is reported as "not
 * JSON-shaped" rather than failing this file with its own error.
 */
function parsesJson(column: AnyPgColumn): boolean {
  if (column.columnType !== 'PgCustomColumn') return false;
  try {
    const parsed: unknown = column.mapFromDriverValue('{"probe":1}');
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/** Every column in the schema that stores a JSON structure. */
function jsonColumns(): JsonColumn[] {
  const found: JsonColumn[] = [];
  for (const [table, value] of tables()) {
    for (const [key, column] of Object.entries(getTableColumns(value))) {
      const plainJson =
        column.columnType === 'PgJsonb' || column.columnType === 'PgJson';
      if (!plainJson && !parsesJson(column)) continue;
      if (SWARM_FRAGMENT.test(key)) continue;
      found.push({ at: `${table}.${key}`, encrypted: !plainJson, plainJson });
    }
  }
  return found;
}

/**
 * The credential-named fields a zod schema declares, as dotted paths — the
 * {@link credentialFieldsIn} walk over a shape rather than over a default.
 *
 * Duck-typed on `.shape` and `.unwrap()` rather than on zod's internal
 * `_def.type` tags: those are the two surfaces zod's own callers use, they are
 * stable across the v3→v4 rename this repo has already been through, and the
 * shapes reached here are exactly objects and their optional/nullable
 * wrappers. Anything else — a record, a union, a string — contributes no field
 * names, which is the honest answer for `z.record(z.string())`: the keys are
 * the caller's, so no vocabulary can speak about them.
 */
function credentialFieldsInSchema(
  schema: unknown,
  path: readonly string[] = [],
): string[] {
  const node = schema as {
    unwrap?: () => unknown;
    shape?: Record<string, unknown>;
  };
  if (typeof node?.unwrap === 'function') {
    return credentialFieldsInSchema(node.unwrap(), path);
  }
  if (!node?.shape) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(node.shape)) {
    if (namesACredential(key)) found.push([...path, key].join('.'));
    found.push(...credentialFieldsInSchema(child, [...path, key]));
  }
  return found;
}

describe('encryptedJson, on every column that stores a JSON structure', () => {
  it('accounts for every JSON column, so none can be added unclassified', () => {
    // The census assertion, and the one the two properties above could not make:
    // `backup.metadata` declared no default and carried no credential word in
    // its name, so nothing obliged anyone to write a sentence about what goes
    // in it — and three database passwords went in it. A column is in scope
    // here for *storing JSON*, which it cannot stop doing while staying a
    // JSON column.
    const unclassified = jsonColumns()
      .filter((column) => JSON_COLUMNS[column.at] === undefined)
      .map((column) => column.at);

    expect(unclassified).toEqual([]);
  });

  it('holds each column to the classification written beside it', () => {
    const actual = Object.fromEntries(
      jsonColumns().map((column) => [column.at, column.encrypted]),
    );
    const declared = Object.fromEntries(
      Object.entries(JSON_COLUMNS).map(([at, entry]) => [at, entry.encrypted]),
    );

    // Both directions in one assertion. A column that must be encrypted and is
    // not is `backup.metadata`'s bug; a column recorded as plain that quietly
    // became encrypted makes its sentence false, which is how `NOT_SECRETS`'
    // `settled` check reads one level up. And an entry whose column is gone
    // shows here as a missing key rather than emptying the list into a pass.
    expect(actual).toEqual(declared);
  });

  it('derives the requirement from the boundary schema where one is named', () => {
    // The difference between a property and a pin. `backup.metadata`'s entry
    // does not merely claim the column holds a credential — it names the zod
    // schema every write goes through, and the vocabulary finds the three
    // passwords in it with nobody's word taken for it. Take them out of the
    // DTO and the requirement lifts; add a `token` to a plain column's DTO and
    // its entry fails.
    const derived = Object.entries(JSON_COLUMNS)
      .filter(([, entry]) => entry.writtenBy)
      .map(
        ([at, entry]) =>
          [at, credentialFieldsInSchema(entry.writtenBy)] as const,
      );

    expect(Object.fromEntries(derived)).toEqual({
      'backup.metadata': [
        'mariadb.databasePassword',
        'mongo.databasePassword',
        'mysql.databaseRootPassword',
      ],
    });

    // And the derivation drives the classification rather than sitting beside
    // it: a named schema with a credential field in it obliges `encrypted`.
    const disagreements = derived
      .filter(
        ([at, fields]) => fields.length > 0 && !JSON_COLUMNS[at]?.encrypted,
      )
      .map(([at]) => at);

    expect(disagreements).toEqual([]);
  });

  it('walks a zod shape through its optional and nullable wrappers', () => {
    // `createBackupSchema.shape.metadata` is `composeMetadataSchema.optional()`
    // and each engine's object is optional inside it, so a walk that did not
    // unwrap would report nothing and pass everything above. The negatives are
    // the shapes that legitimately name no field: a record's keys belong to
    // the caller, and a scalar has none.
    expect(
      credentialFieldsInSchema(
        z.object({ a: z.object({ password: z.string() }).nullish() }),
      ),
    ).toEqual(['a.password']);
    expect(credentialFieldsInSchema(z.record(z.string(), z.string()))).toEqual(
      [],
    );
    expect(credentialFieldsInSchema(z.string())).toEqual([]);
    expect(credentialFieldsInSchema(undefined)).toEqual([]);
  });

  it('exempts the Swarm service-spec fragments as a set, and only those', () => {
    // The suffix rule is what keeps the census nine entries instead of
    // seventy-nine, so it has to be held to what it actually excludes: every
    // column it drops is a `*Swarm` fragment on a deployable table, and
    // `backup.metadata` — the column this property exists for — must not be
    // among them. A regex widened to `/config$/` or `/data$/` would fail here
    // rather than silently swallowing the next real blob.
    const excluded: string[] = [];
    for (const [table, value] of tables()) {
      for (const [key, column] of Object.entries(getTableColumns(value))) {
        const isJson =
          column.columnType === 'PgJsonb' ||
          column.columnType === 'PgJson' ||
          parsesJson(column);
        if (isJson && SWARM_FRAGMENT.test(key))
          excluded.push(`${table}.${key}`);
      }
    }

    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.filter((at) => !at.endsWith('Swarm'))).toEqual([]);
    expect(excluded).not.toContain('backup.metadata');
  });
});
