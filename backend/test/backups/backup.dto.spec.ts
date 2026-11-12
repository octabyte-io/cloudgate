import {
  createBackupSchema,
  restoreBackupSchema,
  updateBackupSchema,
} from '../../src/backups/dto/backup.dto';

// The same fix one module over from `volume-backup.dto.spec.ts`: `serviceName` is the
// stack service of a compose backup, and it was `z.string().optional()` /
// `.nullable()` with no charset while every neighbour on the same schemas
// carried one.
//
// It reaches two sinks. `BackupsService.s3AppName` renders
// `{appName}_{serviceName}`, which is the dump key's **leading segment** — the
// segment the backup-authorization fix made an authorization boundary and
// `bucketPrefixCandidates` trims back at every `_`. And
// `getComposeContainerCommand` puts it in a `docker ps --filter label=…` word
// inside a `$(…)`, whose docblock said the `quote()` there was "the only thing standing".
//
// **These refusals are the belt, not the braces**, on `volume-backup.dto.spec.ts`'
// terms: the quoting is the fix those words need and they have it, and
// `backup-shell-safety.spec.ts` proves it by running them. What is asserted
// here is the accepting half as much as the refusing half — the bound is Docker
// Compose's own service-name charset, so a name a real stack declares is a name
// a backup of it can be registered against.

const validCreate = {
  schedule: '0 3 * * *',
  prefix: 'daily',
  database: 'shop',
  destinationId: 'dst-1',
  databaseType: 'postgres' as const,
  serviceId: 'pg-1',
};

const validRestore = {
  databaseId: 'pg-1',
  databaseType: 'postgres' as const,
  databaseName: 'shop',
  backupFile: 'main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
  destinationId: 'dst-1',
};

/** Each of these ends a command, opens a subshell, substitutes one or splits a
 * word, and every one of them is a legal character in a `z.string()`. */
const HOSTILE = [
  'x;touch /tmp/pwned #',
  'a$(id)',
  'a`id`',
  'a|id',
  'a&id',
  'a b',
  'a>out',
];

