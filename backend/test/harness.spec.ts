import { user } from '../src/db/schema';
import { createTestApp, TestAppContext } from './utils/test-app';

jest.setTimeout(120_000);

describe('Test harness (Testcontainers smoke test)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  it('a row inserted through the app db connection is readable back', async () => {
    const [created] = await ctx.db
      .insert(user)
      .values({
        firstName: 'Ada Lovelace',
        email: 'ada@example.com',
        updatedAt: new Date(),
      })
      .returning();

    expect(created).toMatchObject({
      firstName: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(created.id).toEqual(expect.any(String));

    const all = await ctx.db.select().from(user);
    expect(all).toHaveLength(1);
    expect(all[0].email).toBe('ada@example.com');
  });

  it('starts from a clean database in every test (order-independent)', async () => {
    const before = await ctx.db.select().from(user);
    expect(before).toHaveLength(0);

    const [created] = await ctx.db
      .insert(user)
      .values({
        firstName: 'Grace Hopper',
        email: 'grace@example.com',
        updatedAt: new Date(),
      })
      .returning();

    const all = await ctx.db.select().from(user);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(created.id);
  });
});
