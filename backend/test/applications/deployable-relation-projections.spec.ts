import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { ApplicationsService } from '../../src/applications/applications.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { aiModelFacet, mount, port } from '../../src/db/schema';
import type {
  DeployableAiModel,
  DeployableApplication,
} from '../../src/deployment-engine/deployment-engine.types';
import type { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { RegistriesService } from '../../src/registries/registries.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';

/**
 * `findDeployable` filled `mounts` from
 * `select().from(mount)` — **whole rows** — against a field declared
 * `ServiceMount[]`, five fields and no `content`, and `mount.content` is an
 * `encryptedText` column holding the body of a file mount. The decrypted body
 * therefore reached `rollback.full_context` and, through
 * `RollbacksService.findAllByApplicationId`, every reader of the Application —
 * *with the type still saying it could not be there*.
 *
 * **Nothing in the type system was ever going to say so, and that is the
 * finding worth pinning rather than the one column.** TypeScript's
 * excess-property check fires on object *literals*; a value flowing out of a
 * query builder is not fresh, and neither is an array of them. Annotating
 * `findDeployable` with `Promise<DeployableApplication>` does not help — an
 * `interface Wide` array assigned to a `Narrow[]` field compiles clean, and
 * only the inline literal errors. So the seam needs either a projection or a
 * test, and an earlier fix shipped the third option — a projection at one *consumer* —
 * which is why the same widening was still live at every other consumer.
 *
 * **The property, over the relations rather than over `content`.** For every
 * relation `findDeployable` loads with a `db.select()` of its own, the columns
 * the query names must be exactly the keys the field on
 * {@link DeployableApplication} declares. That fails the day a query hands back
 * a column the field does not declare, which is the class of defect here, and
 * it fails for a relation nobody has thought about yet: the third such relation
 * added to `findDeployable` reds `enumerates every relation it queries
 * separately` until it is listed below.
 *
 * **Both sides come from an independent source (§1.7).** The declared keys are
 * a `Record<keyof …, true>` off the field's own declared element type, so the
 * compiler refuses this file if the type gains or loses a field — the same
 * trick that makes `EXCLUDED_FROM_CONTEXT` load-bearing. The selected
 * keys are read off the projection the service actually hands `db.select()`,
 * and a bare `select()` is read as what it means: every column drizzle knows
 * the table has, from `getTableColumns`.
 *
 * **What this file deliberately does not assert** is that Postgres honours a
 * column list, which is not a claim about this repo's code and cannot be
 * observed without a database. `applications.e2e-spec.ts` makes that half
 * against a real file mount with a real encrypted body, and it is the half that
 * would have caught the original end to end.
 *
 * The relations loaded through `db.query.application.findFirst({ with: … })`
 * are out of scope here **and cannot hold this defect**, because every one of
 * their declared types — `Environment`, `Project`, `Github`, `Gitlab`,
 * `Gitea`, `Bitbucket`, `Registry`, `SshKey` — is `typeof table.$inferSelect`,
 * generated from the table, so it cannot be narrower than the row. `registry`
 * and `customGitSSHKey` do carry `encryptedText` columns and are meant to:
 * `findDeployable`'s docblock exists to say the build needs them decrypted.
 * `ServiceMount` is the one hand-written interface in the set, because it is
 * the deploy engine's *input* shape rather than a row shape, and being
 * hand-written is exactly what let it fall behind the table.
 */

/** Declared keys of `T`, restated nowhere: a missing or extra key is a
 * compile error, not a failing assertion. */
const declaredKeys = <T>(keys: Record<keyof T, true>): string[] =>
  Object.keys(keys).sort();

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type DeclaredMount = NonNullable<DeployableApplication['mounts']>[number];
type DeclaredPort = NonNullable<DeployableApplication['ports']>[number];

/**
 * `DeployableApplication.ports` declares `Port`, which is
 * `typeof port.$inferSelect`. Asserted at the type level so the table's own
 * columns may stand in for the field's declared keys below; the day `ports` is
 * narrowed the way `mounts` was, this stops being `true` and stops compiling.
 */
const PORTS_DECLARE_THE_WHOLE_ROW: Exact<
  DeclaredPort,
  typeof port.$inferSelect
> = true;

/** Columns stored encrypted at rest (ADR 0006). `encryptedText` is a drizzle
 * `customType`, so the table reports these as `PgCustomColumn`; enumerated
 * rather than listed so a later encrypted column joins the set on its own. */
const encryptedColumns = (table: PgTable): string[] =>
  Object.entries(getTableColumns(table))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => key);

interface Relation {
  field: 'mounts' | 'ports' | 'aiModel';
  table: PgTable;
  declared: string[];
}

