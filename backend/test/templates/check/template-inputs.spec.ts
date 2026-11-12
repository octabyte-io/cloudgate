import { ghost, hiddenReason, offered } from './catalogue.fixture';

/**
 * `template.yaml`'s `inputs` against the rest of the template (ADR-0064):
 * which names need a rule, what each rule may refer to, and the compose part
 * never taking an Output.
 */

/** Ghost with a `cloudgate.yaml` of its compose part and the entries given. */
function withEntries(entries: string, inputs: string, compose?: string) {
  return ghost({
    cloudgateYaml: `version: 1
services:
  app: { kind: compose, managed: console }
${entries}`,
    templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
compose: app
inputs:
${inputs}domains:
  - { service: ghost, port: 2368 }
files:
  - { path: config.production.json }
`,
    compose:
      compose ??
      `services:
  ghost:
    image: ghost:5.96-alpine
`,
  });
}

/**
 * Ghost with an own `web`, `site`, whose `env` lists `names`, and the rules
 * given for them, so every rule is used and only what it says is checked.
 */
function siteUsing(names: string[], rules: string, domains = '') {
  return ghost({
    cloudgateYaml: `version: 1
services:
  app: { kind: compose, managed: console }
  site:
    kind: web
    source: { image: "ghost:5.96" }
    env: [${names.join(', ')}]
`,
    templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
compose: app
inputs:
${rules}domains:
  - { service: ghost, port: 2368 }
${domains}files:
  - { path: config.production.json }
`,
    compose: 'services:\n  ghost:\n    image: ghost:5.96-alpine\n',
  });
}

