import { ghost, hiddenReason, offered } from './catalogue.fixture';

/**
 * `template.yaml`'s `signIn` (#131): how a person signs in to the app once it
 * runs, which Get started's done card says. Both forms are taken; an input
 * the template lacks, or both forms at once, hides the template.
 */

/** flatnotes-shaped: an asked username and a generated password, both in its compose file. */
function withSignIn(signIn: string, inputs?: string) {
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
  - { service: ghost, port: 2368 }
files:
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
      'template.yaml: signIn is one form: username and password, or firstVisit, not both',
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

  it('refuses an account with no password', () => {
    expect(
      hiddenReason(
        withSignIn(`signIn:
  username: ADMIN_USER
`),
      ),
    ).toBe('template.yaml: signIn.password is required');
  });
});
