import {
  createLibsqlSchema,
  updateLibsqlSchema,
} from '../../src/databases/libsql/dto/libsql.dto';
import { libsql } from '../../src/databases/libsql/libsql.schema';
import {
  createMariadbSchema,
  updateMariadbSchema,
} from '../../src/databases/mariadb/dto/mariadb.dto';
import { mariadb } from '../../src/databases/mariadb/mariadb.schema';
import {
  createMongoSchema,
  updateMongoSchema,
} from '../../src/databases/mongo/dto/mongo.dto';
import { mongo } from '../../src/databases/mongo/mongo.schema';
import {
  createMysqlSchema,
  updateMysqlSchema,
} from '../../src/databases/mysql/dto/mysql.dto';
import { mysql } from '../../src/databases/mysql/mysql.schema';
import {
  createPostgresSchema,
  updatePostgresSchema,
} from '../../src/databases/postgres/dto/postgres.dto';
import { postgres } from '../../src/databases/postgres/postgres.schema';
import {
  createRedisSchema,
  updateRedisSchema,
} from '../../src/databases/redis/dto/redis.dto';
import { redis } from '../../src/databases/redis/redis.schema';
import { SEPARATOR_PAYLOAD, SHELL_PAYLOAD } from '../utils/shell-safety';

/**
 * H-53 — H-47's finding, one module over and six times over.
 *
 * `application.dockerImage` got `imageReferenceSchema` in d70bbfc; the six
 * managed engines' copies of the same column did not, and they are the same
 * shape: `z.string().optional()` on create, `z.string().min(1)` on update,
 * `PATCH /{engine}/:id` reachable by a plain member, and the stored word handed
 * to `docker pull` on the database's Server.
 *
 * **Not a command injection, and these are not injection tests.** That sink is
 * `execOnServer(remoteExec, serverId, ['docker', 'pull', found.dockerImage])`
 * — argv, joined once behind a test — and it holds; `postgres.e2e-spec.ts`
 * asserts the emitted word is inert and keeps doing so against a row written
 * past this schema. What was missing is the charset that
 * `builders/build-strategy.ts` says belongs *behind* that argv, and which had
 * now been the wrong bet three times.
 *
 * The grammar itself — the 29 real-world references, the length rule, the
 * anchoring, the ReDoS measurement — is pinned once in
 * `test/registries/registry.dto.spec.ts`, where the schema lives. What is
 * pinned here is that all six engines carry it, and that carrying it did not
 * cost any engine a value it actually runs.
 */

/** Every engine's update schema, beside the column the rule has to keep. */
const engines = [
  ['postgres', updatePostgresSchema, createPostgresSchema, postgres],
  ['mysql', updateMysqlSchema, createMysqlSchema, mysql],
  ['mariadb', updateMariadbSchema, createMariadbSchema, mariadb],
  ['mongo', updateMongoSchema, createMongoSchema, mongo],
  ['redis', updateRedisSchema, createRedisSchema, redis],
  ['libsql', updateLibsqlSchema, createLibsqlSchema, libsql],
] as const;

/** What `POST /{engine}` needs beside the image for the rest of the body to
 * parse — the image is the only field under test, so every other required one
 * is filled with a value no rule here reads. */
const createBody = {
  name: 'Main DB',
  databaseName: 'shop',
  databaseUser: 'shop_user',
  environmentId: 'env-1',
};

