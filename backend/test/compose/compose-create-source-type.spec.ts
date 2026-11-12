import { sourceTypeOnCreate } from '../../src/compose/compose-source-type';
import {
  createComposeSchema,
  updateComposeSchema,
} from '../../src/compose/dto/compose.dto';

const FILE = 'services:\n  web:\n    image: nginx:1\n';

const parse = (body: Record<string, unknown>) =>
  createComposeSchema.parse({ name: 'Shop', environmentId: 'env_1', ...body });

/**
 * Which source a Compose stack is created with (#1338).
 *
 * `POST /compose` accepted a `composeFile` but no `sourceType`, so every
 * created row took the column's default, `github` — a pasted file was stored
 * on a stack the deploy then refused with "no source is chosen", and never
 * used. The create takes no repository fields, so a non-empty file with no
 * `sourceType` can only mean `raw`; refusing instead would have broken every
 * caller that already creates with a file.
 */
describe('sourceTypeOnCreate', () => {
  it('is raw when a non-empty compose file is given and no sourceType', () => {
    expect(sourceTypeOnCreate(parse({ composeFile: FILE }))).toBe('raw');
  });

  it('leaves the column default when the file is missing, empty or only whitespace', () => {
    // `undefined` is what lets the insert take the column's `github`, which
    // the console's "From a repository" create relies on.
    expect(sourceTypeOnCreate(parse({}))).toBeUndefined();
    expect(sourceTypeOnCreate(parse({ composeFile: '' }))).toBeUndefined();
    expect(
      sourceTypeOnCreate(parse({ composeFile: '  \n\t' })),
    ).toBeUndefined();
  });

  it('is the sourceType given, whatever the file', () => {
    expect(
      sourceTypeOnCreate(parse({ composeFile: FILE, sourceType: 'gitea' })),
    ).toBe('gitea');
    expect(sourceTypeOnCreate(parse({ sourceType: 'raw' }))).toBe('raw');
    expect(sourceTypeOnCreate(parse({ sourceType: 'github' }))).toBe('github');
  });
});

describe('createComposeSchema', () => {
  it('accepts on create exactly the sourceType values an update accepts', () => {
    const updateValues = updateComposeSchema.shape.sourceType.unwrap().options;
    for (const sourceType of updateValues) {
      expect(parse({ sourceType }).sourceType).toBe(sourceType);
    }
    // The shared enum's two Application-only values stay refused here too.
    for (const sourceType of ['docker', 'drop']) {
      expect(
        createComposeSchema.safeParse({
          name: 'Shop',
          environmentId: 'env_1',
          sourceType,
        }).success,
      ).toBe(false);
    }
  });
});
