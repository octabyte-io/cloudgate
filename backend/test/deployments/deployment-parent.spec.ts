import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import type { DeploymentParent } from '../../src/deployment-engine/ports/deployment-recorder';
import { parentColumns } from '../../src/deployment-engine/ports/deployment-recorder';
import {
  NON_PARENT_REFERENCE_COLUMNS,
  QUALIFIER_COLUMNS,
  deploymentForeignKeys,
  deploymentForeignKeysWithTargets,
  parentColumnsOnTheTable,
} from './deployment-parent-columns';

/**
 * The seam the parent constraint named and could not close. `CreateDeploymentInput`
 * declared `applicationId?` and `composeId?` as *independent* optionals and
 * `DeploymentsService.create` coalesced both through to the insert; exactly one
 * was ever non-null only because its two callers branched before calling.
 * Since the constraint a third caller passing both is a 500 naming
 * `deployment_at_most_one_parent` — an improvement over a two-parented row, and
 * still the wrong surface. The input is now a discriminated union with one arm
 * per parent kind, so the state never reaches Postgres because no value of the
 * type carries two parents.
 *
 * **A compile-time guarantee has to be asserted by a compiler**, which is what
 * the first half of this file does: each shape the union must refuse is
 * type-checked as source against the real port file and the diagnostic is the
 * assertion. Writing "this does not compile" in a comment is the failure mode
 * — it is true when written and unfalsifiable afterwards, and the constraint's own
 * docblock records the same lesson one layer down (a rule nothing enforces is
 * a rule that has already drifted).
 *
 * The fixture is compiled **in memory, beside the port**, deliberately: a
 * fixture file on disk would carry deliberate type errors into
 * `npx tsc --noEmit`, which has no `exclude` and so type-checks `test/` too.
 * The program is two files — the port imports nothing at all — so it costs a
 * quarter of a second rather than a pass over the Nest graph.
 *
 * The second half asserts the runtime half of the same property: that
 * `parentColumns` names exactly one column per arm, and that the arms cover
 * every parent column the *table* has. The union covering all five parents (not
 * only the two the old input named) is the part the constraint's analysis makes
 * load-bearing: `deployment` has five nullable parents and a deliberately
 * parentless deployment, which is why its constraint counts
 * `num_nonnulls(…) <= 1` instead of stating an XOR.
 */

const portFile = join(
  __dirname,
  '..',
  '..',
  'src',
  'deployment-engine',
  'ports',
  'deployment-recorder.ts',
);

/** Beside the port so `./deployment-recorder` resolves; never written out. */
const fixtureFile = join(dirname(portFile), '__deployment-parent-fixture__.ts');

/** The backend's own compiler options, so a shape that type-checks here is one
 * that type-checks in the build rather than under a stricter or looser
 * dialect of its own. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = join(__dirname, '..', '..', 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (path) =>
    readFileSync(path, 'utf8'),
  );
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
  );
  return { ...parsed.options, noEmit: true, incremental: false };
}

const options = compilerOptions();

/** Every type error the fixture reports, as `TS<code>: <message>`. */
function typeErrors(fixture: string): string[] {
  const disk = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...disk,
    getSourceFile: (name, language, onError, shouldCreate) =>
      name === fixtureFile
        ? ts.createSourceFile(name, fixture, language, true)
        : disk.getSourceFile(name, language, onError, shouldCreate),
    fileExists: (name) => name === fixtureFile || disk.fileExists(name),
    readFile: (name) => (name === fixtureFile ? fixture : disk.readFile(name)),
  };

  const program = ts.createProgram([fixtureFile], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === fixtureFile)
    .map(
      (diagnostic) =>
        `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          ' ',
        )}`,
    );
}

const IMPORTS = `import type {
  CreateDeploymentInput,
  DeploymentParent,
} from './deployment-recorder';
`;

/** A fixture whose every statement is expected to type-check. */
function accepts(body: string): string[] {
  return typeErrors(`${IMPORTS}${body}\n`);
}

