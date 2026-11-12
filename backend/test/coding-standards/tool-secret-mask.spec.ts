import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema';
import { secretReachOf, secretValuesOf } from '../../src/mcp/secret-mask';

/**
 * The mask's schema derivation, held to an independent walk (ADR-0024).
 *
 * `SecretMask` masks every stored secret reachable from a tool's target, and
 * *reachable* is derived from the schema — encrypted-at-rest columns
 * (`PgCustomColumn`) along foreign keys — so a new secret column joins the mask
 * with no edit. What could still go wrong is the derivation: a pruning rule
 * that skips a path, a walk that stops a table short, an extractor that cannot
 * read a column's shape. So:
 *
 * - for each of the eight Service tables, the reach `secretReachOf` reports is
 *   compared with this file's own walk, which prunes nothing;
 * - every encrypted column in the schema is either reached from some Service
 *   or written down below with the reason no Service result can carry it, so
 *   a new encrypted column that no Service reaches reds until someone argues
 *   it onto the list;
 * - every reached column's stored shape is read the way the driver hands it
 *   back and put through `secretValuesOf`, so an `encryptedJson` column the
 *   extractor could not see into would red.
 */

const SERVICE_TABLES = [
  'application',
  'bucket',
  'compose',
  'libsql',
  'mariadb',
  'mongo',
  'mysql',
  'postgres',
  'redis',
];

const NOTIFICATION_CHANNEL =
  "a Notification channel's credential: the Organization's, named by no Service row, and no tool reads a channel";
const IDENTITY =
  "the Organization's identity-provider configuration, named by no Service row";

/**
 * Encrypted columns no Service reaches along foreign keys, and why no tool
 * result is about them. The only right edit when one becomes reachable is a
 * deletion; adding one means saying why an agent's result can never hold it.
 */
const FROZEN_UNREACHED: Readonly<Record<string, string>> = {
  'ai.apiKey':
    "the Organization's AI provider key, named by no Service row; no tool reaches the AI settings",
  'certificate.privateKey':
    "a certificate hangs off a Server, and the walk goes up from a Service to its Server, never down to the Server's other children",
  'custom.endpoint': NOTIFICATION_CHANNEL,
  'custom.headers': NOTIFICATION_CHANNEL,
  'discord.webhookUrl': NOTIFICATION_CHANNEL,
  'databaseSwitch.authToken':
    "a redis's pending switch's AUTH token hangs off the Environment by Config name, never a Service row, and no tool reads a switch; once applied it is the redis row's own authToken, which the walk reaches",
  'databaseSwitch.databasePassword':
    "a pending switch's login hangs off the Environment by Config name, never a Service row, and no tool reads a switch; once applied it is the postgres row's own databasePassword, which the walk reaches",
  'dnsChallenge.credentials':
    "a machine's DNS-01 provider credentials: the platform host's row names no Server at all, and a Server's hangs off it, which the walk up from a Service never goes down to",
  'email.password': NOTIFICATION_CHANNEL,
  'gotify.appToken': NOTIFICATION_CHANNEL,
  'lark.webhookUrl': NOTIFICATION_CHANNEL,
  'mattermost.webhookUrl': NOTIFICATION_CHANNEL,
  'ntfy.accessToken': NOTIFICATION_CHANNEL,
  'pushover.apiToken': NOTIFICATION_CHANNEL,
  'pushover.userKey': NOTIFICATION_CHANNEL,
  'resend.apiKey': NOTIFICATION_CHANNEL,
  'slack.webhookUrl': NOTIFICATION_CHANNEL,
  'teams.webhookUrl': NOTIFICATION_CHANNEL,
  'telegram.botToken': NOTIFICATION_CHANNEL,
  'licenseKey.key': "the instance's license key, named by no Service row",
  'pendingSetup.body':
    'a Template setup waiting on its Environment, which no Service row points at and no MCP tool reads: an Agent never sets a template up (ADR-0065), and a plan names only how each value is made',
  'projectConfigLocation.text':
    "a Project's config text hangs off the Project, and the walk goes up from a Service to its Project, never down to the Project's other children. One tool's result does hold it, on purpose: get_project_config answers the text itself as configText (ADR-0024, as amended), masked by the Project's own secrets, since masking it by itself would mask the whole text",
  'scimProvider.scimToken': IDENTITY,
  'ssoProvider.oidcConfig': IDENTITY,
  'ssoProvider.samlConfig': IDENTITY,
  'webServerSettings.metricsConfig':
    "the instance web server's settings, named by no Service row",
};

