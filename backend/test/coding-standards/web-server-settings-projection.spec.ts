import { getTableColumns } from 'drizzle-orm';
import {
  defaultWebServerMetricsConfig,
  webServerSettings,
} from '../../src/settings/settings.schema';
import type { WebServerSettingsRow } from '../../src/settings/settings.schema';
import { sanitizeWebServerSettings } from '../../src/settings/settings.service';

/**
 * The property, stated once:
 *
 * > every secret the `web_server_settings` singleton carries is projected out
 * > of the shape a controller may answer with, and replaced by its presence at
 * > the depth the secret lives at (ADR 0019)
 *
 * **What broke, and why a type could not hold it.** `stripSshPrivateKey`
 * projected out `sshPrivateKey` and returned the rest of the row whole, so
 * `metricsConfig` — **token included** — came back from `GET
 * /settings/web-server`, which is the one read on that row open to any
 * authenticated member. Possession of that token is the whole of `POST
 * /notifications/receive`'s authentication, and the copy on *this* row
 * authenticates `receiveServerThreshold`'s instance-wide branch, so a plain
 * member of any organization could read it and write attacker-chosen alert text
 * into every tenant's channels. Encrypting the column came with the note, in as
 * many words that at-rest encryption is orthogonal to API exposure; this is the
 * API-exposure half, and `settings/web-server-secrets.e2e-spec.ts` proves that
 * one attack closed over the wire.
 *
 * The asymmetry was never that the token was missed once. It is that the
 * function was **named for a single column**, so there was nowhere for a second
 * secret to be declared — and renaming it to `sanitizeWebServerSettings` does
 * not by itself fix that, because **the compiler cannot state this property**.
 * `SanitizedWebServerSettings` is `Omit<WebServerSettingsRow, …>` intersected
 * with the presence flags, and `Omit` *retains* every key it is not told to
 * drop: `sanitizeWebServerSettings` supplies those keys through `...rest`, and
 * no excess-property check applies to a spread of already-typed keys. So a new
 * `apiKey` column would compile, pass through `...rest`, and be served. What
 * the types really enforce is narrower and worth having — renaming or removing
 * `metricsConfig` or `metricsConfig.server.token` breaks the build, and no
 * controller can return the raw row — but it is not "a new secret
 * column fails to compile", and the docblock said so until this file existed.
 * That is the definition of something to assert over the schema rather than
 * claim in prose (`parent-id-writes.spec.ts`' argument).
 *
 * **Completeness comes from the property next door, not from a table here.**
 * The obvious shape — enumerate all fifteen columns against a declared list —
 * is a table that has to be edited for `buildsConcurrency`, and a table is what
 * the deploy-webhook bug shipped from. Instead the requirement is *derived*
 * from two signals that a new secret cannot avoid:
 *
 * 1. **Encrypted at rest.** `secret-bearing-columns.spec.ts` already asserts
 *    that a column on this row holding a credential is `encryptedText` or
 *    `encryptedJson` (ADR 0006). So that file's rule is this
 *    one's completeness argument: a secret here must be encrypted, and this
 *    file requires everything encrypted to be withheld or to carry a written
 *    reason why it is returned. The two properties compose into the claim the
 *    docblock wanted — *one list, so the next secret on this row cannot be
 *    forgotten* — which neither makes alone.
 * 2. **A name that says so**, for the depth the compiler and `drizzle-kit`
 *    cannot see at all: a *field* inside a declared blob. `metricsConfig`'s
 *    secret was a field, and {@link VOCABULARY} over the column's declared
 *    default is how that file's own property reached it.
 *
 * **The column-level half has no live case since the change** that dropped
 * `sshPrivateKey` — the only encrypted column this row ever withheld whole. So
 * the case that exercises it now does so against a synthetic encrypted column
 * (`apiKey`, below), which is what keeps "withholds every encrypted column"
 * from passing over an empty set.
 *
 * **What this cannot see**, recorded rather than left to be discovered: a
 * secret that is neither encrypted at rest nor named like a credential. Signal
 * 1 is the floor for a column and it is a strong one — a plaintext credential
 * column on this row is already red in `secret-bearing-columns.spec.ts` — but
 * signal 2 is only a name, so a new blob *field* called `handshake` or
 * `bearer`, projected nowhere, passes here. That is the same limit that file
 * documents about its own vocabulary, and for the same reason: widening the
 * regex buys false positives on `cronJob` and `urlCallback` faster than it buys
 * reach.
 */