describe('databaseImageSchema on all six engines', () => {
  describe.each(engines)('%s', (_engine, update, create, table) => {
    const parse = (dockerImage: string) => update.safeParse({ dockerImage });

    it('refuses the word H-34 got a 200 for', () => {
      // Verbatim from f6e82c9, retargeted at this engine's image. On the
      // application it reached `docker tag` bare; here it reaches argv, where
      // it is inert — and is now also not storable.
      expect(parse(`${_engine}:18${SEPARATOR_PAYLOAD}`).success).toBe(false);
    });

    it('refuses a command substitution in the tag', () => {
      expect(parse(`${_engine}:${SHELL_PAYLOAD}`).success).toBe(false);
    });

    it('refuses a path traversal in the image name', () => {
      expect(parse('../../etc/passwd').success).toBe(false);
    });

    it('accepts the image its own column defaults to', () => {
      // Read off the drizzle column rather than retyped, so a rule that
      // narrowed past an engine's own default fails here rather than on a
      // deploy: every one of these six rows exists in the wild with this exact
      // value, written by the column and never revalidated.
      const columnDefault = table.dockerImage.default as string;
      expect(typeof columnDefault).toBe('string');
      expect(parse(columnDefault).success).toBe(true);
    });

    it('accepts the column default on create too', () => {
      expect(
        create.safeParse({
          ...createBody,
          dockerImage: table.dockerImage.default as string,
        }).success,
      ).toBe(true);
    });

    it('leaves an omitted image alone, so the column default still applies', () => {
      expect(create.safeParse(createBody).success).toBe(true);
      expect(update.safeParse({ name: 'Main DB' }).success).toBe(true);
    });
  });

  /**
   * The tags the console actually offers, plus the shapes an operator reaches
   * for that the console never suggests — a pinned patch version, an official
   * variant repository, a private mirror on a port, and a digest.
   *
   * This is the half of the rule that matters more than the refusals: a
   * grammar that turned away `pgvector/pgvector:pg17` or
   * `registry.internal:5000/mirror/postgres:15` would be deleted the first time
   * an operator hit it, which is the failure `registry.dto.ts` names.
   */
  const realImages = [
    'postgres:18',
    'postgres:17',
    'postgres:16',
    'postgres:15',
    'postgres:16.4',
    'postgres:18-alpine',
    'pgvector/pgvector:pg17',
    'mysql:8',
    'mysql:8.4',
    'mysql:5.7',
    'mariadb:11',
    'mariadb:10.11',
    'mongo:8',
    'mongo:7',
    'mongo:6',
    'redis:8',
    'redis:7',
    'redis:7.4-alpine',
    'redis/redis-stack-server:latest',
    'ghcr.io/tursodatabase/libsql-server:v0.24.32',
    'registry.internal:5000/mirror/postgres:15',
    'docker.io/library/postgres:18',
    `postgres@sha256:${'a'.repeat(64)}`,
  ];

  it.each(realImages)('every engine still accepts %s', (image) => {
    for (const [, update] of engines) {
      expect(update.safeParse({ dockerImage: image }).success).toBe(true);
    }
  });

  /**
   * `''` was reachable on create — `z.string().optional()` took it, and
   * `createDatabase` spreads the body into the insert, so the empty string
   * overwrote a NOT NULL column's default and `docker pull ''` was the deploy.
   * Update already refused it through `.min(1)`; the two agree now.
   *
   * Deliberately **not** `application.dockerImage`'s `allowUnset`: there `''`
   * is an existing spelling of "no image" that `builtImageName` reads, and the
   * API has taken it since the column existed. Here the column is NOT NULL with
   * a default, no reader treats `''` as anything, and the console omits the key
   * rather than sending one (`toCreateInput`: `...(image !== "" ? … : {})`).
   */
  it('refuses the empty string on create as well as on update', () => {
    for (const [, update, create] of engines) {
      expect(create.safeParse({ ...createBody, dockerImage: '' }).success).toBe(
        false,
      );
      expect(update.safeParse({ dockerImage: '' }).success).toBe(false);
    }
  });

  /** `getPostgresMountPath` reads `postgres:(\d+)` off the stored word to pick
   * between PG 18's PGDATA and the classic one. Both arms of that decision have
   * to stay storable, or the rule would have silently pinned every new database
   * to one mount path. */
  it('keeps both images the Postgres mount path branches on', () => {
    expect(
      updatePostgresSchema.safeParse({ dockerImage: 'postgres:18' }).success,
    ).toBe(true);
    expect(
      updatePostgresSchema.safeParse({ dockerImage: 'postgres:16' }).success,
    ).toBe(true);
  });
});
