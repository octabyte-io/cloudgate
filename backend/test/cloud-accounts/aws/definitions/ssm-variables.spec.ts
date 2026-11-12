import { createHmac } from 'node:crypto';

import {
  ADVANCED_MAX_BYTES,
  STANDARD_MAX_BYTES,
  placeVariables,
  ssmParameterName,
  variablesDigest,
} from '../../../../src/cloud-accounts/aws/definitions/ssm-variables';
import { valueVariable } from '../../../../src/cloud-accounts/definitions/tofu-json';

/** A cloud Service's variables as SSM parameters. */
describe('ssmParameterName', () => {
  it('is /cloudgate/<environment id>/<service id>/<VARIABLE>', () => {
    expect(ssmParameterName('env_-1', 'Svc_a-2', 'DATABASE_URL')).toBe(
      '/cloudgate/env_-1/Svc_a-2/DATABASE_URL',
    );
  });
});

describe('placeVariables', () => {
  const one = (value: string) => placeVariables('api', { VALUE: value });

  it('makes an empty value a plain environment entry, not a parameter', () => {
    expect(one('')).toEqual({
      ok: true,
      placements: [{ name: 'VALUE', kind: 'plain' }],
    });
  });

  it.each([
    ['one byte', 'x', 'Standard'],
    ['exactly 4 KB', 'x'.repeat(STANDARD_MAX_BYTES), 'Standard'],
    ['one byte over 4 KB', 'x'.repeat(STANDARD_MAX_BYTES + 1), 'Advanced'],
    ['exactly 8 KB', 'x'.repeat(ADVANCED_MAX_BYTES), 'Advanced'],
  ])('holds %s as a %s SecureString', (_label, value, tier) => {
    expect(one(value)).toEqual({
      ok: true,
      placements: [{ name: 'VALUE', kind: 'secure', tier }],
    });
  });

  it('counts bytes of UTF-8, not characters', () => {
    // 1366 three-byte characters: 1366 characters, 4098 bytes.
    const wide = '€'.repeat(1366);
    expect(wide.length).toBeLessThan(STANDARD_MAX_BYTES);
    expect(one(wide)).toEqual({
      ok: true,
      placements: [{ name: 'VALUE', kind: 'secure', tier: 'Advanced' }],
    });
    // 2731 characters, 8193 bytes: refused although under 8192 characters.
    expect(one('€'.repeat(2731)).ok).toBe(false);
  });

  it('refuses a value over 8 KB, naming the variable and never quoting it', () => {
    const value = 'S'.repeat(ADVANCED_MAX_BYTES + 1);
    const outcome = placeVariables('api', { SMALL: 'x', BIG_CERT: value });
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        at: 'api.env',
        message:
          "api's variable BIG_CERT is 8193 bytes, and SSM holds at most 8192 (8 KB). Shorten it, or keep it elsewhere and pass its location",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('SSSS');
  });

  it('refuses a name an SSM parameter name cannot carry', () => {
    expect(placeVariables('api', { 'MY VAR': 'x' })).toEqual({
      ok: false,
      refusal: {
        at: 'api.env',
        message:
          "api's variable MY VAR cannot be an SSM parameter name: use letters, digits, _, . and - only",
      },
    });
  });

  it('sorts by name', () => {
    const outcome = placeVariables('api', { B: 'x', A: '', C: 'y' });
    expect(outcome.ok && outcome.placements.map((p) => p.name)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});

describe('valueVariable', () => {
  it('is an OpenTofu identifier, one per name', () => {
    const names = ['API_KEY', 'a.b', 'a-b', 'a-2eb', 'a_b'];
    const held = names.map(valueVariable);
    expect(held).toEqual([
      'variable_value_API_KEY',
      'variable_value_a-2eb',
      'variable_value_a-2db',
      'variable_value_a-2d2eb',
      'variable_value_a_b',
    ]);
    for (const name of held) expect(name).toMatch(/^[A-Za-z_][\w-]*$/);
    expect(new Set(held).size).toBe(names.length);
  });
});

describe('variablesDigest', () => {
  const secret = 'a-test-app-encryption-secret';

  it('is the same for the same values, whatever their order', () => {
    expect(variablesDigest(secret, { A: '1', B: '2' })).toBe(
      variablesDigest(secret, { B: '2', A: '1' }),
    );
  });

  it('changes when any value, name or the secret changes', () => {
    const base = variablesDigest(secret, { A: '1', B: '2' });
    expect(variablesDigest(secret, { A: '1', B: '3' })).not.toBe(base);
    expect(variablesDigest(secret, { A: '1', C: '2' })).not.toBe(base);
    expect(variablesDigest(secret, { A: '1' })).not.toBe(base);
    expect(variablesDigest(secret, { A: '1', B: '2', C: '' })).not.toBe(base);
    expect(variablesDigest('another-secret', { A: '1', B: '2' })).not.toBe(
      base,
    );
  });

  it("is keyed under the secret's own label, not the column key", () => {
    const key = createHmac('sha256', secret)
      .update('cloudgate:variables-digest:v1')
      .digest();
    expect(variablesDigest(secret, { A: '1' })).toBe(
      createHmac('sha256', key)
        .update(JSON.stringify([['A', '1']]))
        .digest('hex'),
    );
    expect(variablesDigest(secret, { A: 'hunter2' })).not.toContain('hunter2');
  });

  it('refuses to digest without a secret', () => {
    expect(() => variablesDigest('', { A: '1' })).toThrow(
      /APP_ENCRYPTION_SECRET is not set/,
    );
  });
});
