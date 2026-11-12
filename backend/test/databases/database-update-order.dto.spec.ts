import { updateApplicationSchema } from '../../src/applications/dto/application.dto';
import { DATABASE_ORDER_MESSAGE } from '../../src/native/docker-locks';
import { updateLibsqlSchema } from '../../src/databases/libsql/dto/libsql.dto';
import { updateMariadbSchema } from '../../src/databases/mariadb/dto/mariadb.dto';
import { updateMongoSchema } from '../../src/databases/mongo/dto/mongo.dto';
import { updateMysqlSchema } from '../../src/databases/mysql/dto/mysql.dto';
import { updatePostgresSchema } from '../../src/databases/postgres/dto/postgres.dto';
import { updateRedisSchema } from '../../src/databases/redis/dto/redis.dto';

/**
 * Every engine's update schema refuses `start-first` in either block,
 * with the one sentence, and takes stop-first or a block with no order the
 * deploy then fills. `database-update-order.e2e-spec.ts` holds the PATCH
 * routes to the same; this holds the six schemas, without a database.
 */
const engines = [
  ['postgres', updatePostgresSchema],
  ['mysql', updateMysqlSchema],
  ['mariadb', updateMariadbSchema],
  ['mongo', updateMongoSchema],
  ['redis', updateRedisSchema],
  ['libsql', updateLibsqlSchema],
] as const;

const columns = ['updateConfigSwarm', 'rollbackConfigSwarm'] as const;

describe.each(engines)('%s update schema', (_engine, schema) => {
  it.each(columns)('refuses start-first in %s', (column) => {
    const result = schema.safeParse({
      [column]: { Parallelism: 1, Order: 'start-first' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: [column, 'Order'],
        message: DATABASE_ORDER_MESSAGE,
      }),
    ]);
  });

  it.each(columns)('takes stop-first and a cleared %s', (column) => {
    expect(
      schema.safeParse({ [column]: { Parallelism: 1, Order: 'stop-first' } })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ [column]: null }).success).toBe(true);
  });
});

describe('updateApplicationSchema', () => {
  it('leaves an Application free to update and roll back start-first', () => {
    const block = { Parallelism: 1, Order: 'start-first' };
    expect(
      updateApplicationSchema.safeParse({
        updateConfigSwarm: block,
        rollbackConfigSwarm: block,
      }).success,
    ).toBe(true);
  });
});