describe('createBackupSchema', () => {
  it('accepts the compose service names a real stack declares', () => {
    for (const serviceName of ['api', 'web-1', 'redis_cache', 'db.primary']) {
      expect(
        createBackupSchema.safeParse({
          ...validCreate,
          backupType: 'compose',
          serviceName,
        }).success,
      ).toBe(true);
    }
  });

  it('refuses a serviceName that could leave its shell word', () => {
    for (const serviceName of HOSTILE) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, serviceName }).success,
      ).toBe(false);
    }
  });

  it('refuses a serviceName that could make the dump key a second segment', () => {
    // The only character that would turn `{appName}_{serviceName}` into two
    // path components, and Compose's own charset has no slash in it.
    expect(
      createBackupSchema.safeParse({
        ...validCreate,
        serviceName: 'api/../other-app',
      }).success,
    ).toBe(false);
  });

  it('accepts a database backup that names no stack service', () => {
    expect(createBackupSchema.safeParse(validCreate).success).toBe(true);
  });

  // A follow-up. `prefix` and `database` were the two fields the stored-row
  // guard could not refuse anything on, because the guard is derived from this
  // schema and this schema held them to `z.string().min(1)` — so closing the
  // charset here closes the create route and every scheduled run at once.
  it('accepts the bucket prefixes a real schedule is written with', () => {
    for (const prefix of [
      'daily',
      'storefront/uploads',
      'db.dumps/2026',
      'hourly-1_2',
    ]) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, prefix }).success,
      ).toBe(true);
    }
  });

  it('refuses a prefix that could leave its shell word or open with a flag', () => {
    for (const prefix of [...HOSTILE, '-x/daily']) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, prefix }).success,
      ).toBe(false);
    }
  });

  it('accepts the slashed and padded prefixes rows already hold', () => {
    // The regression this charset could have been, and the reason the rule is
    // on `normalizeS3Path(prefix)` rather than on the stored string. The
    // console's own form schema trims this field but has never stripped a
    // slash, and `backup-schedule-spec.tsx` renders a stored prefix as
    // `row.prefix.replace(/^\/+/, "")` — that file admitting the slashed rows
    // exist; the padded ones are reachable because this DTO is the whole
    // boundary on the only two writes this column has and it never trimmed
    // either. Every one of these denotes the key `daily/` today, and a rule
    // that refused them would refuse the runs of working nightly backups.
    for (const prefix of [
      '/daily',
      'daily/',
      '/daily/',
      ' /daily/ ',
      ' a/b ',
    ]) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, prefix }).success,
      ).toBe(true);
    }
  });

  it('refuses a prefix that denotes no path at all', () => {
    // `min(1)` already says a schedule needs a prefix; this is the same
    // refusal said about the path rather than about the string, since both
    // normalize to `''` and would write the dump straight under `{appName}/`.
    for (const prefix of ['/', '   ']) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, prefix }).success,
      ).toBe(false);
    }
  });

  it('accepts the database names the five engines actually carry', () => {
    // The set is every character these engines take in an unquoted identifier,
    // plus the `.` and `-` a real name uses. A refusal here would be a schedule
    // nobody can register for a database that exists.
    for (const database of [
      'shop',
      'shop_v2',
      'app-prod',
      'shop.v2',
      '_staging',
      'db1',
      // Legal unquoted in MySQL and MariaDB, and legal in a Postgres
      // identifier after the first character. It is in the set because it is
      // in theirs — a name that exists and a backup that cannot be registered
      // for it is the cost of leaving a harmless character out.
      'shop$archive',
      // libsql's `database` is the directory under `/var/lib/sqld`, and
      // `LibsqlService`'s own command line names `iku.db`.
      'iku.db',
    ]) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, database }).success,
      ).toBe(true);
    }
  });

  it('refuses a database name the dump tool would read as an option', () => {
    // `quote()` leaves `--file=…` exactly as it is, and the value is a bare
    // positional word in `pg_dump`, `mysqldump` and `mariadb-dump --databases`.
    // Quoting cannot refuse this one; the first character is what does.
    for (const database of ['--file=/tmp/pwned', '-h', ...HOSTILE]) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, database }).success,
      ).toBe(false);
    }
  });

  it('refuses a database name that could climb out of the sqld data directory', () => {
    // libsql has no dump tool, so its dump is `tar cf - -C /var/lib/sqld <db>`
    // and the name is a path component on the run host.
    for (const database of ['..', '../../etc', 'shop/../../etc']) {
      expect(
        createBackupSchema.safeParse({ ...validCreate, database }).success,
      ).toBe(false);
    }
  });
});

describe('updateBackupSchema', () => {
  it('refuses on the PATCH the create route refuses on, and keeps the detach', () => {
    // `.partial()`, so a payload naming only this field is the whole test — a
    // PATCH is the other way a stored value comes to carry a payload.
    expect(
      updateBackupSchema.safeParse({ serviceName: 'a$(id)' }).success,
    ).toBe(false);
    expect(updateBackupSchema.safeParse({ serviceName: 'api' }).success).toBe(
      true,
    );
    // The column is nullable and `null` is how the stack service is cleared.
    expect(updateBackupSchema.safeParse({ serviceName: null }).success).toBe(
      true,
    );
  });

  it('re-points a schedule only at a prefix and a database name the run can use', () => {
    // A PATCH is the other way a stored value comes to carry a payload, and the
    // two fields the guard is derived from have to refuse on both routes or the
    // charset is a suggestion.
    expect(updateBackupSchema.safeParse({ prefix: 'weekly' }).success).toBe(
      true,
    );
    expect(updateBackupSchema.safeParse({ prefix: 'a$(id)' }).success).toBe(
      false,
    );
    expect(updateBackupSchema.safeParse({ database: 'shop.v2' }).success).toBe(
      true,
    );
    expect(
      updateBackupSchema.safeParse({ database: '--file=/tmp/pwned' }).success,
    ).toBe(false);
  });
});

