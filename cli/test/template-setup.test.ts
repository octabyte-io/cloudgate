import {
  applyComposeDefaults,
  composeDotenvLine,
  fillFileText,
  makeValues,
  publishStackVmPorts,
  setupDomains,
} from 'cloudgate-template-setup';
import { describe, expect, it } from 'vitest';

/**
 * What an Instance does to a Template's compose part at setup, bundled from
 * the backend's source (`template-setup.d.ts`) so that `cloudgate template
 * try` prepares a Template as an Instance does (spec #5). The rules are
 * tested where they live (`backend/test/templates/setup/`,
 * `backend/test/compose/`); this proves the CLI reaches that same code, and
 * keeps the hand-written declaration honest.
 */
const LOCAL = {
  domain: (name: string, part: 'url' | 'host') =>
    name === 'web'
      ? part === 'url'
        ? 'http://localhost:8080'
        : 'localhost'
      : null,
};

/** A random source pinned so a generated value can be written down. */
const PINNED = {
  bytes: (n: number) => Buffer.alloc(n, 0xab),
  below: () => 0,
  uuid: () => '00000000-0000-4000-8000-000000000000',
};

describe('makeValues', () => {
  it('fills a Domain reference and generates a value as setup does', () => {
    expect(
      makeValues(
        {
          SITE_URL: { value: '{{domains.web.url}}/admin' },
          SECRET: { generate: 'hex' },
          ADMIN_EMAIL: {
            ask: { label: 'Admin email', format: 'email', default: 'a@b.co' },
          },
        },
        { asked: {}, ...LOCAL },
        PINNED,
      ),
    ).toEqual({
      ok: true,
      values: {
        SITE_URL: 'http://localhost:8080/admin',
        SECRET: 'ab'.repeat(32),
        ADMIN_EMAIL: 'a@b.co',
      },
    });
  });

  it('refuses an asked value its format does not allow, naming the input', () => {
    const made = makeValues(
      { ADMIN_EMAIL: { ask: { label: 'Admin email', format: 'email' } } },
      { asked: { ADMIN_EMAIL: 'not an email' }, ...LOCAL },
    );

    expect(made.ok).toBe(false);
    expect(made.ok ? [] : made.problems.map(({ input }) => input)).toEqual([
      'ADMIN_EMAIL',
    ]);
  });
});

describe('fillFileText', () => {
  it("fills a value and a Domain host and leaves a file's own braces", () => {
    expect(
      fillFileText(
        'server_name {{domains.web.host}};\n# {{PORT}} {{ other }}',
        LOCAL,
        { PORT: '8080' },
      ),
    ).toBe('server_name localhost;\n# 8080 {{ other }}');
  });
});

describe('setupDomains', () => {
  it('names a service with two Domains by their order', () => {
    expect(
      setupDomains({
        domains: [
          { service: 'web', port: 80, path: '/' },
          { service: 'api', port: 3000, path: '/' },
          { service: 'api', port: 3001, path: '/admin' },
        ],
      }).map(({ name }) => name),
    ).toEqual(['web', 'api#1', 'api#2']);
  });
});

describe('applyComposeDefaults', () => {
  it("writes a Server's restart and log limits where the file is silent", () => {
    const spec = applyComposeDefaults(
      { composeType: 'docker-compose' },
      {
        services: {
          web: { image: 'nginx:1.27.0' },
          worker: { image: 'busybox:1.36', restart: 'no' },
        },
      },
      {},
    );

    expect(spec.services).toEqual({
      web: {
        image: 'nginx:1.27.0',
        restart: 'unless-stopped',
        logging: {
          driver: 'json-file',
          options: { 'max-size': '10m', 'max-file': '3' },
        },
      },
      worker: {
        image: 'busybox:1.36',
        restart: 'no',
        logging: {
          driver: 'json-file',
          options: { 'max-size': '10m', 'max-file': '3' },
        },
      },
    });
  });
});

describe('composeDotenvLine', () => {
  it('quotes a value Compose would otherwise cut at its $ and #', () => {
    expect(composeDotenvLine('PASSWORD=p$ss #1')).toBe('PASSWORD="p\\$ss #1"');
  });

  it('leaves a plain value as it is', () => {
    expect(composeDotenvLine('APP_NAME=ghost')).toBe('APP_NAME=ghost');
  });
});

describe('publishStackVmPorts', () => {
  it("publishes a Domain's container port", () => {
    const content = publishStackVmPorts(
      'services:\n  web:\n    image: nginx\n',
      [{ host: 'localhost', serviceName: 'web', port: 80 }],
    );

    expect(content).toMatch(
      /web:\n {4}image: nginx\n {4}ports:\n {6}- "?80:80"?\n/,
    );
  });

  it('refuses a Domain on a service the file does not declare', () => {
    expect(() =>
      publishStackVmPorts('services:\n  web:\n    image: nginx\n', [
        { host: 'localhost', serviceName: 'api', port: 3000 },
      ]),
    ).toThrow(/service "api" which does not exist/);
  });
});