describe('CreateDeploymentInput, as a shape two parents cannot take', () => {
  it('reads the port it is asserting against', () => {
    // The half that says the compiler is really looking at the union. Every
    // assertion below is satisfied by a fixture that failed to resolve its
    // import — `Cannot find module` is an error like any other — so this
    // asserts the *positive* direction first: the six arms compile clean.
    expect(
      accepts(`
export const application: DeploymentParent = {
  kind: 'application',
  applicationId: 'app-1',
};
export const compose: DeploymentParent = { kind: 'compose', composeId: 'cmp-1' };
export const schedule: DeploymentParent = {
  kind: 'schedule',
  scheduleId: 'sch-1',
};
export const volumeBackup: DeploymentParent = {
  kind: 'volumeBackup',
  volumeBackupId: 'vb-1',
};
export const backup: DeploymentParent = { kind: 'backup', backupId: 'bk-1' };
export const parentless: DeploymentParent = { kind: 'none' };
export const build: CreateDeploymentInput = {
  kind: 'application',
  applicationId: 'app-1',
  title: 'Manual deployment',
  description: '',
};
export const stack: CreateDeploymentInput = {
  kind: 'compose',
  composeId: 'cmp-1',
  title: 'Manual deployment',
  description: '',
};
`),
    ).toEqual([]);
  });

  it('refuses a record that names two parents', () => {
    expect(
      accepts(`
export const both: CreateDeploymentInput = {
  kind: 'application',
  applicationId: 'app-1',
  composeId: 'cmp-1',
  title: 'Manual deployment',
  description: '',
};
`),
    ).toEqual([
      expect.stringContaining(
        "Types of property 'composeId' are incompatible.",
      ),
    ]);
  });

  it('refuses two parents assembled one statement earlier, not only as a literal', () => {
    // The reason each arm pins its *sibling* columns to `never` rather than
    // only naming its own. TypeScript's excess-property check fires on an
    // object literal written at the call and not on a variable assigned into
    // the parameter, so a tag alone would leave the two-parent value
    // representable for any caller that built it a line above.
    const errors = accepts(`
const assembled = {
  kind: 'application' as const,
  applicationId: 'app-1',
  composeId: 'cmp-1',
  title: 'Manual deployment',
  description: '',
};
export const both: CreateDeploymentInput = assembled;
`);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "Types of property 'composeId' are incompatible.",
    );
    expect(errors[0]).toContain("Type 'string' is not assignable to type");
  });

  it('refuses an id that is not the one its kind names', () => {
    expect(
      accepts(`
export const mismatched: CreateDeploymentInput = {
  kind: 'compose',
  applicationId: 'app-1',
  title: 'Manual deployment',
  description: '',
};
`),
    ).toEqual([
      expect.stringContaining(
        "Types of property 'applicationId' are incompatible.",
      ),
    ]);
  });

  it('refuses a build record with no parent at all', () => {
    // The parentless arm is a real shape of the *row* — `ownerOf` answers 404
    // for it and `run-history.e2e-spec.ts` inserts one by hand — and is not a
    // shape the build port can be asked for: `create` has no service to name a
    // log directory after or claim a pending record within.
    expect(
      accepts(`
export const parentless: CreateDeploymentInput = {
  kind: 'none',
  title: 'Manual deployment',
  description: '',
};
`),
    ).toEqual([
      expect.stringContaining(
        `Type '"none"' is not assignable to type '"application" | "compose"'`,
      ),
    ]);
  });

  it('keeps the three run-record arms off the build port', () => {
    // They are `deployment` rows too — `BackupRunRecorderService.start` writes
    // them — so the union carries them, and the port that records *builds*
    // does not accept them.
    const errors = accepts(`
export const backupRun: CreateDeploymentInput = {
  kind: 'backup',
  backupId: 'bk-1',
  title: 'Backup',
  description: '',
};
export const volumeBackupRun: CreateDeploymentInput = {
  kind: 'volumeBackup',
  volumeBackupId: 'vb-1',
  title: 'Volume backup',
  description: '',
};
export const scheduleRun: CreateDeploymentInput = {
  kind: 'schedule',
  scheduleId: 'sch-1',
  title: 'Schedule',
  description: '',
};
`);

    expect(
      errors.filter((error) =>
        error.includes(`is not assignable to type '"application" | "compose"'`),
      ),
    ).toHaveLength(3);
  });
});