const tables = (Object.entries(schema) as Array<[string, unknown]>)
  .filter((entry): entry is [string, PgTable] => is(entry[1], PgTable))
  .sort(([left], [right]) => left.localeCompare(right));

const nameOf = (table: PgTable) =>
  tables.find(([, candidate]) => candidate === table)![0];

const encrypted = (table: PgTable) =>
  Object.entries(getTableColumns(table))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => `${nameOf(table)}.${key}`);

const parents = (table: PgTable) =>
  getTableConfig(table).foreignKeys.map((fk) => fk.reference().foreignTable);

/** Everything a table's foreign keys reach, itself included, pruning nothing. */
function closure(table: PgTable, seen = new Set<PgTable>()): Set<PgTable> {
  if (seen.has(table)) return seen;
  seen.add(table);
  for (const parent of parents(table)) closure(parent, seen);
  return seen;
}

/** The independent reading of the rule in `secret-mask.ts`'s docblock. */
function independentReach(root: PgTable): string[] {
  const reached = closure(root);
  for (const [, child] of tables) {
    if (parents(child).includes(root)) closure(child, reached);
  }
  return [...reached].flatMap(encrypted).sort();
}

const table = (name: string) =>
  tables.find(([candidate]) => candidate === name)![1];

describe('secretReachOf', () => {
  it('finds the Service tables and encrypted columns it censuses', () => {
    expect(
      SERVICE_TABLES.map((name) =>
        tables.some(([candidate]) => candidate === name),
      ),
    ).toEqual(SERVICE_TABLES.map(() => true));
    expect(tables.flatMap(([, t]) => encrypted(t)).length).toBeGreaterThan(40);
  });

  it('reaches from each Service table exactly what an unpruned walk of the schema reaches', () => {
    for (const name of SERVICE_TABLES) {
      expect({ [name]: secretReachOf(table(name)) }).toEqual({
        [name]: independentReach(table(name)),
      });
    }
  });

  it("covers a Service's own secrets, its Environment's and Project's, its registry's, its Server's key and its children's", () => {
    expect(secretReachOf(table('application'))).toEqual(
      expect.arrayContaining([
        'application.env',
        'application.buildSecrets',
        'environment.env',
        'project.env',
        'registry.password',
        'sshKey.privateKey',
        'mount.content',
        'security.password',
        // An Uptime check's header value, which get_service_health
        // reports only as hasHeaderValue.
        'uptimeCheck.headerValue',
        // An AI model's upstream secret, which get_service's aiModel
        // never projects, not even as a flag.
        'aiModelFacet.upstreamSecret',
        // Its Hugging Face token, which get_service projects only as
        // aiModel.hasHfToken.
        'aiModelFacet.hfToken',
      ]),
    );
    expect(secretReachOf(table('postgres'))).toEqual(
      expect.arrayContaining([
        'postgres.databasePassword',
        'destination.secretAccessKey',
      ]),
    );
    // An Environment target reaches up, not down: its Services are roots of
    // their own when a result names them.
    expect(secretReachOf(table('environment'))).toEqual([
      'environment.env',
      'project.env',
    ]);
  });

  it('leaves no encrypted column unreached by every Service unless it is written down with a reason', () => {
    const reached = new Set(
      SERVICE_TABLES.flatMap((name) => secretReachOf(table(name))),
    );
    const unreached = tables
      .flatMap(([, t]) => encrypted(t))
      .filter((column) => !reached.has(column))
      .sort();
    expect(unreached).toEqual(Object.keys(FROZEN_UNREACHED).sort());
  });

  it('reads a secret out of every reached column in the shape the driver hands it back', () => {
    const secret = 'a-stored-secret-value';
    const unread = SERVICE_TABLES.flatMap((name) => secretReachOf(table(name)))
      .filter((at, index, all) => all.indexOf(at) === index)
      .filter((at) => {
        const [tableName, key] = at.split('.');
        const column = getTableColumns(table(tableName))[key];
        // ADR 0006's pass-through: an unprefixed value comes back from the
        // driver unchanged by `encryptedText` and parsed by `encryptedJson` —
        // which is also how the two are told apart, as
        // `secret-bearing-columns.spec.ts` does.
        const isJson =
          typeof column.mapFromDriverValue(JSON.stringify({ probe: 1 })) ===
          'object';
        const stored: unknown = column.mapFromDriverValue(
          isJson
            ? JSON.stringify({ nested: [{ value: secret }] })
            : `OTHER=short\nexport TOKEN="${secret}"`,
        );
        return !secretValuesOf(stored).includes(secret);
      });
    expect(unread).toEqual([]);
  });
});
