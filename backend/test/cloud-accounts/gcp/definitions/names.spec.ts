import {
  domainName,
  idKey,
  networkName,
  serviceName,
} from '../../../../src/cloud-accounts/gcp/definitions/names';

describe('idKey', () => {
  it('is the first 12 lowercase base32 characters of the id’s SHA-256', () => {
    // SHA-256("abc") = ba7816bf…; its RFC 4648 base32 starts "XJ4BNP4PAHH6".
    expect(idKey('abc')).toBe('xj4bnp4pahh6');
  });

  it('is the same key for the same id, every time', () => {
    expect(idKey('cmh1x2_Env')).toBe(idKey('cmh1x2_Env'));
  });

  it('is 12 characters of a–z and 2–7, whatever the id holds', () => {
    for (const id of ['', 'A', 'env_PROD-1', 'x'.repeat(500), 'ümlaut ${}']) {
      expect(idKey(id)).toMatch(/^[a-z2-7]{12}$/);
    }
  });

  it('gives ids differing only in case different keys', () => {
    expect(idKey('EnvAbc')).not.toBe(idKey('envabc'));
    expect(idKey('svc_X')).not.toBe(idKey('svc_x'));
  });
});

describe('names', () => {
  const googleName = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

  it('names a Service’s things cloudgate-<service key>, within the 30-character service-account limit', () => {
    const name = serviceName('Svc_ABC');
    expect(name).toBe(`cloudgate-${idKey('Svc_ABC')}`);
    expect(name).toHaveLength(22);
    expect(name).toMatch(googleName);
  });

  it('names a network thing cloudgate-<environment key>-<part>', () => {
    expect(networkName('Env_1', 'https-proxy')).toBe(
      `cloudgate-${idKey('Env_1')}-https-proxy`,
    );
  });

  it('names a Domain’s pieces cloudgate-<domain key>', () => {
    expect(domainName('Dom_1')).toBe(`cloudgate-${idKey('Dom_1')}`);
  });
});
