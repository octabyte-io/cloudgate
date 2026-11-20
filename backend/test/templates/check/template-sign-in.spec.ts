import { ghost, hiddenReason, offered } from './catalogue.fixture';

/**
 * `template.yaml`'s `signIn` (#131, #140): how a person signs in to the app
 * once it runs, which Get started's done card says. Both forms are taken; an
 * input or Domain the template lacks, or both forms at once, hides the
 * template.
 */

/**
 * flatnotes-shaped: an asked username and a generated password, both in its
 * compose file, and two Domains, the app's and its admin's. `reads` are more
 * variables the compose file reads, for inputs a test adds; `domains` the
 * Domains it lists, when a test needs others.
 */
function withSignIn(
  signIn: string,
  inputs?: string,
  reads: string[] = [],
  domains = `  - { service: ghost, port: 2368 }
  - { service: admin, port: 2369 }
`,
) {
  return ghost({
    cloudgateYaml: `version: 1
services:
  app: { kind: compose, managed: console }
`,
    templateYaml: `name: Ghost
description: A blog.
tags: [blog]
cloudgate: 0.1.0
compose: app
inputs:
${
  inputs ??
  `  ADMIN_USER: { ask: { label: Username, default: admin } }
  ADMIN_PASSWORD: { generate: password }
  DB_PASSWORD: { generate: password }
  SITE_ID: { generate: uuid }
`
}domains:
${domains}files:
  - { path: config.production.json }
${signIn}`,
    compose: `services:
  ghost:
    image: ghost:5.96-alpine
    environment:
      user: \${ADMIN_USER}
      password: \${ADMIN_PASSWORD}
      db: \${DB_PASSWORD}
      site: \${SITE_ID}
${reads.map((name) => `      ${name.toLowerCase()}: \${${name}}\n`).join('')}  admin:
    image: ghost:5.96-alpine
`,
  });
}

