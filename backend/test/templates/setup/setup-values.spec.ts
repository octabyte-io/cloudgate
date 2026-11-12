import { createHmac } from 'node:crypto';

import {
  fillFileText,
  madeAs,
  makeValues,
  signJwt,
} from '../../../src/templates/setup/setup-values';
import type { InputRule } from '../../../src/templates/check';

const NO_DOMAINS = { domain: () => null };

function made(
  inputs: Record<string, InputRule>,
  asked: Record<string, string> = {},
) {
  const result = makeValues(inputs, { asked, ...NO_DOMAINS });
  if (!result.ok) {
    throw new Error(result.problems.map((p) => p.message).join('; '));
  }
  return result.values;
}

describe('makeValues', () => {
  it('generates a password of 32 letters and digits, a different one each setup', () => {
    const first = made({ PW: { generate: 'password' } }).PW;
    const second = made({ PW: { generate: 'password' } }).PW;

    expect(first).toMatch(/^[A-Za-z0-9]{32}$/);
    // Mixed case: not the old lowercased generator.
    expect(first).not.toBe(first.toLowerCase());
    expect(second).not.toBe(first);
  });

  it('generates 64 hex characters, 32 bytes of base64 and a uuid', () => {
    const values = made({
      HEX: { generate: 'hex' },
      B64: { generate: 'base64' },
      ID: { generate: 'uuid' },
    });

    expect(values.HEX).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(values.B64, 'base64')).toHaveLength(32);
    expect(values.ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('signs a jwt HS256 with the value of the input it names, with no expiry added', () => {
    const values = made({
      SECRET: { generate: 'hex' },
      ANON_KEY: {
        generate: 'jwt',
        secret: 'SECRET',
        payload: { role: 'anon', iss: 'supabase' },
      },
    });

    const [header, payload, signature] = values.ANON_KEY.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      role: 'anon',
      iss: 'supabase',
    });
    // Checked with an HMAC worked out here, not with the signer's own code.
    const expected = createHmac('sha256', values.SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
  });

  it('fills a fixed value from the inputs it refers to, however deep', () => {
    const values = made(
      {
        USER: { ask: { label: 'User' } },
        PW: { generate: 'password' },
        URL: { value: 'postgres://{{USER}}:{{PW}}@db/{{NAME}}' },
        NAME: { value: 'app-{{USER}}' },
      },
      { USER: 'ada' },
    );

    expect(values.URL).toBe(`postgres://ada:${values.PW}@db/app-ada`);
  });

  it('takes an asked value, or its default when none is given', () => {
    const values = made(
      {
        EMAIL: { ask: { label: 'Admin email', format: 'email' } },
        PORT: { ask: { label: 'Port', format: 'number', default: '8080' } },
      },
      { EMAIL: 'ada@example.com' },
    );

    expect(values).toEqual({ EMAIL: 'ada@example.com', PORT: '8080' });
  });

  it('refuses asked values that fail their check, are missing, or are not asked, before generating anything', () => {
    const result = makeValues(
      {
        EMAIL: { ask: { label: 'Admin email', format: 'email' } },
        CODE: { ask: { label: 'Code', pattern: '[A-Z]{4}' } },
        NAME: { ask: { label: 'Site name' } },
        NOTE: { ask: { label: 'Note', required: false } },
        PW: { generate: 'password' },
      },
      {
        asked: { EMAIL: 'not-an-email', CODE: 'ABCDE', PW: 'mine' },
        ...NO_DOMAINS,
      },
    );

    expect(result).toEqual({
      ok: false,
      problems: [
        { input: 'PW', message: 'PW is not a value this template asks for' },
        {
          input: 'EMAIL',
          message: 'Admin email must be an email address, as its format says',
        },
        { input: 'CODE', message: 'Code must match its pattern, [A-Z]{4}' },
        { input: 'NAME', message: 'Site name is required' },
      ],
    });
  });

  it('refuses a value referring to a Domain setup picked no host for', () => {
    const result = makeValues(
      { URL: { value: '{{domains.app.url}}/admin' } },
      { asked: {}, ...NO_DOMAINS },
    );

    expect(result).toEqual({
      ok: false,
      problems: [
        {
          input: 'URL',
          message:
            'refers to {{domains.app.url}}, and setup has no host for app',
        },
      ],
    });
  });
});

describe('madeAs', () => {
  it('names how each kind of value is made, base64 as 32 bytes', () => {
    expect(madeAs({ generate: 'base64' })).toBe('generated (base64, 32 bytes)');
    expect(madeAs({ generate: 'password' })).toBe(
      'generated (password, 32 characters)',
    );
    expect(madeAs({ ask: { label: 'Email' } })).toBe('asked');
    expect(madeAs({ value: 'x' })).toBe('fixed');
  });
});

describe('signJwt', () => {
  it('keeps an expiry the payload sets', () => {
    const token = signJwt({ exp: 1_900_000_000 }, 'secret');

    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as { exp: number };
    expect(payload.exp).toBe(1_900_000_000);
  });
});

describe('fillFileText', () => {
  const answers = {
    domain: (name: string, part: 'url' | 'host') =>
      name === 'ghost'
        ? part === 'host'
          ? 'ghost.example.com'
          : 'https://ghost.example.com'
        : null,
  };

  it('fills in a Domain’s url and host and every input it names', () => {
    const text = fillFileText(
      '{ "url": "{{domains.ghost.url}}", "host": "{{domains.ghost.host}}", "mail": "{{ADMIN_EMAIL}}" }',
      answers,
      { ADMIN_EMAIL: 'ada@example.com' },
    );

    expect(text).toBe(
      '{ "url": "https://ghost.example.com", "host": "ghost.example.com", "mail": "ada@example.com" }',
    );
  });

  it('leaves the file’s own braces as written: a name no input has, and any other {{…}}', () => {
    const text = fillFileText(
      'Hello {{ user.name }} {{TITLE}} {{#each posts}}',
      answers,
      {},
    );

    expect(text).toBe('Hello {{ user.name }} {{TITLE}} {{#each posts}}');
  });
});