/**
 * The words that make a name a claim about its contents, matched against whole
 * camelCase words. Deliberately the same regex as
 * `secret-bearing-columns.spec.ts`, spelled a second time rather than imported:
 * a jest spec exports nothing, and a shared fixture module between two
 * coding-standards properties would let a widening in one silently change what
 * the other asserts. The first case below pins both halves of it against this
 * row — what it must match and what it must not — so a divergence shows up as a
 * failure here rather than as a property that quietly stopped asserting.
 */
const VOCABULARY =
  /^(token|secret|secrets|password|passwd|credential|credentials|passphrase|salt|signature|key|keys)$/;

/** Whether a column or field name claims to hold a credential. */
function namesACredential(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => VOCABULARY.test(word));
}

/**
 * The presence flag that stands in for a withheld secret: `has` + the name it
 * replaced. Derived rather than listed, because every flag this row has had is
 * spelled that way (`hasSshPrivateKey` once, `hasToken`) and a list of
 * names is a table again. A future secret that genuinely wants another spelling
 * adds an entry to {@link PRESENCE_FLAG_OVERRIDES} with the sentence for it.
 */
function presenceFlagFor(name: string): string {
  return (
    PRESENCE_FLAG_OVERRIDES[name] ??
    `has${name[0].toUpperCase()}${name.slice(1)}`
  );
}

/** Withheld secrets whose flag is not `has` + their name, and why. */
const PRESENCE_FLAG_OVERRIDES: Readonly<Record<string, string>> = {};

/**
 * Columns that are encrypted at rest and that the projection **still returns**,
 * each with the sentence that makes it one. A reason rather than a bare name,
 * on the deploy-webhook bug's lesson: a list of names with no arguments beside
 * them is the artefact this whole family of specs exists because of.
 */
const RETURNED_ENCRYPTED: Readonly<Record<string, string>> = {
  metricsConfig: [
    'the secret on this column is one field deep, not the column. The blob is',
    'the host’s sampling configuration — refresh rates, thresholds, retention,',
    'the container include/exclude lists — and the Monitoring screen a plain',
    'member reaches genuinely reads it; only `server.token` authenticates',
    'anything. So the column is returned and the field is withheld, which the',
    'blob-field case below asserts over `defaultWebServerMetricsConfig`. ADR',
    '0019’s rule is *at the depth the secret lives at* for this case: `hasToken`',
    'stands where `token` was, so one predicate in the console serves a',
    '`server` row and this singleton without a second argument.',
  ].join(' '),
};

/**
 * Fields inside a declared blob that the projection withholds. Derived the same
 * way — {@link VOCABULARY} over the column's declared default decides *that* a
 * field must be withheld — so this map carries only the reasons, and a field
 * the vocabulary flags with no entry here fails by name.
 */
const WITHHELD_FIELDS: Readonly<Record<string, string>> = {
  'metricsConfig.server.token': [
    'the metrics agent credential. `POST /notifications/receive` authenticates',
    'on possession of it alone, and the copy on this singleton drives',
    '`receiveServerThreshold`’s instance-wide branch — `dispatch(null, …)`,',
    'every organization’s channels rather than one.',
  ].join(' '),
};

/**
 * The singleton's columns, by property name — plus any `extra` a case adds to
 * prove the derivation reaches a column the schema does not have yet.
 */
function columns(extra: [string, string][] = []): [string, string][] {
  return [
    ...Object.entries(getTableColumns(webServerSettings)).map(
      ([key, column]): [string, string] => [key, column.columnType],
    ),
    ...extra,
  ];
}

/**
 * Whether a column is one of the secret-bearing types. `encryptedText` and
 * `encryptedJson` are drizzle `customType`s and nothing else on this table is,
 * so `PgCustomColumn` is the whole test — `isoTimestamp` and `nanoidPk` report
 * `PgText`. This is the same signal `secret-bearing-columns.spec.ts` reads, and
 * it is asserted below to find exactly the two columns it should.
 */
function isEncrypted(columnType: string): boolean {
  return columnType === 'PgCustomColumn';
}

/**
 * The leaf paths of a declared blob default, dotted. Arrays are leaves: the
 * include/exclude lists hold service names, and recursing into a `[]` would
 * enumerate nothing anyway.
 */
function fieldsOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    fieldsOf(v, prefix ? `${prefix}.${key}` : key),
  );
}

/** Read a dotted path out of a parsed response, or `undefined`. */
function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

