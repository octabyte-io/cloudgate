import type { PendingSetupPart } from '../../../src/project-config';
import { bodyWithoutPart } from '../../../src/templates/setup/pending-setups';
import type { PendingSetupBody } from '../../../src/templates/setup/pending-setup.schema';

/** A Ghost-like setup: a compose stack with one Domain, and an own web. */
const STACK: PendingSetupPart = {
  configName: 'ghost-app',
  kind: 'compose',
  made: { DB_PASSWORD: 'generated' },
  domains: [
    { service: 'ghost', port: 2368, path: '/', host: 'blog.example.com' },
  ],
};
const WEB: PendingSetupPart = {
  configName: 'ghost-admin',
  kind: 'web',
  made: { ADMIN_URL: 'asked' },
  host: 'ghost-admin-1a2b3c-198-51-100-7.sslip.io',
};

const BODY: PendingSetupBody = {
  values: {
    'ghost-app': { DB_PASSWORD: 's3cret' },
    'ghost-admin': { ADMIN_URL: 'http://ghost-admin.example' },
  },
  hosts: {
    ghost: 'blog.example.com',
    admin: 'ghost-admin-1a2b3c-198-51-100-7.sslip.io',
  },
  composeFile: 'services: {}',
  files: [
    {
      configName: 'ghost-app',
      path: 'config.json',
      mount: null,
      content: '{}',
    },
  ],
};

describe('bodyWithoutPart', () => {
  it("removes a compose part's values, compose file, files and its Domains' hosts (each Apply removes what it creates)", () => {
    expect(bodyWithoutPart(BODY, STACK)).toEqual({
      values: { 'ghost-admin': { ADMIN_URL: 'http://ghost-admin.example' } },
      hosts: { admin: 'ghost-admin-1a2b3c-198-51-100-7.sslip.io' },
      composeFile: null,
      files: [],
    });
  });

  it("removes a web's values and its generated host, keeping the stack's", () => {
    expect(bodyWithoutPart(BODY, WEB)).toEqual({
      values: { 'ghost-app': { DB_PASSWORD: 's3cret' } },
      hosts: { ghost: 'blog.example.com' },
      composeFile: 'services: {}',
      files: BODY.files,
    });
  });
});
