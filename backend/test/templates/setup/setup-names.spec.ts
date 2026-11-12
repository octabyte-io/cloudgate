import {
  partConfigName,
  pickSetupName,
} from '../../../src/templates/setup/setup-names';
import { renamedEntries } from '../../../src/templates/setup/setup-entries';
import {
  parseProjectConfig,
  withServiceEntries,
} from '../../../src/project-config';

describe('partConfigName', () => {
  it('puts the setup name in front of the part, and does not double a part named like the template', () => {
    expect(partConfigName('ghost', 'ghost', 'app')).toBe('ghost-app');
    expect(partConfigName('ghost', 'ghost', 'ghost')).toBe('ghost');
    expect(partConfigName('blog', 'ghost', 'ghost')).toBe('blog');
  });
});

describe('pickSetupName', () => {
  it('keeps the wanted name when nothing it makes is taken', () => {
    const picked = pickSetupName('ghost', 'ghost', ['app', 'db'], new Set());

    expect(picked).toEqual({
      ok: true,
      setupName: 'ghost',
      names: new Map([
        ['app', 'ghost-app'],
        ['db', 'ghost-db'],
      ]),
    });
  });

  it('adds -2 to the setup name as a whole when one part clashes', () => {
    const picked = pickSetupName(
      'ghost',
      'ghost',
      ['app', 'db'],
      new Set(['ghost-db']),
    );

    expect(picked.ok && [...picked.names.values()]).toEqual([
      'ghost-2-app',
      'ghost-2-db',
    ]);
  });

  it('goes on to -3 when -2 clashes too', () => {
    const picked = pickSetupName(
      'ghost',
      'ghost',
      ['app'],
      new Set(['ghost-app', 'ghost-2-app']),
    );

    expect(picked.ok && picked.setupName).toBe('ghost-3');
  });

  it('refuses a setup name that is not a Config name', () => {
    expect(pickSetupName('My Blog', 'ghost', ['app'], new Set()).ok).toBe(
      false,
    );
  });
});

describe('renamedEntries', () => {
  it('renames each entry and every link to another, keeping the rest as written', () => {
    const template = `version: 1
services:
  app:
    kind: web
    port: 2368
    # the app's own variables
    env:
      - ADMIN_EMAIL
      - DATABASE_URL: db.url
  db:
    kind: postgres
`;
    const stored = 'version: 1\nservices: {}\n';

    const text = withServiceEntries(
      stored,
      renamedEntries(
        template,
        new Map([
          ['app', 'blog-app'],
          ['db', 'blog-db'],
        ]),
      ),
    );

    const parsed = parseProjectConfig(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.config.services)).toEqual([
      'blog-app',
      'blog-db',
    ]);
    expect(parsed.config.services['blog-app']).toMatchObject({
      links: { DATABASE_URL: { source: 'blog-db', output: 'url' } },
    });
    expect(text).toContain("# the app's own variables");
  });
});