describe('restoreBackupSchema', () => {
  it('refuses a metadata serviceName that could leave its shell word', () => {
    // The third spelling of the same field: a compose restore carries the
    // stack service inside `metadata`, and `restore` hands it to
    // `getComposeContainerCommand` exactly as a run does.
    for (const serviceName of HOSTILE) {
      expect(
        restoreBackupSchema.safeParse({
          ...validRestore,
          backupType: 'compose',
          metadata: { serviceName },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts the metadata a real compose restore carries', () => {
    expect(
      restoreBackupSchema.safeParse({
        ...validRestore,
        backupType: 'compose',
        metadata: {
          serviceName: 'db.primary',
          postgres: { databaseUser: 'shop' },
        },
      }).success,
    ).toBe(true);
  });
});

/**
 * The credentials a compose backup carries because its engine has no row of its
 * own — and the one place in this module where the answer to "give it a
 * charset" is no.
 *
 * The accepting half is the point of the group. A password is graded on
 * containing exactly the characters a charset refuses, so a rule here would
 * refuse working stacks and refuse the best-defended ones first; every one of
 * these values is `quote()`d at the word it reaches, which
 * `backup-shell-safety.spec.ts` proves by running them. What is refused is the
 * one thing that is not a credential at all — an empty user, which no engine
 * can dump as and which `credentialsFor`'s `??` chain stops on rather than
 * falling through to the next engine's real one.
 */
describe('composeMetadataSchema', () => {
  const composeCreate = {
    ...validCreate,
    backupType: 'compose' as const,
    serviceName: 'db',
    serviceId: 'cmp-1',
  };

  it('accepts a password made of the characters a charset would refuse', () => {
    for (const databasePassword of HOSTILE) {
      expect(
        createBackupSchema.safeParse({
          ...composeCreate,
          metadata: { mariadb: { databaseUser: 'shop', databasePassword } },
        }).success,
      ).toBe(true);
    }
  });

  it('accepts an engine configured with no password at all', () => {
    // MYSQL_ALLOW_EMPTY_PASSWORD, and a MariaDB user created without one. The
    // objects require both fields, so `''` is the only way such a stack can
    // spell what it has — refusing it would stop the backup rather than the
    // attack.
    expect(
      createBackupSchema.safeParse({
        ...composeCreate,
        metadata: { mysql: { databaseRootPassword: '' } },
      }).success,
    ).toBe(true);
    expect(
      createBackupSchema.safeParse({
        ...composeCreate,
        metadata: { mongo: { databaseUser: 'root', databasePassword: '' } },
      }).success,
    ).toBe(true);
  });

  it('refuses an empty engine user, which is not how no user is said', () => {
    // No engine dumps as `''` — `pg_dump -U ''` and `mongodump -u ''` both
    // fail — so the row can only have been a mistake, and this is the
    // difference between a 400 on the request that made it and a red run every
    // night. Absence is spelled by leaving the engine's object out.
    expect(
      createBackupSchema.safeParse({
        ...composeCreate,
        metadata: { postgres: { databaseUser: '' } },
      }).success,
    ).toBe(false);
    expect(
      createBackupSchema.safeParse({ ...composeCreate, metadata: {} }).success,
    ).toBe(true);
    // And the one shape where `''` and absence genuinely part company:
    // `credentialsFor` resolves `postgres ?? mariadb ?? mongo`, and `??` falls
    // through an omitted object but stops on an empty string — so this row
    // would dump as nobody while carrying a real Mongo user two lines down.
    expect(
      createBackupSchema.safeParse({
        ...composeCreate,
        metadata: {
          postgres: { databaseUser: '' },
          mongo: { databaseUser: 'root', databasePassword: 'hunter2' },
        },
      }).success,
    ).toBe(false);
  });
});
