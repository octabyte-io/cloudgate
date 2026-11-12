import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { encryptedText, isoTimestamp, nanoidPk } from '../../src/db/columns';
import { startTestDb, TestDb } from '../utils/test-db';

const secrets = pgTable('throwaway_secrets', {
  id: nanoidPk('id'),
  token: encryptedText('token').notNull(),
  createdAt: isoTimestamp('created_at'),
});

describe('db column helpers', () => {
  let testDb: TestDb;
  let pool: Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_SECRET = 'test-encryption-secret';
    testDb = await startTestDb();
    pool = new Pool({ connectionString: testDb.connectionString });
    db = drizzle(pool);
    await db.execute(sql`
      create table throwaway_secrets (
        id text primary key,
        token text not null,
        created_at text not null
      )
    `);
  });

  afterAll(async () => {
    await pool.end();
    await testDb.stop();
  });

  it('round-trips an encryptedText value through the table', async () => {
    const [row] = await db
      .insert(secrets)
      .values({ token: 'super-secret-api-key' })
      .returning();

    const [selected] = await db.select().from(secrets);
    expect(selected.token).toBe('super-secret-api-key');
    expect(row.token).toBe('super-secret-api-key');
  });

  it('stores ciphertext at rest, not the plaintext', async () => {
    const raw = await pool.query<{ token: string }>(
      'select token from throwaway_secrets',
    );
    expect(raw.rows.length).toBeGreaterThan(0);
    for (const { token } of raw.rows) {
      expect(token).not.toBe('super-secret-api-key');
      expect(token.startsWith('enc:v1:')).toBe(true);
    }
  });

  it('generates a nanoid primary key and an ISO timestamp by default', async () => {
    const [selected] = await db.select().from(secrets);
    expect(selected.id).toMatch(/^[a-zA-Z0-9_-]{21}$/);
    expect(new Date(selected.createdAt).toISOString()).toBe(selected.createdAt);
  });
});