/** Whether a dotted path is present at all — `undefined` is absent. */
function has(value: unknown, path: string): boolean {
  const parent = path.includes('.')
    ? at(value, path.slice(0, path.lastIndexOf('.')))
    : value;
  if (!parent || typeof parent !== 'object') return false;
  return path.slice(path.lastIndexOf('.') + 1) in parent;
}

/** Every string anywhere in a value, for the relocation assertion. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

/** A distinctive value for one column or field, so a *move* is detectable. */
const marker = (path: string) => `«${path}»`;

/**
 * A row whose every string carries the marker for where it sat, built from the
 * schema rather than typed out: a column added to the table appears in this
 * fixture with no edit, which is what lets the assertions below fail by name.
 *
 * **Cast rather than typed**, and that is the point of the file: the compiler's
 * view of this row is exactly what these assertions decline to trust, and
 * `server.type` is a two-member union that no marker string satisfies.
 */
function markerRow(
  overrides: Partial<Record<string, unknown>> = {},
): WebServerSettingsRow {
  const row: Record<string, unknown> = {};
  for (const [key] of columns()) row[key] = marker(key);
  row.metricsConfig = withMarkers(
    defaultWebServerMetricsConfig,
    'metricsConfig',
  );
  return { ...row, ...overrides } as unknown as WebServerSettingsRow;
}

/** Every string leaf of a declared default replaced by its path's marker. */
function withMarkers(value: unknown, prefix: string): unknown {
  if (typeof value === 'string') return marker(prefix);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      withMarkers(v, `${prefix}.${key}`),
    ]),
  );
}

/**
 * The columns a projection failed: encrypted or credential-named, not returned
 * on a written reason, and still present in `sanitized` or missing the
 * presence flag that should stand in their place.
 */
function unwithheldColumns(
  sanitized: unknown,
  cols: [string, string][],
): [string, string][] {
  return cols.filter(
    ([key, columnType]) =>
      (isEncrypted(columnType) || namesACredential(key)) &&
      !(key in RETURNED_ENCRYPTED) &&
      (has(sanitized, key) ||
        typeof at(sanitized, presenceFlagFor(key)) !== 'boolean'),
  );
}

