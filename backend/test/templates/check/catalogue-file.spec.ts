import { checkCatalogue, encodeCatalogue } from '../../../src/templates/check';
import { readCatalogueFile } from '../../../src/templates/check/catalogue-file';
import { catalogueZip, zipOf } from '../zip.fixture';
import type { ZipEntryFixture } from '../zip.fixture';

import { catalogue, ghost, INSTANCE, png } from './catalogue.fixture';
import type { Folder } from './catalogue.fixture';

/**
 * The catalogue zip's package check (ADR-0072): everything that refuses the
 * whole zip before any one template is checked, and what `encodeCatalogue`
 * writes for the check to read.
 */

const KB = 1024;
const MB = 1024 * KB;

/** Why the zip of `bytes` is refused as a whole. */
function refusal(bytes: Uint8Array): string {
  const read = readCatalogueFile(bytes);
  if (read.ok) throw new Error('read, not refused');
  return read.reason;
}

/** Ghost's folder with one more file at `path`, as a zip. */
function ghostWith(path: string, content: string | { base64: string }) {
  return catalogue(ghost({ files: { [path]: content } }));
}

/**
 * Ghost shipping the config files given, each listed in its
 * `template.yaml`, in place of its own.
 */
function ghostShipping(
  configFiles: Record<string, string | { base64: string }>,
  templateYaml?: string,
): Folder {
  const listing = Object.keys(configFiles)
    .map((path) => `  - { path: "${path.slice('files/'.length)}" }\n`)
    .join('');
  return ghost({
    templateYaml:
      templateYaml ??
      `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
compose: app
inputs:
  DB_PASSWORD: { generate: password }
  ADMIN_EMAIL:
    ask: { label: Admin email, format: email }
files:
${listing || '  []\n'}`,
    files: { 'files/config.production.json': null, ...configFiles },
  });
}

/** A catalogue whose index is `index`, written as given, and Ghost's folder. */
function withIndex(index: string | Uint8Array): Buffer {
  const folder = ghost();
  return zipOf([
    { path: 'catalogue.json', bytes: index },
    ...Object.entries(folder.files).map(([path, content]): ZipEntryFixture => ({
      path: `templates/ghost/${path}`,
      bytes:
        typeof content === 'string'
          ? content
          : Buffer.from(content.base64, 'base64'),
    })),
  ]);
}

