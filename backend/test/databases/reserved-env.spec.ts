import { parse } from 'dotenv';
import { prepareEnvironmentVariables } from '../../src/docker/docker.utils';
import { saveLibsqlEnvironmentSchema } from '../../src/databases/libsql/dto/libsql.dto';
import { saveMariadbEnvironmentSchema } from '../../src/databases/mariadb/dto/mariadb.dto';
import { saveMongoEnvironmentSchema } from '../../src/databases/mongo/dto/mongo.dto';
import { saveMysqlEnvironmentSchema } from '../../src/databases/mysql/dto/mysql.dto';
import { savePostgresEnvironmentSchema } from '../../src/databases/postgres/dto/postgres.dto';
import { saveRedisEnvironmentSchema } from '../../src/databases/redis/dto/redis.dto';
import { LibsqlService } from '../../src/databases/libsql/libsql.service';
import { MariadbService } from '../../src/databases/mariadb/mariadb.service';
import { MongoService } from '../../src/databases/mongo/mongo.service';
import { MysqlService } from '../../src/databases/mysql/mysql.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { RedisService } from '../../src/databases/redis/redis.service';
import {
  DatabaseEngine,
  ENGINE_ENV_OWNERS,
  RESERVED_ENV_PREFIX,
  databaseEnvSchema,
  engineOwnedEnvKeys,
  reservedEnvKeys,
  withEngineEnv,
} from '../../src/databases/common/reserved-env';

/**
 * The two rules about the one
 * concatenation, and the reason there are two.
 *
 * `BaseDatabaseService.deployInternal` used to build a container's environment
 * as `defaultEnv(row)` and *then* the row's own `env`, and resolve the pair
 * through `prepareEnvironmentVariables`, which parses with `dotenv` — where the
 * later assignment of a duplicate key wins. One fix closed that for the `CG_`
 * holders by refusing the write. A second closed it for the engines' own derived
 * names by refusing the write *and* laying the engine's values over the
 * operator's at the deploy, and removed the concatenation altogether so the
 * derived values stop being text at all.
 *
 * The first block below measures the `dotenv` behaviour every one of those
 * sentences rests on, against the real library rather than trusting the
 * sentence — including one claim that does **not** hold, because the ticket
 * asserted it and it is the reason the fix is shaped the way it is.
 */
