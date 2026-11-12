import { databaseIdentifierSchema } from '../../src/databases/common/database.constants';
import { createMariadbSchema } from '../../src/databases/mariadb/dto/mariadb.dto';
import { createMysqlSchema } from '../../src/databases/mysql/dto/mysql.dto';
import { createPostgresSchema } from '../../src/databases/postgres/dto/postgres.dto';

/**
 * A managed database's name and user were only `min(1)`, so `bad name!`
 * was created and every connection string had to quote or encode it. A create
 * now takes an unquoted identifier within the engine's own limit.
 */
describe('databaseIdentifierSchema', () => {
  const engines = ['postgres', 'mysql', 'mariadb'] as const;
  const fields = ['databaseName', 'databaseUser'] as const;

  it.each(engines.flatMap((e) => fields.map((f) => [e, f] as const)))(
    '%s %s takes an identifier and refuses spaces, punctuation and a leading digit',
    (engine, field) => {
      const schema = databaseIdentifierSchema(engine, field);
      for (const ok of ['app', 'shop_user', '_x', 'App2']) {
        expect(schema.safeParse(ok).success).toBe(true);
      }
      for (const bad of ['', 'bad name!', 'my-db', '2fast', 'a.b', 'é']) {
        expect(schema.safeParse(bad).success).toBe(false);
      }
    },
  );

  it.each([
    ['postgres', 'databaseName', 63],
    ['postgres', 'databaseUser', 63],
    ['mysql', 'databaseName', 64],
    ['mysql', 'databaseUser', 32],
    ['mariadb', 'databaseName', 64],
    ['mariadb', 'databaseUser', 80],
  ] as const)('%s %s stops at %i characters', (engine, field, max) => {
    const schema = databaseIdentifierSchema(engine, field);
    expect(schema.safeParse('a'.repeat(max)).success).toBe(true);
    expect(schema.safeParse('a'.repeat(max + 1)).success).toBe(false);
  });

  it('refuses a Postgres user PostgreSQL reserves, and only a user', () => {
    expect(
      databaseIdentifierSchema('postgres', 'databaseUser').safeParse('pg_app')
        .success,
    ).toBe(false);
    expect(
      databaseIdentifierSchema('postgres', 'databaseName').safeParse('pg_app')
        .success,
    ).toBe(true);
    expect(
      databaseIdentifierSchema('mysql', 'databaseUser').safeParse('pg_app')
        .success,
    ).toBe(true);
  });

  it.each([
    ['postgres', createPostgresSchema],
    ['mysql', createMysqlSchema],
    ['mariadb', createMariadbSchema],
  ] as const)('is what a %s create checks', (_, schema) => {
    const base = { name: 'db', environmentId: 'env-1', databaseUser: 'app' };
    expect(schema.safeParse({ ...base, databaseName: 'app' }).success).toBe(
      true,
    );
    const refused = schema.safeParse({ ...base, databaseName: 'bad name!' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['databaseName']);
  });
});
