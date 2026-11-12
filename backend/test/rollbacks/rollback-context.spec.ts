import { getTableColumns } from 'drizzle-orm';
import { application } from '../../src/applications/application.schema';
import { APPLICATION_CREDENTIAL_REFS } from '../../src/applications/applications.service';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { ServiceMount } from '../../src/docker/docker.types';
import type { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { DeployableApplication } from '../../src/deployment-engine/deployment-engine.types';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { ModuleRef } from '@nestjs/core';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { RollbacksService } from '../../src/rollbacks/rollbacks.service';
import { makeApp } from '../deployment-engine/application.fixture';

/**
 * `EXCLUDED_FROM_CONTEXT` dropped the credential
 * **relations** — `github`, `registry`, `customGitSSHKey` and the four beside
 * them — and kept the **id columns** they are loaded through, so
 * `rollback.full_context` persisted all seven as plaintext JSON and
 * `RollbacksService.rollback` merged the snapshot *over* the live row, letting
 * the snapshot's ids win. An earlier fix had just finished proving those ids were the
 * live exposure on the Application's write path and could not reach this file.
 *
 * What is pinned here is the snapshot's **content**, at the one write that
 * produces it. The merge in `rollback` needs no test of its own once the
 * column carries no id: `{ ...fresh, ...fullContext }` cannot override a key
 * the snapshot does not hold. That was the alternative rejected — asserting
 * the merge direction would have meant `jest.mock`ing
 * `mechanizeDockerContainer`, an internal collaborator §1.7 keeps out of
 * doubles, and it would still not observe anything: `mechanize` reads the
 * relations off `fresh`, which is exactly why the defect was latent rather than live.
 *
 * Both lists below are read off an **independent source** rather than
 * restated (§1.7): the credential ids off `APPLICATION_CREDENTIAL_REFS`, which
 * `application-credential-refs.spec.ts` separately pins to
 * `updateApplicationSchema`'s own shape, and the encrypted columns off the
 * `application` table itself. So an eighth credential arm or an eighth
 * encrypted column is covered the day it lands, without an edit here — which
 * is the failure mode it was: `previewEnv` and `previewBuildArgs` arrived in
 * a later change, three weeks after the list was written, and were simply absent from
 * both sides of it. Not hypothetical either: `refreshToken` became the seventh
 * encrypted column and this file started asserting its exclusion with
 * no edit here at all.
 */

/**
 * Columns `application` stores encrypted at rest (ADR 0006). `encryptedText`
 * is a drizzle `customType`, so the table reports these as `PgCustomColumn`
 * and nothing else on `application` is one — `nanoidPk` and `isoTimestamp` are
 * plain `text`. Enumerated rather than listed so a later encrypted column
 * joins the set on its own.
 */
const ENCRYPTED_COLUMNS = Object.entries(getTableColumns(application))
  .filter(([, column]) => column.columnType === 'PgCustomColumn')
  .map(([key]) => key);

interface Written {
  values?: { fullContext?: Partial<DeployableApplication> };
}

/**
 * `capture`'s two writes: the insert that mints the version, and the update
 * that lands the image tag and the snapshot. Written against those rather than
 * through Postgres, on `application-credential-refs.spec.ts`' terms.
 */
const makeDb = (written: Written) =>
  ({
    transaction: <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        insert: () => ({
          values: () => ({
            returning: () =>
              Promise.resolve([{ rollbackId: 'rb-1', version: 7 }]),
          }),
        }),
        update: () => ({
          set: (values: Written['values']) => ({
            where: () => {
              written.values = values;
              return Promise.resolve(undefined);
            },
          }),
        }),
      }),
  }) as unknown as DrizzleDB;

function makeService() {
  const written: Written = {};
  const rollbacks = new RollbacksService(
    makeDb(written),
    {} as PermissionService,
    {} as ApplicationsService,
    {} as RemoteDockerFactory,
    {} as RemoteExecService,
    {} as ModuleRef,
  );
  return { rollbacks, written };
}

