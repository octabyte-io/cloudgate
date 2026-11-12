import type { z } from 'zod';
import {
  createApplicationSchema,
  updateApplicationSchema,
} from '../../src/applications/dto/application.dto';
import {
  SERVICE_NAME_MAX_LENGTH,
  serviceNameSchema,
} from '../../src/common/service-name';
import {
  createComposeSchema,
  updateComposeSchema,
} from '../../src/compose/dto/compose.dto';
import {
  createLibsqlSchema,
  updateLibsqlSchema,
} from '../../src/databases/libsql/dto/libsql.dto';
import {
  createMariadbSchema,
  updateMariadbSchema,
} from '../../src/databases/mariadb/dto/mariadb.dto';
import {
  createMongoSchema,
  updateMongoSchema,
} from '../../src/databases/mongo/dto/mongo.dto';
import {
  createMysqlSchema,
  updateMysqlSchema,
} from '../../src/databases/mysql/dto/mysql.dto';
import {
  createPostgresSchema,
  updatePostgresSchema,
} from '../../src/databases/postgres/dto/postgres.dto';
import {
  createRedisSchema,
  updateRedisSchema,
} from '../../src/databases/redis/dto/redis.dto';

/**
 * A Service's `name` had no maximum, and a 300-character Application
 * pushed the Services table's other columns ~2,000px off-screen and its Delete
 * dialog's buttons out of view. Every create and update DTO of a Service now
 * holds `name` to SERVICE_NAME_MAX_LENGTH.
 *
 * Each schema is parsed with only `name` and the error read for the `name`
 * path, so the other required fields of a create body do not matter here.
 */
const SCHEMAS: Record<string, z.ZodType> = {
  createApplicationSchema,
  updateApplicationSchema,
  createComposeSchema,
  updateComposeSchema,
  createLibsqlSchema,
  updateLibsqlSchema,
  createMariadbSchema,
  updateMariadbSchema,
  createMongoSchema,
  updateMongoSchema,
  createMysqlSchema,
  updateMysqlSchema,
  createPostgresSchema,
  updatePostgresSchema,
  createRedisSchema,
  updateRedisSchema,
};

function nameIssues(schema: z.ZodType, name: string) {
  const result = schema.safeParse({ name });
  return result.success
    ? []
    : result.error.issues.filter((issue) => issue.path[0] === 'name');
}

describe('serviceNameSchema', () => {
  it('is capped at 100, longer than the 63 a Swarm service name (appName) may be', () => {
    expect(SERVICE_NAME_MAX_LENGTH).toBe(100);
    expect(serviceNameSchema.safeParse('a'.repeat(100)).success).toBe(true);
    expect(serviceNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
    expect(serviceNameSchema.safeParse('').success).toBe(false);
  });

  it.each(Object.entries(SCHEMAS))(
    '%s refuses a name one character too long and takes one at the cap',
    (_, schema) => {
      const tooLong = nameIssues(
        schema,
        'a'.repeat(SERVICE_NAME_MAX_LENGTH + 1),
      );
      expect(tooLong.map((issue) => issue.message)).toEqual([
        `name may be at most ${SERVICE_NAME_MAX_LENGTH} characters`,
      ]);
      expect(nameIssues(schema, 'a'.repeat(SERVICE_NAME_MAX_LENGTH))).toEqual(
        [],
      );
    },
  );
});
