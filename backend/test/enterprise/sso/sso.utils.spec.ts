import {
  normalizeDomains,
  normalizeTrustedOrigin,
  parseDomainList,
} from '../../../src/enterprise/sso/sso.utils';

describe('normalizeDomains', () => {
  it('trims, lowercases and de-duplicates, keeping first-seen order', () => {
    expect(
      normalizeDomains([' ACME.example.com ', 'acme.example.com', 'B.test']),
    ).toEqual(['acme.example.com', 'b.test']);
  });

  it('drops entries that are empty once trimmed', () => {
    expect(normalizeDomains(['acme.test', '   ', ''])).toEqual(['acme.test']);
  });

  it('leaves an already-normalized list untouched', () => {
    expect(normalizeDomains(['a.test', 'b.test'])).toEqual([
      'a.test',
      'b.test',
    ]);
  });
});

describe('parseDomainList', () => {
  it('splits the stored comma-joined column back into domains', () => {
    expect(parseDomainList('acme.example.com,acme.test')).toEqual([
      'acme.example.com',
      'acme.test',
    ]);
  });

  it('tolerates the spacing and casing a hand-edited row might carry', () => {
    expect(parseDomainList('ACME.example.com , acme.test ,')).toEqual([
      'acme.example.com',
      'acme.test',
    ]);
  });
});

describe('normalizeTrustedOrigin', () => {
  it('trims and drops trailing slashes so one origin is one entry', () => {
    expect(normalizeTrustedOrigin('  https://example.com/  ')).toBe(
      'https://example.com',
    );
    expect(normalizeTrustedOrigin('https://example.com///')).toBe(
      'https://example.com',
    );
  });

  it('keeps a port and a path prefix, which are part of the origin match', () => {
    expect(normalizeTrustedOrigin('http://127.0.0.1:9999')).toBe(
      'http://127.0.0.1:9999',
    );
    expect(normalizeTrustedOrigin('https://example.com/idp/')).toBe(
      'https://example.com/idp',
    );
  });

  it('does not change the case, since matching is case-insensitive anyway', () => {
    expect(normalizeTrustedOrigin('https://IDP.example.com')).toBe(
      'https://IDP.example.com',
    );
  });
});
