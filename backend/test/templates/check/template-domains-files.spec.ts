import { ghost, hiddenReason, offered, refusal } from './catalogue.fixture';

/**
 * `template.yaml`'s `domains` and `files` against the rest of the template
 * (spec #1356): a Domain names a compose service and never a host, and every
 * file under `files/` is listed once, belongs to an entry, mounts where that
 * entry needs it and stays inside the Service's files directory.
 */

/**
 * Ghost with an own `web`, `site`, and a bucket beside its compose part, and
 * the `domains`, `files` and files under `files/` given.
 */
function ghostWith({
  domains = '',
  files = '',
  folder = {},
}: {
  domains?: string;
  files?: string;
  folder?: Record<string, string>;
}) {
  return ghost({
    cloudgateYaml: `version: 1
services:
  app: { kind: compose, managed: console }
  site:
    kind: web
    source: { image: "ghost:5.96" }
  store: { kind: bucket }
`,
    templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
compose: app
domains:
${domains || '  []\n'}files:
${files || '  []\n'}`,
    compose: `services:
  ghost:
    image: ghost:5.96-alpine
  admin:
    image: ghost:5.96-alpine
`,
    files: { 'files/config.production.json': null, ...folder },
  });
}

describe('checkCatalogue', () => {
  describe('domains', () => {
    it('names a compose service and a port, its path defaulting to /', () => {
      expect(
        offered(
          ghostWith({
            domains: `  - { service: ghost, port: 2368 }
  - { service: admin, port: 2369, path: /ghost }
`,
          }),
        ).domains,
      ).toEqual([
        { service: 'ghost', port: 2368, path: '/' },
        { service: 'admin', port: 2369, path: '/ghost' },
      ]);
    });

    it('refuses a path a Domain could not hold, by the rule every Domain create applies', () => {
      expect(
        hiddenReason(
          ghostWith({
            domains: '  - { service: ghost, port: 2368, path: "/a`b" }\n',
          }),
        ),
      ).toBe(
        "template.yaml: domains.0.path is not a Domain path: Invalid path. Use only letters, numbers, / and - . _ ~ ! $ & ' ( ) * + ; = : @ (e.g. /api), with %-escapes for anything else.",
      );
      expect(
        hiddenReason(
          ghostWith({
            domains: '  - { service: ghost, port: 2368, path: api }\n',
          }),
        ),
      ).toBe(
        'template.yaml: domains.0.path is not a Domain path: A path starts with /',
      );
    });

    it('refuses a service that is not in the compose file', () => {
      expect(
        hiddenReason(
          ghostWith({ domains: '  - { service: blog, port: 2368 }\n' }),
        ),
      ).toBe(
        'template.yaml: domains.0 names blog, which is not a service in docker-compose.yml',
      );
    });

    it('refuses an own web, which gets its generated Domain without being listed', () => {
      expect(
        hiddenReason(
          ghostWith({ domains: '  - { service: site, port: 3000 }\n' }),
        ),
      ).toBe(
        'template.yaml: domains.0 names site, an own web, which gets its generated Domain without being listed; domains lists only compose services',
      );
    });

    it('refuses a Domain in a template with no compose part', () => {
      expect(
        hiddenReason(
          ghost({
            compose: null,
            files: { 'files/config.production.json': null },
            cloudgateYaml: 'version: 1\nservices:\n  db: { kind: postgres }\n',
            templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
domains:
  - { service: ghost, port: 2368 }
`,
          }),
        ),
      ).toBe(
        'template.yaml: domains.0 names ghost, but there is no docker-compose.yml',
      );
    });

    it('refuses a host, which setup picks', () => {
      expect(
        hiddenReason(
          ghostWith({
            domains:
              '  - { service: ghost, port: 2368, host: blog.example.com }\n',
          }),
        ),
      ).toBe(
        "template.yaml: domains.0.host is not written in a template: setup gives each Domain its host, a generated one on a Server and the user's own in a cloud",
      );
    });
  });

  describe('files', () => {
    it('belong to the compose part unless they name an own entry, which mounts them', () => {
      expect(
        offered(
          ghostWith({
            files: `  - { path: config.production.json }
  - { path: site/settings.yml, entry: site, mount: /app/settings.yml }
`,
            folder: {
              'files/config.production.json': '{}',
              'files/site/settings.yml': 'a: 1\n',
            },
          }),
        ).files,
      ).toEqual([
        { path: 'config.production.json' },
        {
          path: 'site/settings.yml',
          entry: 'site',
          mount: '/app/settings.yml',
        },
      ]);
    });

    it('refuses an entry cloudgate.yaml does not list', () => {
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf, entry: cache, mount: /a.conf }\n',
            folder: { 'files/a.conf': '' },
          }),
        ),
      ).toBe(
        'template.yaml: files.0.entry names cache, which cloudgate.yaml does not list',
      );
    });

    it('refuses a file with no entry in a template with no compose part', () => {
      expect(
        hiddenReason(
          ghost({
            compose: null,
            cloudgateYaml: 'version: 1\nservices:\n  db: { kind: postgres }\n',
            templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
files:
  - { path: config.production.json }
`,
          }),
        ),
      ).toBe(
        'template.yaml: files.0 names no entry, and there is no compose part for it to belong to',
      );
    });

    it('requires a mount for an own entry', () => {
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf, entry: site }\n',
            folder: { 'files/a.conf': '' },
          }),
        ),
      ).toBe(
        'template.yaml: files.0 belongs to site, an own entry, so it needs a mount: where in the container the file goes',
      );
    });

    it('refuses a mount for the compose part, whose compose file binds the file', () => {
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf, mount: /etc/a.conf }\n',
            folder: { 'files/a.conf': '' },
          }),
        ),
      ).toBe(
        'template.yaml: files.0 belongs to the compose part, which takes no mount: its docker-compose.yml binds ../files/a.conf',
      );
    });

    it('refuses a mount that is not an absolute path, or on an entry with no container', () => {
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf, entry: site, mount: app/a.conf }\n',
            folder: { 'files/a.conf': '' },
          }),
        ),
      ).toBe(
        'template.yaml: files.0.mount must be an absolute path in the container, e.g. /app/a.conf',
      );
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf, entry: store, mount: /a.conf }\n',
            folder: { 'files/a.conf': '' },
          }),
        ),
      ).toBe(
        'template.yaml: files.0 belongs to store, a bucket, which runs no container to mount it in',
      );
    });

    it('lists every file under files/, once', () => {
      // A file nothing lists is the zip's own refusal (ADR-0072), so it
      // never reaches the per-template rule.
      expect(refusal(ghostWith({ folder: { 'files/extra.conf': '' } }))).toBe(
        'The catalogue holds templates/ghost/files/extra.conf, which its template.yaml does not list in files',
      );
      expect(
        hiddenReason(ghostWith({ files: '  - { path: missing.conf }\n' })),
      ).toBe(
        'template.yaml: files.0 lists missing.conf, which is not under files/',
      );
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf }\n  - { path: a.conf }\n',
            folder: { 'files/a.conf': '' },
          }),
        ),
      ).toBe('template.yaml: files lists a.conf twice');
    });

    it("refuses a path outside the Service's files directory, by the shared file-path rule", () => {
      for (const path of ['../traefik.yml', '/etc/passwd', 'a/../../b']) {
        expect(
          hiddenReason(ghostWith({ files: `  - { path: "${path}" }\n` })),
        ).toBe(
          `template.yaml: files.0.path ${path} must stay inside the Service's files directory`,
        );
      }
      // A file at such a path never reaches the rule: the zip is refused.
      expect(
        refusal(
          ghostWith({
            files: '  - { path: "../traefik.yml" }\n',
            folder: { 'files/../traefik.yml': '' },
          }),
        ),
      ).toBe(
        'The catalogue holds "templates/ghost/files/../traefik.yml", a path that climbs out with ..',
      );
    });

    it('refuses a path a shell could read as more than a path, or not written plainly', () => {
      expect(
        hiddenReason(ghostWith({ files: '  - { path: "a$b.conf" }\n' })),
      ).toBe(
        'template.yaml: files.0.path a$b.conf must not hold ", `, $, \\ or a line break',
      );
      expect(
        hiddenReason(ghostWith({ files: '  - { path: "a/./b.conf" }\n' })),
      ).toBe(
        'template.yaml: files.0.path a/./b.conf must be written plainly, as a/b.conf',
      );
      // A file at such a path refuses the zip, listed or not.
      expect(
        refusal(
          ghostWith({
            files: '  - { path: "a$b.conf" }\n',
            folder: { 'files/a$b.conf': '' },
          }),
        ),
      ).toBe(
        'The catalogue holds templates/ghost/files/a$b.conf, whose path a$b.conf must not hold ", `, $, \\ or a line break',
      );
      expect(
        refusal(
          ghostWith({
            files: '  - { path: "a/./b.conf" }\n',
            folder: { 'files/a/./b.conf': '' },
          }),
        ),
      ).toBe(
        'The catalogue holds "templates/ghost/files/a/./b.conf", a path that is not written plainly',
      );
    });

    it('refers in its text to inputs and Domains, and leaves other braces as written', () => {
      expect(
        offered(
          ghostWith({
            domains: '  - { service: ghost, port: 2368 }\n',
            files: '  - { path: a.conf }\n',
            folder: {
              'files/a.conf':
                'url: {{domains.ghost.url}}\nsite: {{domains.site.host}}\ntitle: {{title}}\nlabels: {{ .Labels }}\n',
            },
          }),
        ).configFiles['a.conf'],
      ).toContain('{{title}}');
    });

    it('refuses text referring to a Domain the template does not have', () => {
      expect(
        hiddenReason(
          ghostWith({
            files: '  - { path: a.conf }\n',
            folder: { 'files/a.conf': 'url: {{domains.blog.url}}\n' },
          }),
        ),
      ).toBe(
        'files/a.conf refers to {{domains.blog.url}}, but blog has no Domain: a Domain is a compose service listed in domains, or an own web',
      );
    });
  });
});