describe('checkCatalogue', () => {
  describe('which names need an input rule', () => {
    it('offers a template whose every listed name and compose variable has one rule', () => {
      const template = offered(
        withEntries(
          `  web:
    kind: web
    source: { image: "ghost:5.96" }
    env: [SECRET_KEY]
    build_args: [BUILD_TOKEN]
`,
          `  SECRET_KEY: { generate: hex }
  BUILD_TOKEN: { generate: uuid }
  MAIL_FROM: { ask: { label: Sender } }
`,
          `services:
  ghost:
    image: ghost:5.96-alpine
    environment:
      mail__from: \${MAIL_FROM}
      url: \${URL:-http://localhost}
      cost: $$5
`,
        ),
      );

      expect(Object.keys(template.inputs)).toEqual([
        'SECRET_KEY',
        'BUILD_TOKEN',
        'MAIL_FROM',
      ]);
    });

    it('refuses a name cloudgate.yaml lists without a rule, naming it', () => {
      expect(
        hiddenReason(
          withEntries(
            `  web:
    kind: web
    source: { image: "ghost:5.96" }
    env: [SECRET_KEY]
`,
            '  {}\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs has no rule for SECRET_KEY, which web lists in cloudgate.yaml',
      );
    });

    it('refuses a compose variable with no default and no rule, in each spelling compose reads', () => {
      const composeUsing = (value: string) =>
        withEntries(
          '',
          '  {}\n',
          `services:\n  ghost:\n    image: ghost:5.96-alpine\n    environment:\n      X: "${value}"\n`,
        );

      for (const value of [
        '${MAIL_FROM}',
        '$MAIL_FROM',
        '${MAIL_FROM:?set it}',
      ]) {
        expect(hiddenReason(composeUsing(value))).toBe(
          'template.yaml: inputs has no rule for MAIL_FROM, which docker-compose.yml uses',
        );
      }
    });

    it('takes a compose variable with a default, or a dollar escaped, without a rule', () => {
      expect(
        offered(
          withEntries(
            '',
            '  {}\n',
            `services:
  ghost:
    image: ghost:5.96-alpine
    command: echo "$$HOME \${A:-1} \${B-2} \${C:+3}"
`,
          ),
        ).inputs,
      ).toEqual({});
    });

    it('refuses a rule for a name nothing uses, naming it', () => {
      expect(
        hiddenReason(withEntries('', '  UNUSED: { generate: password }\n')),
      ).toBe(
        'template.yaml: inputs has a rule for UNUSED, which neither cloudgate.yaml nor docker-compose.yml uses',
      );
    });

    it('refuses two rules for one name, naming it', () => {
      expect(
        hiddenReason(
          withEntries(
            '',
            '  MAIL_FROM: { generate: hex }\n  MAIL_FROM: { generate: uuid }\n',
            'services:\n  ghost:\n    image: ghost:5.96-alpine\n    command: echo ${MAIL_FROM}\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs has two rules for MAIL_FROM; a name has exactly one',
      );
    });

    it('gives a name used by two entries and the compose part one rule', () => {
      const template = offered(
        withEntries(
          `  web:
    kind: web
    source: { image: "ghost:5.96" }
    env: [SECRET_KEY]
  jobs:
    kind: worker
    source: { image: "ghost:5.96" }
    env: [SECRET_KEY]
`,
          '  SECRET_KEY: { generate: base64 }\n',
          'services:\n  ghost:\n    image: ghost:5.96-alpine\n    command: echo ${SECRET_KEY}\n',
        ),
      );

      expect(template.inputs).toEqual({ SECRET_KEY: { generate: 'base64' } });
    });
  });

  describe('a Wired variable', () => {
    const WIRED = `  db: { kind: postgres }
  web:
    kind: web
    source: { image: "ghost:5.96" }
    env:
      - DATABASE_URL: db.url
`;

    it('is written only as a link in cloudgate.yaml, and needs no rule', () => {
      expect(offered(withEntries(WIRED, '  {}\n')).inputs).toEqual({});
    });

    it('refuses a rule for it in inputs', () => {
      expect(
        hiddenReason(
          withEntries(WIRED, '  DATABASE_URL: { value: "postgres://db" }\n'),
        ),
      ).toBe(
        'template.yaml: inputs has a rule for DATABASE_URL, which web wires from db.url in cloudgate.yaml; a Wired variable takes no rule',
      );
    });

    it("refuses a compose part that needs an own entry's Output", () => {
      expect(
        hiddenReason(
          withEntries(
            WIRED,
            '  {}\n',
            'services:\n  ghost:\n    image: ghost:5.96-alpine\n    command: echo ${DATABASE_URL}\n',
          ),
        ),
      ).toBe(
        'docker-compose.yml uses ${DATABASE_URL}, which web wires from db.url in cloudgate.yaml; a compose part never takes an Output',
      );
    });
  });

  describe('a generated value', () => {
    it('signs a jwt with another input', () => {
      expect(
        offered(
          siteUsing(
            ['JWT_SECRET', 'ANON_KEY'],
            `  JWT_SECRET: { generate: password }
  ANON_KEY: { generate: jwt, secret: JWT_SECRET, payload: { role: anon } }
`,
          ),
        ).inputs.ANON_KEY,
      ).toEqual({
        generate: 'jwt',
        secret: 'JWT_SECRET',
        payload: { role: 'anon' },
      });
    });

    it('refuses a jwt signed with a name that is not an input', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['ANON_KEY'],
            '  ANON_KEY: { generate: jwt, secret: JWT_SECRET, payload: { role: anon } }\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs.ANON_KEY is signed with JWT_SECRET, which is not an input',
      );
    });

    it('refuses a jwt signed with itself, as a loop', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['ANON_KEY'],
            '  ANON_KEY: { generate: jwt, secret: ANON_KEY, payload: { role: anon } }\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs refer to each other in a loop: ANON_KEY → ANON_KEY',
      );
    });

    it('refuses a jwt with no payload', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['JWT_SECRET', 'ANON_KEY'],
            `  JWT_SECRET: { generate: password }
  ANON_KEY: { generate: jwt, secret: JWT_SECRET }
`,
          ),
        ),
      ).toBe('template.yaml: inputs.ANON_KEY.payload is required');
    });
  });

  describe('an asked value', () => {
    it('takes a label, description, default, required, secret and one check', () => {
      expect(
        offered(
          siteUsing(
            ['ADMIN_EMAIL', 'SEATS', 'CODE'],
            `  ADMIN_EMAIL:
    ask:
      label: Admin email
      description: Where Ghost sends its first login link.
      default: admin@example.com
      required: false
      secret: false
      format: email
  SEATS:
    ask: { label: Seats, default: "5", format: number }
  CODE:
    ask: { label: Invite code, secret: true, pattern: "[A-Z]{4}-[0-9]{4}", default: ABCD-1234 }
`,
          ),
        ).inputs.ADMIN_EMAIL,
      ).toEqual({
        ask: {
          label: 'Admin email',
          description: 'Where Ghost sends its first login link.',
          default: 'admin@example.com',
          required: false,
          secret: false,
          format: 'email',
        },
      });
    });

    it('refuses a pattern that is not a regular expression', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['CODE'],
            '  CODE: { ask: { label: Code, pattern: "[A-Z" } }\n',
          ),
        ),
      ).toMatch(
        /^template\.yaml: inputs\.CODE\.ask\.pattern is not a valid pattern: /,
      );
    });

    it('refuses a default that fails its own check', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['ADMIN_EMAIL'],
            '  ADMIN_EMAIL: { ask: { label: Email, format: email, default: nobody } }\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs.ADMIN_EMAIL.ask.default must be an email address, as its format says',
      );
      expect(
        hiddenReason(
          siteUsing(
            ['CODE'],
            '  CODE: { ask: { label: Code, pattern: "[A-Z]{4}", default: abcd } }\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs.CODE.ask.default must match its pattern, [A-Z]{4}',
      );
    });
  });

  describe('a fixed value', () => {
    it('refers to other inputs and to a Domain, a compose service or an own web', () => {
      expect(
        offered(
          siteUsing(
            ['DB_PASSWORD', 'DB_URL', 'SITE_URL', 'API_HOST'],
            `  DB_PASSWORD: { generate: password }
  DB_URL: { value: "postgres://ghost:{{DB_PASSWORD}}@db/ghost" }
  SITE_URL: { value: "{{domains.site.url}}" }
  API_HOST: { value: "{{domains.ghost.host}}" }
`,
          ),
        ).inputs.DB_URL,
      ).toEqual({ value: 'postgres://ghost:{{DB_PASSWORD}}@db/ghost' });
    });

    it('refuses a reference to a name that is not an input', () => {
      expect(
        hiddenReason(
          siteUsing(['DB_URL'], '  DB_URL: { value: "x{{DB_PASSWORD}}" }\n'),
        ),
      ).toBe(
        'template.yaml: inputs.DB_URL refers to {{DB_PASSWORD}}, which is not an input',
      );
    });

    it('refuses a reference to a Domain the template does not have', () => {
      expect(
        hiddenReason(
          siteUsing(['URL'], '  URL: { value: "{{domains.admin.url}}" }\n'),
        ),
      ).toBe(
        'template.yaml: inputs.URL refers to {{domains.admin.url}}, but admin has no Domain: a Domain is a compose service listed in domains, or an own web',
      );
    });

    it('refuses a reference to a compose service with more than one Domain, which names none', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['URL'],
            '  URL: { value: "{{domains.ghost.url}}" }\n',
            '  - { service: ghost, port: 2369, path: /admin }\n',
          ),
        ),
      ).toBe(
        'template.yaml: inputs.URL refers to {{domains.ghost.url}}, but ghost has 2 Domains, so it names none of them',
      );
    });

    it('refuses text in braces that is not a reference, an Output included', () => {
      expect(
        hiddenReason(
          siteUsing(['URL'], '  URL: { value: "{{domains.ghost.port}}" }\n'),
        ),
      ).toBe(
        'template.yaml: inputs.URL has {{domains.ghost.port}}, which is not a reference: write {{NAME}}, {{domains.<name>.url}} or {{domains.<name>.host}}',
      );
      expect(
        hiddenReason(siteUsing(['URL'], '  URL: { value: "{{site.url}}" }\n')),
      ).toBe(
        'template.yaml: inputs.URL has {{site.url}}, which is not a reference: write {{NAME}}, {{domains.<name>.url}} or {{domains.<name>.host}}',
      );
    });

    it('refuses values that refer to each other in a loop, naming it', () => {
      expect(
        hiddenReason(
          siteUsing(
            ['A', 'B', 'C'],
            `  A: { value: "{{B}}" }
  B: { value: "x{{C}}" }
  C: { value: "{{A}}y" }
`,
          ),
        ),
      ).toBe(
        'template.yaml: inputs refer to each other in a loop: A → B → C → A',
      );
    });

    it('refuses a name that is both an input and a Domain', () => {
      expect(
        hiddenReason(siteUsing(['site'], '  site: { value: "x" }\n')),
      ).toBe(
        'template.yaml: site is both an input and a Domain, so {{site}} and {{domains.site.url}} would read alike; rename the input',
      );
    });
  });
});