/** The snapshot `capture` persisted for `app`. */
async function captureContext(
  overrides: Partial<DeployableApplication>,
): Promise<Partial<DeployableApplication>> {
  const { rollbacks, written } = makeService();
  await rollbacks.capture('dep-1', makeApp(overrides));
  const context = written.values?.fullContext;
  // Not a tautology guard for its own sake: a `capture` that stopped writing
  // `fullContext` at all would satisfy every `not.toHaveProperty` below.
  expect(context).toBeDefined();
  return context as Partial<DeployableApplication>;
}

describe('RollbacksService.capture', () => {
  it('enumerates the credential ids and the encrypted columns it is asserting about', () => {
    // The two enumerations are the whole method of this file, so they are
    // checked before they are trusted — an empty list would make every case
    // below pass without reading anything.
    expect(APPLICATION_CREDENTIAL_REFS).toEqual(
      expect.arrayContaining([
        'githubId',
        'gitlabId',
        'giteaId',
        'bitbucketId',
        'customGitSSHKeyId',
        'registryId',
        'buildRegistryId',
      ]),
    );
    expect(ENCRYPTED_COLUMNS).toEqual(
      expect.arrayContaining([
        'env',
        'buildArgs',
        'buildSecrets',
        'password',
        'previewEnv',
        'previewBuildArgs',
      ]),
    );
  });

  it.each(APPLICATION_CREDENTIAL_REFS.map((ref) => [ref] as const))(
    'persists no %s in the snapshot, so a rollback cannot override the live row with it',
    async (ref) => {
      const context = await captureContext({ [ref]: 'their-credential-row' });

      expect(context).not.toHaveProperty(ref);
    },
  );

  it.each(ENCRYPTED_COLUMNS.map((column) => [column] as const))(
    'persists no %s in the snapshot, which is a json column and not encrypted',
    async (column) => {
      const context = await captureContext({
        [column]: 'API_KEY=hunter2',
      });

      expect(context).not.toHaveProperty(column);
    },
  );

  it('persists a file mount without the content it holds', async () => {
    // `DeployableApplication.mounts` is typed `ServiceMount[]`, which declares
    // five fields and no `content` — and `ApplicationsService.findDeployable`
    // used to fill it from `select().from(mount)`, i.e. whole rows, `content`
    // being an `encryptedText` column carrying whatever the operator put in
    // the file. Structural typing accepts the wider row silently, so the type
    // is exactly what will not tell you this leaked.
    //
    // An earlier fix gave that query a column list, so the write path no longer produces
    // such a row. This case stands, and is why the cast below is still
    // honest: `capture` takes a `DeployableApplication` from whoever calls it,
    // and `toRollbackContext` runs over `full_context` rows read back **out**
    // of the column, which were written before either issue. See
    // `toSnapshotMount`'s docblock.
    const mount = {
      mountId: 'mount-1',
      type: 'file',
      mountPath: '/app/config.yml',
      filePath: 'config.yml',
      volumeName: null,
      hostPath: null,
      content: 'stripe_secret: sk_live_1',
    } as unknown as ServiceMount;

    const context = await captureContext({ mounts: [mount] });

    const [snapshotted] = context.mounts as ServiceMount[];
    expect(snapshotted).not.toHaveProperty('content');
    // …and still every field mechanize reads off a mount, so the snapshot
    // converges onto the same spec it did before.
    expect(snapshotted).toEqual({
      type: 'file',
      mountPath: '/app/config.yml',
      filePath: 'config.yml',
      volumeName: null,
      hostPath: null,
    });
  });

  it('persists the config columns a rollback redeploys with', async () => {
    // The negative assertions above are only correct if the snapshot is still
    // a snapshot: an exclusion list that grew to cover everything would pass
    // all of them.
    const context = await captureContext({ replicas: 4, command: 'serve' });

    expect(context).toMatchObject({
      appName: 'shop-api-x1',
      replicas: 4,
      command: 'serve',
      sourceType: 'github',
    });
  });
});
