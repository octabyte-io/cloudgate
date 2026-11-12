import { promotedSetup } from '../../../src/templates/setup/setup-promotion';
import type { RecordedSetup } from '../../../src/templates/setup/setup-promotion';

/**
 * Which Setup record a setup in one more Environment reuses (#1377): the
 * same template under the same setup name, none of whose names is there.
 */
const RECORD: RecordedSetup = {
  setupRecordId: 'sr-1',
  templateId: 'ghost',
  setupName: 'blog',
  configNames: ['blog-app', 'blog-db'],
};

const WANTED = { templateId: 'ghost', setupName: 'blog', parts: ['app', 'db'] };

describe('promotedSetup', () => {
  it('reuses the record’s Config names where none of them is', () => {
    const promoted = promotedSetup([RECORD], WANTED, new Set(['api']));

    expect(promoted).toEqual({
      setupRecordId: 'sr-1',
      setupName: 'blog',
      names: new Map([
        ['app', 'blog-app'],
        ['db', 'blog-db'],
      ]),
    });
  });

  it('reuses none where one of its names is already in the Environment', () => {
    expect(promotedSetup([RECORD], WANTED, new Set(['blog-db']))).toBeNull();
  });

  it('reuses none for another setup name or another template', () => {
    expect(
      promotedSetup([RECORD], { ...WANTED, setupName: 'docs' }, new Set()),
    ).toBeNull();
    expect(
      promotedSetup([RECORD], { ...WANTED, templateId: 'wiki' }, new Set()),
    ).toBeNull();
  });

  it('reuses none when the template’s parts no longer make exactly its names', () => {
    expect(
      promotedSetup(
        [RECORD],
        { ...WANTED, parts: ['app', 'db', 'cache'] },
        new Set(),
      ),
    ).toBeNull();
  });

  it('keeps a part named like the template undoubled', () => {
    const promoted = promotedSetup(
      [{ ...RECORD, configNames: ['blog', 'blog-db'] }],
      { ...WANTED, parts: ['ghost', 'db'] },
      new Set(),
    );

    expect(promoted?.names.get('ghost')).toBe('blog');
  });
});
