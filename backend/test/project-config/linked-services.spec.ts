import { ConflictException } from '@nestjs/common';

import { application } from '../../src/applications/application.schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { refuseWhileLinked } from '../../src/project-config/outputs/linked-services';

const SOURCE = { environmentId: 'env-1', configName: 'pg-1' };

const LINK = { DATABASE_URL: { source: 'pg-1', output: 'url' } };

/**
 * A `db` whose `select … from(application) … where` answers `rows`, and
 * every other Service table nothing: the link filter is Postgres's, so
 * each row here is one the query already found linking to pg-1.
 */
function dbAnswering(rows: object[]): DrizzleDB {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(table === application ? rows : []),
      }),
    }),
  } as unknown as DrizzleDB;
}

describe('refuseWhileLinked', () => {
  it('refuses while a Service links to the source, naming the link', async () => {
    const db = dbAnswering([
      { configName: 'web', links: LINK, cloudDelete: null },
    ]);

    const refused = refuseWhileLinked(db, SOURCE);

    await expect(refused).rejects.toBeInstanceOf(ConflictException);
    await expect(refused).rejects.toMatchObject({
      response: {
        code: 'SERVICE_IS_LINKED',
        message: expect.stringContaining(
          'web.env.DATABASE_URL → pg-1.url',
        ) as string,
      },
    });
  });

  // A plan removing pg-1 and web together asks for web's Delete,
  // whose Cloud run has not ended when pg-1's step runs.
  it.each(['deleting', 'incomplete'])(
    'does not count a link held by a Service whose cloud Delete is %s (ADR-0038)',
    async (status) => {
      const db = dbAnswering([
        {
          configName: 'web',
          links: LINK,
          cloudDelete: { status, deploymentId: 'dep-1' },
        },
      ]);

      await expect(refuseWhileLinked(db, SOURCE)).resolves.toBeUndefined();
    },
  );

  it('still refuses for a linking Service with no Delete beside one being deleted', async () => {
    const db = dbAnswering([
      {
        configName: 'web',
        links: LINK,
        cloudDelete: { status: 'deleting', deploymentId: 'dep-1' },
      },
      { configName: 'worker', links: LINK, cloudDelete: null },
    ]);

    const refused = refuseWhileLinked(db, SOURCE);

    await expect(refused).rejects.toMatchObject({
      response: {
        message: expect.not.stringContaining('web.env') as string,
      },
    });
    await expect(refused).rejects.toMatchObject({
      response: {
        message: expect.stringContaining(
          'worker.env.DATABASE_URL → pg-1.url',
        ) as string,
      },
    });
  });
});