describe('sanitizeWebServerSettings, on every secret the singleton carries', () => {
  /**
   * The two signals, pinned against this row before anything is derived from
   * them. Without this the whole file could pass vacuously: a `columnType`
   * drizzle renames finds no encrypted columns, and a regex that stopped
   * matching `privateKey` finds no secrets to require a projection of.
   */
  it('reads the two signals it derives everything else from', () => {
    // Stated as "finds these, and does not find those" rather than as the
    // exact sets, deliberately: an equality here would be the fifteen-row
    // table this file argues against, and would go red on a *correctly*
    // projected new secret.
    const encrypted = columns()
      .filter(([, type]) => isEncrypted(type))
      .map(([key]) => key);
    const fields = fieldsOf(defaultWebServerMetricsConfig, 'metricsConfig');

    expect({
      encrypted: ['metricsConfig'].filter((key) => !encrypted.includes(key)),
      plain: [
        'id',
        'serverIp',
        'host',
        'createdAt',
        'whitelabelingConfig',
      ].filter((key) => encrypted.includes(key)),
      // `privateKey` is pinned as a *name* — the vocabulary must still reach
      // it — though the column that carried it is dropped.
      flagged: ['sshPrivateKey', 'metricsConfig.server.token'].filter(
        (path) =>
          !namesACredential(path.slice(path.lastIndexOf('.') + 1)) ||
          (path.includes('.') && !fields.includes(path)),
      ),
      overreached: [
        'logCleanupCron',
        'certificateType',
        'buildsConcurrency',
        'metricsConfig.server.cronJob',
        'metricsConfig.server.urlCallback',
        'metricsConfig.containers.refreshRate',
      ].filter((path) =>
        namesACredential(path.slice(path.lastIndexOf('.') + 1)),
      ),
    }).toEqual({ encrypted: [], plain: [], flagged: [], overreached: [] });
  });

  /**
   * The derivation below, over a column the schema does not have: an
   * `encryptedText` `apiKey` added to the table would pass `...rest` straight
   * into the response, and the loop must be what says so. Without this the
   * column half of the property has asserted nothing since dropping it left
   * `metricsConfig` — returned, on a written reason — as the only encrypted
   * column.
   */
  it('goes red on a new encrypted column the projection does not know', () => {
    const extra: [string, string][] = [['apiKey', 'PgCustomColumn']];
    const sanitized = sanitizeWebServerSettings(
      markerRow({ apiKey: marker('apiKey') }),
    );

    expect(
      unwithheldColumns(sanitized, columns(extra)).map(([key]) => key),
    ).toEqual(['apiKey']);
  });

  it('withholds every encrypted column that is not deliberately returned', () => {
    const row = markerRow();
    const sanitized = sanitizeWebServerSettings(row);

    expect(unwithheldColumns(sanitized, columns())).toEqual([]);

    for (const [key, columnType] of columns()) {
      if (!isEncrypted(columnType) && !namesACredential(key)) continue;
      if (key in RETURNED_ENCRYPTED) {
        // Returned on a written argument, and the argument has to be about a
        // column that still exists.
        expect(RETURNED_ENCRYPTED[key]).not.toHaveLength(0);
        expect(has(sanitized, key)).toBe(true);
        continue;
      }
      expect({ key, present: has(sanitized, key) }).toEqual({
        key,
        present: false,
      });
      // …and its presence stands where it stood.
      expect({ key, flag: typeof at(sanitized, presenceFlagFor(key)) }).toEqual(
        {
          key,
          flag: 'boolean',
        },
      );
    }
  });

  it('withholds every blob field whose name says it is a credential, at the depth it lives at', () => {
    const row = markerRow();
    const sanitized = sanitizeWebServerSettings(row);

    for (const path of fieldsOf(
      defaultWebServerMetricsConfig,
      'metricsConfig',
    )) {
      const name = path.slice(path.lastIndexOf('.') + 1);
      const withheld = namesACredential(name) || path in WITHHELD_FIELDS;
      if (!withheld) {
        expect({ path, present: has(sanitized, path) }).toEqual({
          path,
          present: true,
        });
        continue;
      }
      expect(WITHHELD_FIELDS[path]).toBeDefined();
      expect({ path, present: has(sanitized, path) }).toEqual({
        path,
        present: false,
      });
      const flag = `${path.slice(0, path.lastIndexOf('.') + 1)}${presenceFlagFor(name)}`;
      expect({ path, flag, type: typeof at(sanitized, flag) }).toEqual({
        path,
        flag,
        type: 'boolean',
      });
    }
  });

  it('returns every column it does not withhold', () => {
    const row = markerRow();
    const sanitized = sanitizeWebServerSettings(row);
    const withheld = columns()
      .filter(
        ([key, type]) =>
          (isEncrypted(type) || namesACredential(key)) &&
          !(key in RETURNED_ENCRYPTED),
      )
      .map(([key]) => key);

    expect(
      columns()
        .map(([key]) => key)
        .filter((key) => !withheld.includes(key) && !has(sanitized, key)),
    ).toEqual([]);
  });

  /**
   * The assertion that a projection which merely *relocated* a secret cannot
   * pass — `stripSshPrivateKey`'s mistake in the other direction, and the same
   * argument `web-server-secrets.e2e-spec.ts` makes over the wire.
   */
  it('never relocates a withheld value somewhere else in the response', () => {
    const row = markerRow();
    const strings = stringsIn(sanitizeWebServerSettings(row));

    const withheldPaths = [
      ...columns()
        .filter(
          ([key, type]) =>
            (isEncrypted(type) || namesACredential(key)) &&
            !(key in RETURNED_ENCRYPTED),
        )
        .map(([key]) => key),
      ...fieldsOf(defaultWebServerMetricsConfig, 'metricsConfig').filter(
        (path) =>
          namesACredential(path.slice(path.lastIndexOf('.') + 1)) ||
          path in WITHHELD_FIELDS,
      ),
    ];

    expect(
      withheldPaths.filter((path) => strings.includes(marker(path))),
    ).toEqual([]);
  });

  /**
   * A flag whose value is not read off the secret is a flag that lies, which is
   * worse than the column being absent: `configCollects` in the console reads
   * `hasToken` as the *collecting* switch, and `defaultWebServerMetricsConfig`
   * ships
   * `token: ''` for "never set up".
   */
  it('reports presence, not merely a boolean', () => {
    const set = sanitizeWebServerSettings(markerRow());
    expect(set.metricsConfig.server.hasToken).toBe(true);

    const fresh = sanitizeWebServerSettings(
      markerRow({ metricsConfig: defaultWebServerMetricsConfig }),
    );
    expect(fresh.metricsConfig.server.hasToken).toBe(false);
  });
});