describe('readCatalogueFile', () => {
  it('reads every template folder, in index order, with its revision', () => {
    const read = readCatalogueFile(
      catalogueZip([
        { ...ghost({ id: 'ghost' }), revision: 'aaa' },
        { ...ghost({ id: 'blog' }), revision: 'bbb' },
      ]),
    );

    expect(
      read.ok && read.entries.map(({ id, revision }) => [id, revision]),
    ).toEqual([
      ['ghost', 'aaa'],
      ['blog', 'bbb'],
    ]);
    expect(read.ok && read.entries[0].files).toEqual(ghost().files);
  });

  it('reads folder entries beside the files, as zip tools write them', () => {
    const folder = ghost();
    const read = readCatalogueFile(
      zipOf([
        {
          path: 'catalogue.json',
          bytes: '{"format":2,"templates":[{"id":"ghost","revision":"r"}]}',
        },
        { path: 'templates/', bytes: '' },
        { path: 'templates/ghost/', bytes: '' },
        { path: 'templates/ghost/files/', bytes: '' },
        ...Object.entries(folder.files).map(([path, content]) => ({
          path: `templates/ghost/${path}`,
          bytes: content as string,
        })),
      ]),
    );

    expect(read.ok && read.entries[0].files).toEqual(folder.files);
  });

  describe('the download', () => {
    it('refuses one over 10 MB before reading it', () => {
      expect(refusal(Buffer.alloc(10 * MB + 1))).toBe(
        'The catalogue is 10 MB; a catalogue is at most 10 MB',
      );
      expect(refusal(Buffer.alloc(12 * MB))).toBe(
        'The catalogue is 12 MB; a catalogue is at most 10 MB',
      );
    });

    it('refuses a catalogue.json from before ADR-0072, naming catalogue.zip', () => {
      const legacy = Buffer.from(
        `  \n${JSON.stringify({ format: 1, templates: [] })}`,
      );

      expect(refusal(legacy)).toBe(
        'The catalogue is a catalogue.json, the format before ADR-0072; this Cloudgate reads a catalogue.zip',
      );
    });

    it('refuses bytes that are not a zip, naming the zip reader’s reason', () => {
      expect(refusal(Buffer.from('<html>Not found</html>'))).toBe(
        'The catalogue is not a zip file',
      );
    });
  });

  describe('the index', () => {
    it('is required', () => {
      const zip = zipOf(
        Object.entries(ghost().files).map(([path, content]) => ({
          path: `templates/ghost/${path}`,
          bytes: content as string,
        })),
      );

      expect(refusal(zip)).toBe('The catalogue has no catalogue.json');
    });

    it('is JSON', () => {
      expect(refusal(withIndex('format: 2'))).toBe(
        'The catalogue has a catalogue.json that is not JSON',
      );
      expect(refusal(withIndex(Buffer.from([0x7b, 0xff, 0x7d])))).toBe(
        'The catalogue has a catalogue.json that is not JSON',
      );
    });

    it('is format 2', () => {
      expect(
        refusal(
          withIndex('{"format":1,"templates":[{"id":"ghost","revision":"r"}]}'),
        ),
      ).toBe('The catalogue is format 1; this Cloudgate reads format 2');
      expect(
        refusal(
          withIndex(
            '{"format":"2","templates":[{"id":"ghost","revision":"r"}]}',
          ),
        ),
      ).toBe('The catalogue is format "2"; this Cloudgate reads format 2');
    });

    it('holds ids and revisions and nothing else', () => {
      expect(
        refusal(
          withIndex(
            '{"format":2,"templates":[{"id":"ghost","revision":"r","files":{}}]}',
          ),
        ),
      ).toMatch(
        /^The catalogue has a catalogue\.json that is not a valid index at templates\.0: /,
      );
      expect(
        refusal(
          withIndex('{"format":2,"templates":[{"id":"ghost","revision":""}]}'),
        ),
      ).toBe(
        'The catalogue has a catalogue.json that is not a valid index at templates.0.revision: must not be empty',
      );
    });

    it('names each template once', () => {
      expect(
        refusal(
          withIndex(
            JSON.stringify({
              format: 2,
              templates: [
                { id: 'ghost', revision: 'r' },
                { id: 'ghost', revision: 's' },
              ],
            }),
          ),
        ),
      ).toBe('The catalogue names the template ghost twice');
    });

    it('names no template without a folder', () => {
      expect(
        refusal(
          withIndex(
            JSON.stringify({
              format: 2,
              templates: [
                { id: 'ghost', revision: 'r' },
                { id: 'blog', revision: 'r' },
              ],
            }),
          ),
        ),
      ).toBe('The catalogue names the template blog, which has no folder');
    });

    it('names every folder under templates/', () => {
      expect(refusal(withIndex('{"format":2,"templates":[]}'))).toBe(
        'The catalogue holds templates/ghost/, which catalogue.json does not name',
      );
    });

    it('names even an empty folder', () => {
      const zip = zipOf([
        { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
        { path: 'templates/', bytes: '' },
        { path: 'templates/ghost/', bytes: '' },
      ]);

      expect(refusal(zip)).toBe(
        'The catalogue holds templates/ghost/, which catalogue.json does not name',
      );
    });
  });

  describe('paths a template does not hold', () => {
    it('refuses a file at the root beside the index', () => {
      expect(
        refusal(
          zipOf([
            { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
            { path: 'README.md', bytes: '# Templates' },
          ]),
        ),
      ).toBe(
        'The catalogue holds README.md, which is not a file a catalogue holds; it holds catalogue.json and the folders under templates/',
      );
    });

    it('refuses a file under templates/ outside any template folder', () => {
      expect(
        refusal(
          zipOf([
            { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
            { path: 'templates/README.md', bytes: '# Templates' },
          ]),
        ),
      ).toBe(
        "The catalogue holds templates/README.md, which is not in a template's folder",
      );
    });

    it("refuses the website's index.md and screenshots/", () => {
      expect(refusal(ghostWith('index.md', '# Ghost'))).toBe(
        'The catalogue holds templates/ghost/index.md, a website file; a catalogue leaves the website out',
      );
      expect(refusal(ghostWith('screenshots/home.png', png(4, 4)))).toBe(
        'The catalogue holds templates/ghost/screenshots/home.png, a website file; a catalogue leaves the website out',
      );
      expect(
        refusal(
          zipOf([
            { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
            { path: 'templates/ghost/screenshots/', bytes: '' },
          ]),
        ),
      ).toBe(
        'The catalogue holds templates/ghost/screenshots/, a website folder; a catalogue leaves the website out',
      );
    });

    it('refuses a second compose file, by any of its usual names', () => {
      for (const name of [
        'docker-compose.yaml',
        'compose.yml',
        'compose.yaml',
      ]) {
        expect(refusal(ghostWith(name, 'services: {}\n'))).toBe(
          `The catalogue holds templates/ghost/${name}, a second compose file; a template has at most one, docker-compose.yml`,
        );
      }
    });

    it('refuses any other file or folder in a template folder', () => {
      expect(refusal(ghostWith('README.md', '# Ghost'))).toBe(
        'The catalogue holds templates/ghost/README.md, which is not a file a template holds; config files go under files/',
      );
      expect(refusal(ghostWith('nginx.conf', 'events {}'))).toBe(
        'The catalogue holds templates/ghost/nginx.conf, which is not a file a template holds; config files go under files/',
      );
      expect(
        refusal(
          zipOf([
            { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
            { path: 'templates/ghost/config/', bytes: '' },
          ]),
        ),
      ).toBe(
        'The catalogue holds templates/ghost/config/, which is not a folder a template holds; config files go under files/',
      );
    });

    it('refuses a hidden file or folder anywhere', () => {
      expect(refusal(ghostWith('.env', 'SECRET=1'))).toMatch(
        /^The catalogue holds templates\/ghost\/\.env, which is not a file a template holds/,
      );
      expect(refusal(ghostWith('files/.env', 'SECRET=1'))).toBe(
        'The catalogue holds templates/ghost/files/.env, a hidden file; a template ships none',
      );
      expect(refusal(ghostWith('files/.nginx.conf', 'events {}'))).toBe(
        'The catalogue holds templates/ghost/files/.nginx.conf, a hidden file; a template ships none',
      );
      expect(refusal(ghostWith('files/.git/config.ini', '[core]'))).toBe(
        'The catalogue holds templates/ghost/files/.git/config.ini, a hidden file; a template ships none',
      );
      expect(
        refusal(
          zipOf([
            { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
            { path: 'templates/ghost/files/.git/', bytes: '' },
          ]),
        ),
      ).toBe(
        'The catalogue holds templates/ghost/files/.git/, a hidden file; a template ships none',
      );
      expect(
        refusal(
          zipOf([
            { path: 'catalogue.json', bytes: '{"format":2,"templates":[]}' },
            { path: '.DS_Store', bytes: 'x' },
          ]),
        ),
      ).toMatch(/^The catalogue holds \.DS_Store, which is not a file/);
    });
  });

  describe('config files', () => {
    const NOT_CONFIG =
      'which is not a kind of config file a template ships; a config file ends in .conf, .cfg, .ini, .yaml, .yml, .json, .toml, .xml, .properties, .sql, .txt, .html, .css, .tmpl, or is named Caddyfile';

    it('refuses a script, a program, an archive, an image or a name with no ending', () => {
      for (const name of [
        'entrypoint.sh',
        'setup.py',
        'init.js',
        'app.env',
        'backup.zip',
        'logo.png',
        'nginx',
        'nginx.conf.sh',
        'caddyfile',
      ]) {
        expect(
          refusal(catalogue(ghostShipping({ [`files/${name}`]: 'x' }))),
        ).toBe(
          `The catalogue holds templates/ghost/files/${name}, ${NOT_CONFIG}`,
        );
      }
    });

    it('takes every config ending ADR-0072 names, and Caddyfile, at any depth', () => {
      // Written out from the ADR, not read from the module's own list.
      const names = [
        'a.conf',
        'a.cfg',
        'a.ini',
        'a.yaml',
        'a.yml',
        'a.json',
        'a.toml',
        'a.xml',
        'a.properties',
        'a.sql',
        'a.txt',
        'a.html',
        'a.css',
        'a.tmpl',
        'Caddyfile',
        'nginx/conf.d/site.conf',
        'caddy/Caddyfile',
      ];
      const shipped = Object.fromEntries(
        names.map((name) => [`files/${name}`, `# ${name}\n`]),
      );
      const result = checkCatalogue(
        catalogue(ghostShipping(shipped)),
        INSTANCE,
      );

      expect(result.ok && result.hidden).toEqual([]);
      expect(
        result.ok && Object.keys(result.offered[0].configFiles).sort(),
      ).toEqual([...names].sort());
    });

    it('refuses one its template.yaml does not list', () => {
      const folder = ghostShipping({ 'files/a.conf': 'x' });
      folder.files['files/b.conf'] = 'y';

      expect(refusal(catalogue(folder))).toBe(
        'The catalogue holds templates/ghost/files/b.conf, which its template.yaml does not list in files',
      );
    });

    it('refuses any in a template whose template.yaml cannot be read, or lists nothing', () => {
      const shipped = { 'files/a.conf': 'x' };

      for (const templateYaml of ['name: [Ghost\n', 'files: nope\n', '- a\n']) {
        expect(refusal(catalogue(ghostShipping(shipped, templateYaml)))).toBe(
          'The catalogue holds templates/ghost/files/a.conf, which its template.yaml does not list in files',
        );
      }
      // With no config file, the same template.yaml hides that template alone.
      const result = checkCatalogue(
        catalogue(ghostShipping({}, 'name: [Ghost\n'), ghost({ id: 'blog' })),
        INSTANCE,
      );
      expect(
        result.ok && result.offered.map((template) => template.id),
      ).toEqual(['blog']);
      expect(result.ok && result.hidden[0].reason).toMatch(
        /^template\.yaml is not valid YAML: /,
      );
    });

    it('refuses one at a path the files rule refuses, though listed', () => {
      expect(
        refusal(catalogue(ghostShipping({ 'files/a`b`.conf': 'x' }))),
      ).toBe(
        'The catalogue holds templates/ghost/files/a`b`.conf, whose path a`b`.conf must not hold ", `, $, \\ or a line break',
      );
    });

    it('takes one of 256 KB and refuses one byte more', () => {
      const of = (size: number) =>
        catalogue(ghostShipping({ 'files/a.txt': 'a'.repeat(size) }));

      expect(readCatalogueFile(of(256 * KB)).ok).toBe(true);
      expect(refusal(of(256 * KB + 1))).toBe(
        'The catalogue holds templates/ghost/files/a.txt, which is larger than 256 KB; that file is at most that',
      );
    });

    it("takes 1 MB of one template's config files and refuses more", () => {
      const of = (last: number) =>
        catalogue(
          ghostShipping({
            'files/a.txt': 'a'.repeat(256 * KB),
            'files/b.txt': 'b'.repeat(256 * KB),
            'files/c.txt': 'c'.repeat(256 * KB),
            'files/d.txt': 'd'.repeat(last),
          }),
        );

      expect(readCatalogueFile(of(256 * KB)).ok).toBe(true);
      expect(refusal(of(256 * KB + 1))).toMatch(
        /^The catalogue holds templates\/ghost\/files\/d\.txt, which is larger than 256 KB/,
      );
      const five = catalogue(
        ghostShipping({
          'files/a.txt': 'a'.repeat(250 * KB),
          'files/b.txt': 'b'.repeat(250 * KB),
          'files/c.txt': 'c'.repeat(250 * KB),
          'files/d.txt': 'd'.repeat(250 * KB),
          'files/e.txt': 'e'.repeat(250 * KB),
        }),
      );
      expect(refusal(five)).toBe(
        "The catalogue holds templates/ghost/files/, whose files come to 1.2 MB; one template's config files are at most 1 MB",
      );
    });

    it('counts each template on its own toward the 1 MB', () => {
      const shipping = (id: string) => ({
        ...ghostShipping({
          'files/a.txt': 'a'.repeat(256 * KB),
          'files/b.txt': 'b'.repeat(256 * KB),
          'files/c.txt': 'c'.repeat(256 * KB),
        }),
        id,
      });

      expect(
        readCatalogueFile(catalogue(shipping('ghost'), shipping('blog'))).ok,
      ).toBe(true);
    });
  });

  describe('text', () => {
    it('refuses a file that is not UTF-8, wherever text belongs', () => {
      const latin1 = {
        base64: Buffer.from('caf\xe9', 'latin1').toString('base64'),
      };

      expect(
        refusal(catalogue(ghostShipping({ 'files/a.conf': latin1 }))),
      ).toBe(
        'The catalogue holds templates/ghost/files/a.conf, which is not UTF-8 text',
      );
      expect(refusal(catalogue(ghost({ files: { 'logo.svg': latin1 } })))).toBe(
        'The catalogue holds templates/ghost/logo.svg, which is not UTF-8 text',
      );
      expect(
        refusal(catalogue(ghost({ files: { 'cloudgate.yaml': latin1 } }))),
      ).toBe(
        'The catalogue holds templates/ghost/cloudgate.yaml, which is not UTF-8 text',
      );
    });

    it('refuses a file with a NUL byte', () => {
      expect(
        refusal(catalogue(ghostShipping({ 'files/a.conf': 'a\u0000b' }))),
      ).toBe(
        'The catalogue holds templates/ghost/files/a.conf, which is not text: it has a NUL',
      );
      expect(
        refusal(catalogue(ghost({ compose: 'services: {}\n\u0000' }))),
      ).toBe(
        'The catalogue holds templates/ghost/docker-compose.yml, which is not text: it has a NUL',
      );
    });

    it('reads a PNG logo as bytes, NUL and all', () => {
      const logo = png(48, 48);
      const read = readCatalogueFile(
        catalogue(ghost({ files: { 'logo.svg': null, 'logo.png': logo } })),
      );

      expect(read.ok && read.entries[0].files['logo.png']).toEqual(logo);
    });
  });

  it('hides a template failing its own rules alone, in a sound zip', () => {
    const result = checkCatalogue(
      catalogue(
        ghost({ id: 'ghost' }),
        ghost({
          id: 'pinned',
          compose: 'services:\n  ghost: { image: ghost }\n',
        }),
        ghost({ id: 'blog' }),
      ),
      INSTANCE,
    );

    expect(result.ok && result.offered.map((template) => template.id)).toEqual([
      'ghost',
      'blog',
    ]);
    expect(result.ok && result.hidden.map((template) => template.id)).toEqual([
      'pinned',
    ]);
  });
});

describe('encodeCatalogue', () => {
  const bytesOf = (folder: Folder) =>
    Object.fromEntries(
      Object.entries(folder.files).map(([path, content]) => [
        path,
        typeof content === 'string'
          ? Buffer.from(content, 'utf8')
          : Buffer.from(content.base64, 'base64'),
      ]),
    );

  it('writes a zip read back to the same templates', () => {
    const folders = [
      { ...ghost({ id: 'ghost' }), revision: 'aaa' },
      {
        ...ghost({
          id: 'blog',
          files: { 'logo.svg': null, 'logo.png': png(8, 8) },
        }),
        revision: 'bbb',
      },
    ];
    const read = readCatalogueFile(
      encodeCatalogue(
        folders.map(({ id, revision, files }) => ({
          id,
          revision,
          files: bytesOf({ id, files }),
        })),
      ),
    );

    expect(read).toEqual({
      ok: true,
      entries: folders.map(({ id, revision, files }) => ({
        id,
        revision,
        files,
      })),
    });
  });

  it("leaves the website's index.md and screenshots/ out", () => {
    const folder = ghost();
    const read = readCatalogueFile(
      encodeCatalogue([
        {
          id: 'ghost',
          revision: 'r',
          files: {
            ...bytesOf(folder),
            'index.md': Buffer.from('# Ghost'),
            'screenshots/home.png': Buffer.from(png(4, 4).base64, 'base64'),
          },
        },
      ]),
    );

    expect(read.ok && read.entries[0].files).toEqual(folder.files);
  });

  it('keeps any other stray file, so the check names it', () => {
    const encoded = encodeCatalogue([
      {
        id: 'ghost',
        revision: 'r',
        files: {
          ...bytesOf(ghost()),
          'docker-compose.yaml': Buffer.from('services: {}\n'),
        },
      },
    ]);

    expect(refusal(encoded)).toBe(
      'The catalogue holds templates/ghost/docker-compose.yaml, a second compose file; a template has at most one, docker-compose.yml',
    );
  });
});
