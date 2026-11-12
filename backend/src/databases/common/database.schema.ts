import { pgEnum } from 'drizzle-orm/pg-core';

// The shared "which database engine" discriminator that backups (Phase 34) and
// rebuilds point at. Declared with the first engine so later engines and
// features reuse it.
export const databaseTypeEnum = pgEnum('database_type', [
  'postgres',
  'mariadb',
  'mysql',
  'mongo',
  'web-server',
  'libsql',
]);

export type DatabaseType = (typeof databaseTypeEnum.enumValues)[number];