describe('databaseEnvSchema and withEngineEnv, the two rules a database environment is under', () => {
  describe('the dotenv behaviour the rules rest on', () => {
    it('lets a later assignment of the same key win', () => {
      // The whole mechanism, in one line of library behaviour.
      expect(parse('A=1\nA=2')).toEqual({ A: '2' });
    });

    it('does NOT truncate `POSTGRES_DB="a"b"` to `a` — the claim as filed does not reproduce', () => {
      // The ticket's falsifiable claim was that `defaultEnv`'s
      // `POSTGRES_DB="${row.databaseName}"` with a `databaseName` of `a"b`
      // gives a container whose `POSTGRES_DB` is silently `a`. Measured on
      // dotenv 17.4.2 it is `a"b`, exactly: the quoted alternative of dotenv's
      // LINE regex fails (it cannot span the inner `"`), the unquoted
      // `[^#\r\n]+` fallback matches the whole `"a"b"`, and the
      // surrounding-quote strip peels it back to the original. Pinned as a
      // negative so that a dotenv upgrade which *does* truncate is a red test
      // rather than a silent regression to the reported defect.
      expect(parse('POSTGRES_DB="a"b"')).toEqual({ POSTGRES_DB: 'a"b' });
    });

    it('is lossy on the two shapes that are reachable, which is what item 2 really was', () => {
      // A `#` after the inner quote defeats the fallback too, and what
      // survives keeps a quote the row never held and loses the tail.
      expect(parse('POSTGRES_DB="a"b#c"')).toEqual({ POSTGRES_DB: '"a"b' });

      // And the one that matters: a `"` plus a newline ends the value early
      // and the rest of the column becomes *further assignments*. The row
      // asked for a database name; the container got a second variable.
      expect(
        parse('POSTGRES_DB="shop"\nPOSTGRES_HOST_AUTH_METHOD=trust\n"x"'),
      ).toEqual({
        POSTGRES_DB: 'shop',
        POSTGRES_HOST_AUTH_METHOD: 'trust',
      });
    });

    it('has no quoting form that round-trips an arbitrary value', () => {
      // Why the fix is pairs rather than a better escaper at the emitter.
      // Double quotes turn a literal backslash-n into a newline:
      expect(parse('A="a\\nb"').A).toBe('a\nb');
      // …and do not unescape an escaped quote, so a backslash survives:
      expect(parse('A="a\\"b"').A).toBe('a\\"b');
      // Single quotes have no escape for a single quote:
      expect(parse("A='o'brien'").A).toBe("o'brien");
      // Backticks have none for a backtick:
      expect(parse('A=`a`b`').A).toBe('a`b');
      // The unquoted fallback truncates at a comment marker:
      expect(parse('A=a#b').A).toBe('a');
    });

    it('lets an operator body swallow what follows it, which is why the override is a filter', () => {
      // The one-line alternative to `withEngineEnv` was to put the engine's
      // pairs *after* the operator's in one body and let later-wins do the
      // work. A quote the operator opens on one line and closes on another
      // swallows everything in between — including whatever was appended after
      // it — so the platform's credential would have been at the mercy of the
      // operator's text. A single *unterminated* quote does not do this
      // (measured: `FOO="bar` alone parses as the four characters `"bar`),
      // which is why the shape below needs the second quote.
      expect(
        parse('FOO="bar\nPOSTGRES_PASSWORD=stored\nBAZ=qux"'),
      ).not.toHaveProperty('POSTGRES_PASSWORD');
      expect(parse('FOO="bar\nPOSTGRES_PASSWORD=stored').FOO).toBe('"bar');
    });
  });

  describe('withEngineEnv', () => {
    const engineEnv = { POSTGRES_DB: 'shop', POSTGRES_PASSWORD: 'stored' };

    it('gives the container the engine value and names what it dropped', () => {
      const { env, overridden } = withEngineEnv(
        prepareEnvironmentVariables('POSTGRES_PASSWORD=other\nPGTZ=UTC'),
        engineEnv,
      );
      expect(env).toContain('POSTGRES_PASSWORD=stored');
      expect(env).not.toContain('POSTGRES_PASSWORD=other');
      expect(env).toContain('PGTZ=UTC');
      // Named, because the objection to shadowing is that it says nothing.
      expect(overridden).toEqual(['POSTGRES_PASSWORD']);
    });

    it('leaves a non-colliding operator variable alone and reports nothing', () => {
      const { env, overridden } = withEngineEnv(
        prepareEnvironmentVariables('PGTZ=UTC'),
        engineEnv,
      );
      expect(env).toEqual([
        'POSTGRES_DB=shop',
        'POSTGRES_PASSWORD=stored',
        'PGTZ=UTC',
      ]);
      expect(overridden).toEqual([]);
    });

    it('carries a value dotenv could not have represented', () => {
      // The point of pairs. Nothing here is parsed, so nothing is escaped.
      const hostile = 'shop"\nPOSTGRES_HOST_AUTH_METHOD=trust\n"x';
      const { env } = withEngineEnv([], { POSTGRES_DB: hostile });
      expect(env).toEqual([`POSTGRES_DB=${hostile}`]);
      expect(env.map((pair) => pair.split('=')[0])).toEqual(['POSTGRES_DB']);
    });

    it('reads a key the way the deploy does, up to the first `=`', () => {
      // `prepareEnvironmentVariables` emits `${key}=${resolved}`, so a value
      // containing an `=` must not make the key unrecognisable.
      const { env, overridden } = withEngineEnv(
        ['POSTGRES_PASSWORD=a=b=c', 'OTHER=x=y'],
        engineEnv,
      );
      expect(overridden).toEqual(['POSTGRES_PASSWORD']);
      expect(env).toContain('OTHER=x=y');
    });
  });

  describe('what the write refuses', () => {
    it('refuses the holder redis actually reads', () => {
      const parsed = databaseEnvSchema('redis').safeParse(
        'CG_REDIS_REQUIREPASS=hunter2',
      );
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain(
        'CG_REDIS_REQUIREPASS',
      );
    });

    it('refuses the whole prefix, not the holders that happen to exist today', () => {
      // The point of a prefix rather than a list: the next engine's holder is
      // covered before it is written.
      for (const body of [
        'CG_MONGO_ROOT_PASSWORD=x',
        'CG_MONGO_ROOT_USERNAME=x',
        'CG_SOMETHING_NOBODY_HAS_WRITTEN_YET=x',
        'CG_=x',
      ]) {
        expect(databaseEnvSchema('redis').safeParse(body).success).toBe(false);
      }
    });

    it('names every offending key, so one 400 answers a whole paste', () => {
      const parsed = databaseEnvSchema('redis').safeParse(
        'A=1\nCG_ONE=1\nB=2\nCG_TWO=2',
      );
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('CG_ONE, CG_TWO');
    });

    it('refuses a reserved key however dotenv is willing to spell it', () => {
      // The refusal has to agree with the deploy about what an assignment is,
      // which is why `reservedEnvKeys` parses with dotenv rather than matching
      // lines: every body here is one dotenv reads as a `CG_`-prefixed key,
      // and none of them is a plain `CG_X=1` at the start of a line.
      for (const body of [
        'export CG_REDIS_REQUIREPASS=hunter2',
        '  CG_REDIS_REQUIREPASS  =  hunter2  ',
        'HARMLESS=1\nCG_REDIS_REQUIREPASS="hunter2"',
        "CG_REDIS_REQUIREPASS='hunter2'",
      ]) {
        expect(parse(body)).toHaveProperty('CG_REDIS_REQUIREPASS');
        expect(databaseEnvSchema('redis').safeParse(body).success).toBe(false);
      }
    });

    it("names the column that owns an engine's own variable, rather than only refusing it", () => {
      // The difference between this refusal and the `CG_` one: a `CG_` name is
      // renamed, an engine's name is a value that lives somewhere, and the
      // message has to say where or the operator has been told "no" and
      // nothing else.
      const parsed = databaseEnvSchema('postgres').safeParse(
        'POSTGRES_PASSWORD=other',
      );
      expect(parsed.success).toBe(false);
      const message = parsed.error?.issues[0]?.message ?? '';
      expect(message).toContain('POSTGRES_PASSWORD');
      expect(message).toContain('databasePassword');
    });

    it('reports both rules at once when a body trips both', () => {
      const parsed = databaseEnvSchema('postgres').safeParse(
        'CG_ANYTHING=1\nPOSTGRES_DB=other',
      );
      expect(parsed.success).toBe(false);
      const messages = (parsed.error?.issues ?? []).map(
        (issue) => issue.message,
      );
      expect(messages).toHaveLength(2);
      expect(messages.join(' ')).toContain('CG_ANYTHING');
      expect(messages.join(' ')).toContain('databaseName');
    });

    it('is per-engine, because a name one engine derives another has no opinion about', () => {
      // Refusing every engine's names on every engine would take
      // `MONGO_INITDB_ROOT_PASSWORD` away from a postgres row that has no such
      // variable, which narrows something real for nothing.
      expect(
        databaseEnvSchema('postgres').safeParse('MONGO_INITDB_ROOT_PASSWORD=x')
          .success,
      ).toBe(true);
      expect(
        databaseEnvSchema('mongo').safeParse('MONGO_INITDB_ROOT_PASSWORD=x')
          .success,
      ).toBe(false);
      expect(
        databaseEnvSchema('mongo').safeParse('POSTGRES_PASSWORD=x').success,
      ).toBe(true);
    });

    it("refuses both of mysql's branches' names, whichever branch the row is on", () => {
      // `ENGINE_ENV_OWNERS.mysql` is the union: which branch a row is on is
      // one `databaseUser` write away from changing, and the write path has no
      // row in hand.
      for (const key of [
        'MYSQL_USER',
        'MYSQL_PASSWORD',
        'MYSQL_DATABASE',
        'MYSQL_ROOT_PASSWORD',
      ]) {
        expect(databaseEnvSchema('mysql').safeParse(`${key}=x`).success).toBe(
          false,
        );
      }
    });
  });

  describe('what the write still takes', () => {
    it('takes an ordinary environment, null, and empty', () => {
      for (const body of [
        'REDIS_MAXMEMORY_POLICY=allkeys-lru',
        'MY_CG_FLAG=1',
        'PREFIXED_CG_=1',
        'CGX=1',
        'cg_lowercase=1',
        '# CG_REDIS_REQUIREPASS=only-a-comment',
        '',
      ]) {
        expect(databaseEnvSchema('redis').safeParse(body).success).toBe(true);
      }
      expect(databaseEnvSchema('redis').safeParse(null).success).toBe(true);
    });

    it('takes a documented image variable the platform does not emit', () => {
      // The refusal is confined to names derived from a column, so the rest of
      // an image's interface stays the operator's. This is the half of the
      // decision that a flat "refuse the engine's documented names" would have
      // got wrong.
      for (const body of [
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        'POSTGRES_INITDB_ARGS=--data-checksums',
        'PGDATA=/var/lib/postgresql/data/pgdata',
        'PGTZ=UTC',
      ]) {
        expect(databaseEnvSchema('postgres').safeParse(body).success).toBe(
          true,
        );
      }
      // And the one assignment of an engine name that exists in this tree
      // (`test/databases/mongo.e2e-spec.ts`): `MONGO_INITDB_DATABASE` is
      // derived from no column and now emitted by nothing.
      expect(
        databaseEnvSchema('mongo').safeParse('MONGO_INITDB_DATABASE=analytics')
          .success,
      ).toBe(true);
    });

    it('is case-sensitive on purpose, because the deploy is', () => {
      // dotenv does not fold case, so `cg_redis_requirepass` is a different
      // key from the holder and collides with nothing.
      expect(reservedEnvKeys('cg_redis_requirepass=x')).toEqual([]);
      expect(reservedEnvKeys('CG_REDIS_REQUIREPASS=x')).toEqual([
        'CG_REDIS_REQUIREPASS',
      ]);
      expect(engineOwnedEnvKeys('postgres_password=x', 'postgres')).toEqual([]);
    });
  });

  describe('all six engines, not one', () => {
    const engines = [
      ['postgres', savePostgresEnvironmentSchema],
      ['mysql', saveMysqlEnvironmentSchema],
      ['mariadb', saveMariadbEnvironmentSchema],
      ['mongo', saveMongoEnvironmentSchema],
      ['redis', saveRedisEnvironmentSchema],
      ['libsql', saveLibsqlEnvironmentSchema],
    ] as const;

    it('has an engine here for every one that exists', () => {
      // The rule is a statement about all six (it was filed as one on
      // purpose), so a seventh engine's DTO must not be able to skip it
      // silently.
      expect(engines).toHaveLength(6);
      expect(Object.keys(ENGINE_ENV_OWNERS).sort()).toEqual(
        engines.map(([engine]) => engine).sort(),
      );
    });

    it.each(engines)(
      '%s refuses a reserved key on its save-environment body',
      (_engine, schema) => {
        const refused = schema.safeParse({
          env: `${RESERVED_ENV_PREFIX}REDIS_REQUIREPASS=hunter2`,
        });
        expect(refused.success).toBe(false);
        expect(refused.error?.issues[0]?.path).toEqual(['env']);
      },
    );

    it.each(engines)(
      '%s refuses its own derived names on its save-environment body',
      (engine, schema) => {
        for (const key of Object.keys(ENGINE_ENV_OWNERS[engine])) {
          const refused = schema.safeParse({ env: `${key}=whatever` });
          expect(refused.success).toBe(false);
          expect(refused.error?.issues[0]?.path).toEqual(['env']);
        }
      },
    );

    it.each(engines)('%s still takes an ordinary body', (_engine, schema) => {
      expect(schema.safeParse({ env: 'LOG_LEVEL=debug' }).success).toBe(true);
      expect(schema.safeParse({ env: null }).success).toBe(true);
    });
  });

  /**
   * The guard that keeps the two rules covering everything the platform emits.
   *
   * `defaultEnv` is `protected` and the base's `deployInternal` derives the
   * override set from the row in hand, so the deploy cannot drift. The *write*
   * reads {@link ENGINE_ENV_OWNERS}, which is a hand-written list, and a list
   * is what goes stale — a seventh variable added to an engine's `defaultEnv`
   * would be overridden at the deploy while the write went on accepting it,
   * which is the silent half of the defect back again for one name.
   *
   * So: every key every engine emits, over both of its branches, must be
   * covered by one of the two rules — `ENGINE_ENV_OWNERS` for a name derived
   * from a column, the `CG_` prefix for a holder. Nothing may be covered by
   * neither.
   */
  describe('every emitted key is covered by one of the two rules', () => {
    /** `defaultEnv` as the base calls it. `protected` keeps it off the class's
     * public surface, and this reaches it the way the base does rather than
     * re-deriving what the engine emits, which would only pin the test against
     * itself. The DI arguments are stored and never touched by `defaultEnv`. */
    type EnvProbe = { defaultEnv(row: unknown): Record<string, string> };
    const probe = (service: object): EnvProbe => service as unknown as EnvProbe;
    const di = () =>
      [null, null, null, null, null] as unknown as [
        never,
        never,
        never,
        never,
        never,
      ];

    const credentials = {
      databaseName: 'shop',
      databaseUser: 'shop_user',
      databasePassword: 'sup3rS3cret',
      databaseRootPassword: 'r00tS3cret',
    };

    /** Each engine with every branch of its `defaultEnv`, so a key only one
     * branch emits is still checked. */
    const branches: [DatabaseEngine, EnvProbe, Record<string, unknown>[]][] = [
      ['postgres', probe(new PostgresService(...di())), [{ ...credentials }]],
      [
        'mysql',
        probe(new MysqlService(...di())),
        [{ ...credentials }, { ...credentials, databaseUser: 'root' }],
      ],
      ['mariadb', probe(new MariadbService(...di())), [{ ...credentials }]],
      [
        'mongo',
        probe(new MongoService(...di())),
        [
          { ...credentials, replicaSets: false },
          { ...credentials, replicaSets: true },
        ],
      ],
      ['redis', probe(new RedisService(...di())), [{ ...credentials }]],
      [
        'libsql',
        probe(new LibsqlService(...di())),
        [
          { ...credentials, sqldNode: 'primary' },
          {
            ...credentials,
            sqldNode: 'replica',
            sqldPrimaryUrl: 'http://primary-db:5001',
          },
        ],
      ],
    ];

    it('covers all six engines', () => {
      expect(branches.map(([engine]) => engine).sort()).toEqual(
        Object.keys(ENGINE_ENV_OWNERS).sort(),
      );
    });

    it.each(branches)('%s', (engine, service, rows) => {
      const owners = ENGINE_ENV_OWNERS[engine];
      const emitted = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(service.defaultEnv(row))) {
          emitted.add(key);
        }
      }
      expect(emitted.size).toBeGreaterThan(0);

      for (const key of emitted) {
        expect(key in owners || key.startsWith(RESERVED_ENV_PREFIX)).toBe(true);
      }
      // And nothing in the map that the engine has stopped emitting, so a
      // removed variable (one was removed) does not leave a name
      // refused at the write for no reason.
      for (const key of Object.keys(owners)) {
        expect(emitted.has(key)).toBe(true);
      }
    });

    it('returns values verbatim, whatever the column holds', () => {
      // Item 2's fix stated at the emitter rather than at the deploy: the
      // charset-free columns reach `ContainerSpec.Env` unaltered.
      const hostile = 'shop"\nPOSTGRES_HOST_AUTH_METHOD=trust\n"x';
      const [, postgres] = branches[0];
      expect(
        postgres.defaultEnv({ ...credentials, databaseName: hostile }),
      ).toEqual({
        POSTGRES_DB: hostile,
        POSTGRES_USER: 'shop_user',
        POSTGRES_PASSWORD: 'sup3rS3cret',
      });
    });

    it('emits no MONGO_INITDB_DATABASE on either branch', () => {
      // It was emitted only when `replicaSets` was true — the one branch where
      // `containerCommand` replaces the image entrypoint, so the only thing
      // that reads it never runs. The replica-set script names `admin` itself.
      const [, mongo, rows] = branches[3];
      for (const row of rows) {
        expect(mongo.defaultEnv(row)).not.toHaveProperty(
          'MONGO_INITDB_DATABASE',
        );
      }
    });
  });
});