describe('parentColumns, as the one place a parent becomes columns', () => {
  const arms: readonly DeploymentParent[] = [
    { kind: 'application', applicationId: 'app-1' },
    { kind: 'compose', composeId: 'cmp-1' },
    { kind: 'schedule', scheduleId: 'sch-1' },
    { kind: 'volumeBackup', volumeBackupId: 'vb-1' },
    { kind: 'backup', backupId: 'bk-1' },
    { kind: 'environmentNetwork', environmentNetworkId: 'net-1' },
    { kind: 'postgres', postgresId: 'pg-1' },
    { kind: 'mysql', mysqlId: 'my-1' },
    { kind: 'bucket', bucketId: 'bkt-1' },
    { kind: 'redis', redisId: 'redis-1' },
    { kind: 'none' },
  ];

  it('writes exactly the one column its arm names', () => {
    expect(arms.map((parent) => parentColumns(parent))).toEqual([
      { applicationId: 'app-1' },
      { composeId: 'cmp-1' },
      { scheduleId: 'sch-1' },
      { volumeBackupId: 'vb-1' },
      { backupId: 'bk-1' },
      { environmentNetworkId: 'net-1' },
      { postgresId: 'pg-1' },
      { mysqlId: 'my-1' },
      { bucketId: 'bkt-1' },
      { redisId: 'redis-1' },
      {},
    ]);
  });

  it('never writes a second parent column, whichever arm it is handed', () => {
    expect(
      arms.map((parent) => Object.keys(parentColumns(parent)).length),
    ).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it('covers every parent column the table has', () => {
    // The constraint's finding restated as an assertion. `deployment` has **five**
    // nullable parents, not the two the old input named, and the sweep in
    // `parent-id-writes.spec.ts` reports only two of them because `backup`,
    // `volume_backup` and `schedule` are not service tables. Read off drizzle
    // metadata rather than listed here, so a sixth parent column added to the
    // table reds this instead of quietly having no arm.
    const parents = parentColumnsOnTheTable();

    const written = arms.flatMap((parent) =>
      Object.keys(parentColumns(parent)),
    );

    expect([...new Set(parents)].sort()).toEqual([...written].sort());
  });

  it('reads the preview link as a qualifier of an application row, not a parent', () => {
    // `preview_deployment_id` is a foreign key on the table and is set
    // aside from the census above by name. This is what keeps that claim
    // honest: each qualifier is really a key on the table, the column it
    // qualifies is an arm's column, and the qualifier itself is no arm's.
    const keys = deploymentForeignKeys();
    const written = arms.flatMap((parent) =>
      Object.keys(parentColumns(parent)),
    );

    for (const [qualifier, parent] of Object.entries(QUALIFIER_COLUMNS)) {
      expect(keys).toContainEqual([qualifier]);
      expect(keys).toContainEqual([qualifier, parent]);
      expect(written).toContain(parent);
      expect(written).not.toContain(qualifier);
    }
  });

  it('reads the held-by-plan link as a reference to a plan, not a parent', () => {
    // `held_by_plan_id` is a foreign key on the table and is set aside
    // from the census above by name. This keeps that claim honest: each one
    // is a one-column key on the table, it references the table named beside
    // it rather than a parent's, and no arm writes it.
    const keys = deploymentForeignKeysWithTargets();
    const written = arms.flatMap((parent) =>
      Object.keys(parentColumns(parent)),
    );

    for (const [column, table] of Object.entries(
      NON_PARENT_REFERENCE_COLUMNS,
    )) {
      expect(keys).toContainEqual({ columns: [column], references: table });
      expect(written).not.toContain(column);
    }
  });
});
