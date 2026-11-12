import { checkCatalogue } from '../../../src/templates/check';

import {
  catalogue,
  checked,
  ghost,
  hiddenReason,
  INSTANCE,
  offered,
  png,
  refusal,
  SQUARE_SVG,
} from './catalogue.fixture';
import { catalogueZip, zipOf } from '../zip.fixture';

describe('checkCatalogue', () => {
  describe('a template it can offer', () => {
    it('offers it fully parsed, under its folder name and revision', () => {
      const template = offered(ghost());

      expect(template).toMatchObject({
        id: 'ghost',
        revision: 'c0ffee1',
        name: 'Ghost',
        description: 'A publishing platform for blogs and newsletters.',
        version: '5.96',
        tags: ['blog', 'cms'],
        links: {
          website: 'https://ghost.org',
          docs: 'https://ghost.org/docs',
          source: 'https://github.com/TryGhost/Ghost',
        },
        cloudgate: '0.1.0',
        compose: 'app',
        size: 'small',
        inputs: {
          DB_PASSWORD: { generate: 'password' },
          ADMIN_EMAIL: { ask: { label: 'Admin email', format: 'email' } },
        },
        domains: [{ service: 'ghost', port: 2368, path: '/' }],
        files: [{ path: 'config.production.json' }],
        configFiles: {
          'config.production.json': '{ "url": "{{domains.ghost.url}}" }',
        },
      });
      expect(template.config.services).toEqual({
        app: { kind: 'compose', managed: 'console' },
        db: expect.objectContaining({
          kind: 'postgres',
          dockerImage: 'postgres:16',
        }) as unknown,
      });
      expect(template.composeFile).toContain('image: ghost:5.96-alpine');
      expect(template.logo.mediaType).toBe('image/svg+xml');
      expect(Buffer.from(template.logo.bytes).toString('utf8')).toBe(
        SQUARE_SVG,
      );
    });

    it('offers a template with no compose part, defaulting what it leaves out', () => {
      const template = offered(
        ghost({
          compose: null,
          templateYaml: `name: Uptime Kuma
description: A self-hosted monitoring tool.
tags: [monitoring]
cloudgate: 0.1.0
`,
          cloudgateYaml: `version: 1
services:
  app:
    kind: web
    source: { image: "louislam/uptime-kuma:1.23" }
`,
          files: { 'files/config.production.json': null },
        }),
      );

      expect(template).toMatchObject({
        name: 'Uptime Kuma',
        links: {},
        inputs: {},
        domains: [],
        files: [],
        composeFile: null,
        configFiles: {},
      });
      expect(template.version).toBeUndefined();
      expect(template.compose).toBeUndefined();
    });

    it('hides one bad template and still offers the rest, in catalogue order', () => {
      const result = checked(
        ghost({ id: 'ghost' }),
        ghost({
          id: 'broken',
          files: {
            'template.yaml': 'name: Broken\n',
            'files/config.production.json': null,
          },
        }),
        ghost({ id: 'blog' }),
      );

      expect(result.offered.map((template) => template.id)).toEqual([
        'ghost',
        'blog',
      ]);
      expect(result.hidden).toEqual([
        { id: 'broken', reason: 'template.yaml: cloudgate is required' },
      ]);
    });
  });

  describe('the catalogue file', () => {
    it('refuses a file over 10 MB as a whole, before reading it', () => {
      const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, ' ');

      expect(checkCatalogue(bytes, INSTANCE)).toEqual({
        ok: false,
        reason: 'The catalogue is 10 MB; a catalogue is at most 10 MB',
      });
    });

    it('reads a file of exactly 10 MB, and refuses one byte more', () => {
      const exactly = catalogueOfSize(10 * 1024 * 1024);
      const result = checkCatalogue(exactly.bytes, INSTANCE);

      expect(exactly.bytes.byteLength).toBe(10 * 1024 * 1024);
      expect(result.ok && result.offered).toHaveLength(exactly.templates);
      expect(result.ok && result.hidden).toEqual([]);
      expect(
        checkCatalogue(catalogueOfSize(10 * 1024 * 1024 + 1).bytes, INSTANCE),
      ).toEqual({
        ok: false,
        reason: 'The catalogue is 10 MB; a catalogue is at most 10 MB',
      });
    });

    it('refuses a format it does not read, rather than guessing at it', () => {
      const index = (document: unknown) =>
        zipOf([{ path: 'catalogue.json', bytes: JSON.stringify(document) }]);

      expect(
        checkCatalogue(index({ format: 1, templates: [] }), INSTANCE),
      ).toEqual({
        ok: false,
        reason: 'The catalogue is format 1; this Cloudgate reads format 2',
      });
      expect(
        checkCatalogue(index({ format: 3, templates: [] }), INSTANCE),
      ).toEqual({
        ok: false,
        reason: 'The catalogue is format 3; this Cloudgate reads format 2',
      });
    });

    it('refuses a file that is not a zip, or not a catalogue', () => {
      expect(checkCatalogue(Buffer.from('<html>'), INSTANCE)).toEqual({
        ok: false,
        reason: 'The catalogue is not a zip file',
      });
      expect(
        checkCatalogue(
          zipOf([{ path: 'catalogue.json', bytes: '{"format":2}' }]),
          INSTANCE,
        ),
      ).toEqual({
        ok: false,
        reason:
          'The catalogue has a catalogue.json that is not a valid index at templates: Invalid input: expected array, received undefined',
      });
      expect(
        checkCatalogue(
          zipOf([
            {
              path: 'catalogue.json',
              bytes: JSON.stringify({ format: 2, templates: [{}] }),
            },
          ]),
          INSTANCE,
        ),
      ).toMatchObject({ ok: false });
    });

    it('offers nothing and hides nothing from an empty catalogue', () => {
      expect(checkCatalogue(catalogue(), INSTANCE)).toEqual({
        ok: true,
        offered: [],
        hidden: [],
      });
    });
  });

  describe('the Cloudgate version a template needs', () => {
    it('hides a template needing a newer Cloudgate, for that alone', () => {
      // An unknown field too: a newer template may carry fields this
      // Cloudgate does not know, and its version is the reason that counts.
      const reason = hiddenReason(
        ghost({
          templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.2.0
healthcheck: /ghost/api
`,
          files: { 'files/config.production.json': null },
        }),
      );

      expect(reason).toBe('needs Cloudgate 0.2.0 or newer; this is 0.1.0');
    });

    it('offers a template needing this version or an older one', () => {
      const result = checkCatalogue(catalogue(ghost()), {
        cloudgateVersion: '0.3.1',
      });

      expect(result.ok && result.offered).toHaveLength(1);
    });

    it('hides a template stating no version, or not a version', () => {
      const withVersion = (line: string) =>
        ghost({
          templateYaml: `name: Ghost\ndescription: A blog.\ntags: [blog]\n${line}`,
          files: { 'files/config.production.json': null },
        });

      expect(hiddenReason(withVersion(''))).toBe(
        'template.yaml: cloudgate is required',
      );
      expect(hiddenReason(withVersion('cloudgate: soon\n'))).toBe(
        'template.yaml: cloudgate must be a version, e.g. 0.2.0',
      );
    });
  });

  describe('template.yaml', () => {
    /** A `template.yaml` with every required field and the ones given. */
    const templateYaml = (fields: string) =>
      ghost({
        compose: null,
        cloudgateYaml: 'version: 1\nservices:\n  db: { kind: postgres }\n',
        files: { 'files/config.production.json': null },
        templateYaml: `cloudgate: 0.1.0\n${fields}`,
      });
    const REQUIRED = 'name: Ghost\ndescription: A blog.\ntags: [blog]\n';

    it('refuses a field it does not know, naming it', () => {
      expect(hiddenReason(templateYaml(`${REQUIRED}homepage: x\n`))).toBe(
        'template.yaml: homepage is not a field a template has',
      );
      expect(
        hiddenReason(
          templateYaml(`${REQUIRED}links: { home: "https://ghost.org" }\n`),
        ),
      ).toBe('template.yaml: links.home is not a field a template has');
    });

    it('has no id and no logo field: the folder name and logo file are those', () => {
      expect(hiddenReason(templateYaml(`${REQUIRED}id: ghost\n`))).toBe(
        'template.yaml: id is not a field a template has',
      );
      expect(hiddenReason(templateYaml(`${REQUIRED}logo: logo.svg\n`))).toBe(
        'template.yaml: logo is not a field a template has',
      );
    });

    it('requires a name, a description and at least one tag', () => {
      expect(
        hiddenReason(templateYaml('description: A blog.\ntags: [blog]\n')),
      ).toBe('template.yaml: name is required');
      expect(hiddenReason(templateYaml('name: Ghost\ntags: [blog]\n'))).toBe(
        'template.yaml: description is required',
      );
      expect(
        hiddenReason(templateYaml('name: Ghost\ndescription: A blog.\n')),
      ).toBe('template.yaml: tags is required');
      expect(
        hiddenReason(
          templateYaml('name: Ghost\ndescription: A blog.\ntags: []\n'),
        ),
      ).toBe('template.yaml: tags must name at least one tag');
    });

    it('takes a description of 300 characters and refuses one of 301', () => {
      const description = (length: number) =>
        templateYaml(
          `name: Ghost\ndescription: ${'a'.repeat(length)}\ntags: [blog]\n`,
        );

      expect(checked(description(300)).offered).toHaveLength(1);
      expect(hiddenReason(description(301))).toBe(
        'template.yaml: description must be at most 300 characters',
      );
    });

    it('refuses an app version YAML would read as a number', () => {
      expect(hiddenReason(templateYaml(`${REQUIRED}version: 5.10\n`))).toBe(
        'template.yaml: version must be text in quotes, e.g. "5.10"',
      );
    });

    it('refuses a link that is not an http or https address', () => {
      expect(
        hiddenReason(
          templateYaml(`${REQUIRED}links: { docs: "ftp://ghost.org" }\n`),
        ),
      ).toBe('template.yaml: links.docs must be an http or https address');
    });

    it('refuses a minimum size that is not a Size name', () => {
      expect(
        hiddenReason(
          ghost({
            templateYaml: `${REQUIRED}cloudgate: 0.1.0\ncompose: app\nsize: huge\n`,
            files: { 'files/config.production.json': null },
          }),
        ),
      ).toMatch(/^template\.yaml: size must be one of /);
    });

    it('reads inputs, domains and files for their shape', () => {
      expect(
        hiddenReason(
          templateYaml(`${REQUIRED}inputs:\n  SECRET: { generate: sha1 }\n`),
        ),
      ).toMatch(/^template\.yaml: inputs\.SECRET\.generate must be one of /);
      expect(
        hiddenReason(
          templateYaml(
            `${REQUIRED}inputs:\n  SECRET: { generate: hex, value: abc }\n`,
          ),
        ),
      ).toBe(
        'template.yaml: inputs.SECRET must be one rule: generate, ask or value',
      );
      expect(
        hiddenReason(
          templateYaml(
            `${REQUIRED}inputs:\n  EMAIL:\n    ask: { label: Email, format: email, pattern: "^.+@.+$" }\n`,
          ),
        ),
      ).toBe(
        'template.yaml: inputs.EMAIL.ask takes at most one check, format or pattern',
      );
      expect(
        hiddenReason(
          templateYaml(
            `${REQUIRED}domains:\n  - { service: ghost, port: web }\n`,
          ),
        ),
      ).toBe('template.yaml: domains.0.port must be a port number');
      expect(
        hiddenReason(templateYaml(`${REQUIRED}files:\n  - { entry: db }\n`)),
      ).toBe('template.yaml: files.0.path is required');
    });

    it('reads a jwt rule with the input that signs it and its payload', () => {
      const template = offered(
        ghost({
          compose: null,
          files: { 'files/config.production.json': null },
          cloudgateYaml: `version: 1
services:
  app:
    kind: web
    source: { image: "supabase/studio:2025.01.01" }
    env: [JWT_SECRET, ANON_KEY, SITE_URL]
`,
          templateYaml: `cloudgate: 0.1.0
${REQUIRED}inputs:
  JWT_SECRET: { generate: password }
  ANON_KEY: { generate: jwt, secret: JWT_SECRET, payload: { role: anon } }
  SITE_URL: { value: "{{domains.app.url}}" }
`,
        }),
      );

      expect(template.inputs).toEqual({
        JWT_SECRET: { generate: 'password' },
        ANON_KEY: {
          generate: 'jwt',
          secret: 'JWT_SECRET',
          payload: { role: 'anon' },
        },
        SITE_URL: { value: '{{domains.app.url}}' },
      });
    });

    it('refuses a template.yaml that is not YAML', () => {
      expect(hiddenReason(templateYaml('name: [Ghost\n'))).toMatch(
        /^template\.yaml is not valid YAML: /,
      );
    });
  });

  describe('the id', () => {
    it('is the folder name, and must be a Config name', () => {
      expect(hiddenReason(ghost({ id: 'Ghost_CMS' }))).toBe(
        'the folder name "Ghost_CMS" is not a Config name: use lowercase letters, digits and hyphens, starting with a letter, at most 63 characters',
      );
    });

    it('is unique in the catalogue: two folders sharing one refuse the whole zip', () => {
      // One id can only be one folder, so a second is the same paths twice.
      expect(
        refusal(
          ghost({ id: 'ghost' }),
          ghost({ id: 'blog' }),
          ghost({ id: 'ghost' }),
        ),
      ).toBe('The catalogue holds templates/ghost/template.yaml twice');
    });
  });

  describe('cloudgate.yaml', () => {
    it("goes through the instance's own Project config parser", () => {
      expect(
        hiddenReason(
          ghost({
            cloudgateYaml:
              'version: 1\nservices:\n  app: { kind: compose, managed: console }\n  db: { kind: postgres, replicas: 2 }\n',
          }),
        ),
      ).toBe('cloudgate.yaml: db.replicas: it is not a field Cloudgate knows');
    });

    it('takes no template-only field', () => {
      expect(
        hiddenReason(
          ghost({
            cloudgateYaml:
              'version: 1\ntemplate: ghost\nservices:\n  app: { kind: compose, managed: console }\n',
          }),
        ),
      ).toMatch(/^cloudgate\.yaml: template/);
    });

    it('is required, beside template.yaml', () => {
      expect(hiddenReason(ghost({ files: { 'cloudgate.yaml': null } }))).toBe(
        'has no cloudgate.yaml',
      );
      expect(
        hiddenReason(
          ghost({
            files: {
              'template.yaml': null,
              'files/config.production.json': null,
            },
          }),
        ),
      ).toBe('has no template.yaml');
    });
  });

  describe('the compose part', () => {
    it('is written { kind: compose, managed: console }, named by compose', () => {
      expect(
        hiddenReason(
          ghost({
            cloudgateYaml:
              'version: 1\nservices:\n  app:\n    kind: compose\n    source: { github: acme/ghost }\n',
          }),
        ),
      ).toBe(
        'template.yaml: compose names app, which cloudgate.yaml must list as { kind: compose, managed: console }',
      );
    });

    it('is the only console-managed entry a template has', () => {
      expect(
        hiddenReason(
          ghost({
            cloudgateYaml:
              'version: 1\nservices:\n  app: { kind: compose, managed: console }\n  cache: { kind: mongo, managed: console }\n',
          }),
        ),
      ).toBe(
        "cloudgate.yaml: cache is console-managed; a template's only console-managed entry is its compose part, named by compose in template.yaml",
      );
    });

    it('needs docker-compose.yml when named, and a name when the file is there', () => {
      expect(hiddenReason(ghost({ compose: null }))).toBe(
        'template.yaml: compose names app, but there is no docker-compose.yml',
      );
      expect(
        hiddenReason(
          ghost({
            templateYaml:
              'name: Ghost\ndescription: A blog.\ntags: [blog]\ncloudgate: 0.1.0\n',
            cloudgateYaml: 'version: 1\nservices:\n  db: { kind: postgres }\n',
            files: { 'files/config.production.json': null },
          }),
        ),
      ).toBe(
        'docker-compose.yml is here, but template.yaml names no compose entry',
      );
    });

    it('has at most one compose file, at its one fixed name', () => {
      expect(
        refusal(
          ghost({
            files: { 'compose.yaml': 'services:\n  x: { image: "x:1" }\n' },
          }),
        ),
      ).toBe(
        'The catalogue holds templates/ghost/compose.yaml, a second compose file; a template has at most one, docker-compose.yml',
      );
    });

    it('refuses a compose file with no services', () => {
      expect(hiddenReason(ghost({ compose: 'version: "3"\n' }))).toBe(
        'docker-compose.yml must have services, each a map',
      );
    });
  });

  describe('images', () => {
    const composeImage = (image: string) =>
      ghost({
        compose: `services:
  ghost:
    image: ${image}
    environment:
      - DB=\${DB_PASSWORD}
      - MAIL=\${ADMIN_EMAIL}
`,
      });

    it('refuses an image tagged latest', () => {
      expect(hiddenReason(composeImage('ghost:latest'))).toBe(
        "docker-compose.yml: ghost's image ghost:latest is tagged latest; name the version it runs instead",
      );
    });

    it('refuses an image with no tag, a digest alone included', () => {
      expect(hiddenReason(composeImage('ghost'))).toBe(
        "docker-compose.yml: ghost's image ghost has no tag; name the version it runs, e.g. ghost:1.2",
      );
      expect(
        hiddenReason(composeImage('registry.example.com:5000/team/ghost')),
      ).toMatch(/has no tag/);
      expect(
        hiddenReason(composeImage(`ghost@sha256:${'a'.repeat(64)}`)),
      ).toMatch(/has no tag/);
    });

    it('refuses a tag that comes from a variable', () => {
      expect(hiddenReason(composeImage('"ghost:${GHOST_VERSION}"'))).toMatch(
        /is named through a variable/,
      );
    });

    it('takes a version tag, with a registry port or a digest beside it', () => {
      expect(
        checked(composeImage('registry.example.com:5000/team/ghost:5.96'))
          .offered,
      ).toHaveLength(1);
      expect(
        checked(composeImage(`ghost:5.96@sha256:${'a'.repeat(64)}`)).offered,
      ).toHaveLength(1);
    });

    it("checks an own entry's image in cloudgate.yaml too", () => {
      expect(
        hiddenReason(
          ghost({
            cloudgateYaml:
              'version: 1\nservices:\n  app: { kind: compose, managed: console }\n  worker:\n    kind: worker\n    source: { image: "ghost:latest" }\n',
          }),
        ),
      ).toBe(
        "cloudgate.yaml: worker's image ghost:latest is tagged latest; name the version it runs instead",
      );
    });
  });

  describe('the logo', () => {
    it('requires logo.svg, or logo.png', () => {
      expect(hiddenReason(ghost({ files: { 'logo.svg': null } }))).toBe(
        'has no logo; add logo.svg (or logo.png)',
      );
    });

    it('takes logo.png only when there is no SVG', () => {
      const template = offered(
        ghost({ files: { 'logo.svg': null, 'logo.png': png(48, 48) } }),
      );
      expect(template.logo.mediaType).toBe('image/png');

      expect(hiddenReason(ghost({ files: { 'logo.png': png(48, 48) } }))).toBe(
        'has both logo.svg and logo.png; logo.png is only for a template with no SVG',
      );
    });

    it('must be square', () => {
      expect(
        hiddenReason(
          ghost({
            files: {
              'logo.svg':
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>',
            },
          }),
        ),
      ).toBe('logo.svg is 120×40; a logo must be square');
      expect(
        hiddenReason(
          ghost({
            files: {
              'logo.svg':
                '<svg xmlns="http://www.w3.org/2000/svg" width="64px" height="32px"></svg>',
            },
          }),
        ),
      ).toBe('logo.svg is 64×32; a logo must be square');
      expect(
        hiddenReason(
          ghost({ files: { 'logo.svg': null, 'logo.png': png(64, 32) } }),
        ),
      ).toBe('logo.png is 64×32; a logo must be square');
    });

    it('must state a size, in an SVG', () => {
      expect(
        hiddenReason(
          ghost({
            files: {
              'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            },
          }),
        ),
      ).toBe('logo.svg states no size; give its <svg> a square viewBox');
    });

    it('takes 100 KB and refuses more', () => {
      const svgOf = (bytes: number) => {
        const head =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--';
        const tail = '--></svg>';
        return head + 'a'.repeat(bytes - head.length - tail.length) + tail;
      };

      expect(
        checked(ghost({ files: { 'logo.svg': svgOf(100 * 1024) } })).offered,
      ).toHaveLength(1);
      // Past its cap a logo is not unpacked at all, so the zip is refused.
      expect(
        refusal(ghost({ files: { 'logo.svg': svgOf(100 * 1024 + 1) } })),
      ).toBe(
        'The catalogue holds templates/ghost/logo.svg, which is larger than 100 KB; that file is at most that',
      );
    });
  });

  describe('the folder', () => {
    it('holds nothing at its root but the files a template has, or the zip is refused', () => {
      expect(refusal(ghost({ files: { 'README.md': '# Ghost' } }))).toBe(
        'The catalogue holds templates/ghost/README.md, which is not a file a template holds; config files go under files/',
      );
    });

    it('holds text everywhere but a PNG logo, or the zip is refused', () => {
      expect(
        refusal(
          ghost({
            files: {
              'files/config.production.json': { base64: 'AAEC' },
            },
          }),
        ),
      ).toBe(
        'The catalogue holds templates/ghost/files/config.production.json, which is not text: it has a NUL',
      );
    });
  });
});

/**
 * A catalogue of `size` bytes exactly, every template in it one this
 * Cloudgate offers: Ghost folders whose config files are padded until the
 * zip comes to the size. Built with the tests' own zip writer, which stores
 * every file, so each byte of padding is a byte of the zip.
 */
function catalogueOfSize(size: number): { bytes: Buffer; templates: number } {
  const PER_FILE = 250 * 1024;
  const folderOf = (index: number, padding: number) =>
    ghost({
      id: `ghost-${index}`,
      files: {
        'files/config.production.json': `{ "url": "{{domains.ghost.url}}", "pad": "${'a'.repeat(padding)}" }`,
      },
    });
  const build = (paddings: number[]) =>
    catalogueZip(paddings.map((padding, index) => folderOf(index, padding)));

  const templates = Math.ceil(size / PER_FILE);
  const bare = build(new Array<number>(templates).fill(0)).byteLength;
  const missing = size - bare;
  const paddings = new Array<number>(templates).fill(
    Math.floor(missing / templates),
  );
  paddings[0] += missing % templates;
  return { bytes: build(paddings), templates };
}