describe('signIn', () => {
  it('takes an account made at setup, named by its inputs', () => {
    const template = offered(
      withSignIn(`signIn:
  username: ADMIN_USER
  password: ADMIN_PASSWORD
`),
    );

    expect(template.signIn).toEqual({
      username: 'ADMIN_USER',
      password: 'ADMIN_PASSWORD',
    });
  });

  it('takes a fixed username', () => {
    const template = offered(
      withSignIn(`signIn:
  username: { value: admin }
  password: ADMIN_PASSWORD
`),
    );

    expect(template.signIn).toEqual({
      username: { value: 'admin' },
      password: 'ADMIN_PASSWORD',
    });
  });

  it('takes an account made on the first visit, with its path and note', () => {
    const template = offered(
      withSignIn(`signIn:
  firstVisit:
    path: /ghost
    note: Create the owner account; the first account made is the owner.
`),
    );

    expect(template.signIn).toEqual({
      firstVisit: {
        path: '/ghost',
        note: 'Create the owner account; the first account made is the owner.',
      },
    });
  });

  it('leaves it out when the template says nothing', () => {
    expect(offered(withSignIn('')).signIn).toBeUndefined();
  });

  it('refuses an input the template has no rule for, naming it', () => {
    expect(
      hiddenReason(
        withSignIn(`signIn:
  username: ADMIN_USER
  password: ROOT_PASSWORD
`),
      ),
    ).toBe(
      'template.yaml: signIn.password names ROOT_PASSWORD, which inputs has no rule for',
    );
    expect(
      hiddenReason(
        withSignIn(`signIn:
  username: OWNER
  password: ADMIN_PASSWORD
`),
      ),
    ).toBe(
      'template.yaml: signIn.username names OWNER, which inputs has no rule for',
    );
  });

  it('refuses both forms at once', () => {
    expect(
      hiddenReason(
        withSignIn(`signIn:
  username: ADMIN_USER
  password: ADMIN_PASSWORD
  firstVisit: { path: /ghost }
`),
      ),
    ).toBe(
      'template.yaml: signIn is one form: a password (with a username if the app asks one), or firstVisit, not both',
    );
  });

  it('refuses a password that is not a secret', () => {
    expect(
      hiddenReason(
        withSignIn(`signIn:
  username: ADMIN_USER
  password: SITE_ID
`),
      ),
    ).toBe(
      'template.yaml: signIn.password names SITE_ID, which is not a secret: ask it with secret: true, or generate a password',
    );
  });

  describe('the forms the catalogue needs (#140)', () => {
    /** The inputs above, plus `more`, each read by the compose file. */
    function withInputs(signIn: string, more: Record<string, string>) {
      return withSignIn(
        signIn,
        `  ADMIN_USER: { ask: { label: Username, default: admin } }
  ADMIN_PASSWORD: { generate: password }
  DB_PASSWORD: { generate: password }
  SITE_ID: { generate: uuid }
${Object.entries(more)
  .map(([name, rule]) => `  ${name}: ${rule}\n`)
  .join('')}`,
        Object.keys(more),
      );
    }

    it('takes an account made at setup with only a password', () => {
      const template = offered(
        withSignIn(`signIn:
  password: ADMIN_PASSWORD
`),
      );

      expect(template.signIn).toEqual({ password: 'ADMIN_PASSWORD' });
    });

    it('takes the path where an account made at setup signs in', () => {
      const template = offered(
        withSignIn(`signIn:
  username: ADMIN_USER
  password: ADMIN_PASSWORD
  path: /admin
`),
      );

      expect(template.signIn).toEqual({
        username: 'ADMIN_USER',
        password: 'ADMIN_PASSWORD',
        path: '/admin',
      });
    });

    it('refuses a sign-in path that does not start with /', () => {
      expect(
        hiddenReason(
          withSignIn(`signIn:
  password: ADMIN_PASSWORD
  path: admin
`),
        ),
      ).toBe('template.yaml: signIn.path must start with /');
    });

    it('takes the Domain each form signs in on, by its service', () => {
      expect(
        offered(
          withSignIn(`signIn:
  username: ADMIN_USER
  password: ADMIN_PASSWORD
  path: /web/admin
  domain: admin
`),
        ).signIn,
      ).toEqual({
        username: 'ADMIN_USER',
        password: 'ADMIN_PASSWORD',
        path: '/web/admin',
        domain: 'admin',
      });
      expect(
        offered(
          withSignIn(`signIn:
  firstVisit: { path: /admin, domain: admin }
`),
        ).signIn,
      ).toEqual({ firstVisit: { path: '/admin', domain: 'admin' } });
    });

    it('refuses a Domain the template does not list, on either form', () => {
      expect(
        hiddenReason(
          withSignIn(`signIn:
  password: ADMIN_PASSWORD
  domain: keycloak
`),
        ),
      ).toBe(
        'template.yaml: signIn.domain names keycloak, which domains does not list: name a Domain by its service',
      );
      expect(
        hiddenReason(
          withSignIn(`signIn:
  firstVisit: { path: /admin, domain: keycloak }
`),
        ),
      ).toBe(
        'template.yaml: signIn.firstVisit.domain names keycloak, which domains does not list: name a Domain by its service',
      );
    });

    it('refuses a Domain whose service several Domains share, as it names none of them', () => {
      expect(
        hiddenReason(
          withSignIn(
            `signIn:
  password: ADMIN_PASSWORD
  domain: admin
`,
            undefined,
            [],
            `  - { service: ghost, port: 2368 }
  - { service: admin, port: 2369 }
  - { service: admin, port: 2370 }
`,
          ),
        ),
      ).toBe(
        'template.yaml: signIn.domain names admin, which has 2 Domains in domains, so it names none of them: give the sign-in its own service, or leave domain out',
      );
    });

    it('refuses an account with only a username, only a path, or neither', () => {
      expect(
        hiddenReason(
          withSignIn(`signIn:
  username: ADMIN_USER
`),
        ),
      ).toBe('template.yaml: signIn.password is required');
      expect(
        hiddenReason(
          withSignIn(`signIn:
  path: /admin
`),
        ),
      ).toBe('template.yaml: signIn.password is required');
      expect(
        hiddenReason(
          withSignIn(`signIn: {}
`),
        ),
      ).toBe(
        'template.yaml: signIn must be a password (with a username if the app asks one), or firstVisit',
      );
    });

    it('takes a password held in a value that is one reference to a generated input', () => {
      const template = offered(
        withInputs(
          `signIn:
  username: ADMIN_USER
  password: APP_PASSWORD
`,
          { APP_PASSWORD: '{ value: "{{ADMIN_PASSWORD}}" }' },
        ),
      );

      expect(template.signIn).toEqual({
        username: 'ADMIN_USER',
        password: 'APP_PASSWORD',
      });
    });

    it('takes a password held in a value that is one reference to an input asked secret', () => {
      const template = offered(
        withInputs(
          `signIn:
  password: APP_PASSWORD
`,
          {
            OWNER_SECRET: '{ ask: { label: Owner password, secret: true } }',
            APP_PASSWORD: '{ value: "{{OWNER_SECRET}}" }',
          },
        ),
      );

      expect(template.signIn).toEqual({ password: 'APP_PASSWORD' });
    });

    it('refuses a password held in a value that is fixed or mixed text', () => {
      const expected =
        'template.yaml: signIn.password names APP_PASSWORD, a value that is not a secret: a value is taken only when it is exactly one reference, {{NAME}}, to an input asked with secret: true or generated as a password';
      expect(
        hiddenReason(
          withInputs(
            `signIn:
  password: APP_PASSWORD
`,
            { APP_PASSWORD: '{ value: changeme }' },
          ),
        ),
      ).toBe(expected);
      expect(
        hiddenReason(
          withInputs(
            `signIn:
  password: APP_PASSWORD
`,
            { APP_PASSWORD: '{ value: "pw-{{ADMIN_PASSWORD}}" }' },
          ),
        ),
      ).toBe(expected);
    });

    it('refuses a password held in a value that refers to an input that is not a secret', () => {
      expect(
        hiddenReason(
          withInputs(
            `signIn:
  password: APP_PASSWORD
`,
            { APP_PASSWORD: '{ value: "{{SITE_ID}}" }' },
          ),
        ),
      ).toBe(
        'template.yaml: signIn.password names APP_PASSWORD, a value that refers to SITE_ID, which is not a secret: ask it with secret: true, or generate a password',
      );
    });
  });
});