/** The relations `findDeployable` queries with a `select()` of its own, rather
 * than through the relational tree — the two Phase 32/33 additions kept out of
 * `applicationRelations` to avoid schema cycles. */
const SEPARATELY_QUERIED: Relation[] = [
  {
    field: 'mounts',
    table: mount,
    declared: declaredKeys<DeclaredMount>({
      type: true,
      mountPath: true,
      volumeName: true,
      hostPath: true,
      filePath: true,
    }),
  },
  {
    field: 'ports',
    table: port,
    declared: Object.keys(getTableColumns(port)).sort(),
  },
  // The AI model's facet, whose row holds the upstream secret.
  {
    field: 'aiModel',
    table: aiModelFacet,
    declared: declaredKeys<DeployableAiModel>({
      runtime: true,
      model: true,
      imageTag: true,
    }),
  },
];

interface Selected {
  table: string;
  columns: string[];
}

/**
 * `findDeployable` against its two reads: the relational tree, answered with a
 * bare row, and one `select().from().where()` per separately-queried relation,
 * whose projection is what is captured. Written this way rather than through
 * Postgres on `application-credential-refs.spec.ts`' terms — the question is
 * which columns the service asks for, and that is decided before any row
 * exists.
 */
const makeDb = (selected: Selected[]) =>
  ({
    query: {
      application: {
        findFirst: () => Promise.resolve({ applicationId: 'app-1' }),
      },
    },
    select: (fields?: Record<string, unknown>) => ({
      from: (table: PgTable) => {
        selected.push({
          table: getTableName(table),
          columns: (fields
            ? Object.keys(fields)
            : // A bare `select()` means every column drizzle knows about.
              Object.keys(getTableColumns(table))
          ).sort(),
        });
        return { where: () => Promise.resolve([]) };
      },
    }),
  }) as unknown as DrizzleDB;

async function selectionsOfFindDeployable(): Promise<Selected[]> {
  const selected: Selected[] = [];
  const applications = new ApplicationsService(
    makeDb(selected),
    {} as PermissionService,
    {} as RemoteExecService,
    {} as TraefikWriterService,
    {} as SshKeysService,
    {} as RegistriesService,
    {} as GithubService,
    {} as GitlabService,
    {} as GiteaService,
    {} as BitbucketService,
    {} as TraefikAppConfigService,
    // The Stop hook; nothing here Stops a Service.
    {} as never,
    // The platform host URL; nothing here reads an AI model.
    {} as never,
    // A cloud Service's lifecycle; nothing here Stops a Service.
    {} as never,
    // The instance mode; nothing here creates a Service.
    {} as never,
  );
  await applications.findDeployable('app-1');
  return selected;
}

describe('ApplicationsService.findDeployable, on the columns its relations name', () => {
  it('declares the whole row for ports, so the table stands in for the field', () => {
    expect(PORTS_DECLARE_THE_WHOLE_ROW).toBe(true);
  });

  it.each(SEPARATELY_QUERIED.map((relation) => [relation.field, relation]))(
    'names for %s exactly the columns DeployableApplication declares',
    async (_field, relation) => {
      const selected = await selectionsOfFindDeployable();
      const forRelation = selected.find(
        (call) => call.table === getTableName(relation.table),
      );

      expect(forRelation?.columns).toEqual(relation.declared);
    },
  );

  it.each(
    SEPARATELY_QUERIED.flatMap((relation) =>
      encryptedColumns(relation.table)
        .filter((column) => !relation.declared.includes(column))
        .map((column) => [`${relation.field}[].${column}`, relation, column]),
    ),
  )(
    'never names %s, an encrypted column the field does not declare',
    async (_label, relation, column) => {
      // Independent of the assertion above rather than implied by it: adding
      // `content` to `ServiceMount` would make that one agree again, and a
      // decrypted file-mount body would be back in `rollback.full_context`
      // with the type's blessing. This one says the seam feeding a
      // persisted, HTTP-served snapshot names no ciphertext column, whatever
      // the type comes to declare.
      const selected = await selectionsOfFindDeployable();
      const forRelation = selected.find(
        (call) => call.table === getTableName((relation as Relation).table),
      );

      expect(forRelation?.columns).not.toContain(column);
    },
  );

  it('enumerates every relation it queries separately', async () => {
    // The half that makes the property survive a third relation: a new
    // `select()` in `findDeployable` reds this until it is listed above with
    // the keys its field declares, rather than being covered by nothing.
    const selected = await selectionsOfFindDeployable();

    expect(selected.map((call) => call.table).sort()).toEqual(
      SEPARATELY_QUERIED.map((relation) => getTableName(relation.table)).sort(),
    );
  });
});
