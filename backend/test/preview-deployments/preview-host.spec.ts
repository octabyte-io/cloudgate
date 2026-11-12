import {
  previewHost,
  previewHostRule,
} from '../../src/preview-deployments/preview-host';

/**
 * A Preview deployment's host. With no `previewWildcard` it was
 * `<appName>.sslip.io`, which sslip.io answers nothing for; it now carries the
 * address of the machine the preview runs on, as a generated Domain does.
 */
describe('previewHostRule', () => {
  it("takes the Application's wildcard whatever the machine records", () => {
    expect(
      previewHostRule({ previewWildcard: '*.preview.example.com' }, ''),
    ).toEqual({ wildcard: '*.preview.example.com' });
  });

  it("takes the machine's address when no wildcard is set", () => {
    expect(previewHostRule({ previewWildcard: null }, '203.0.113.10')).toEqual({
      address: '203.0.113.10',
    });
    expect(previewHostRule({ previewWildcard: null }, ' 2001:db8::1 ')).toEqual(
      { address: '2001:db8::1' },
    );
  });

  it.each([
    ['nothing recorded', ''],
    ['a hostname', 'console.example.com'],
    ['an out-of-range quad', '300.1.1.1'],
  ])('has no rule for %s', (_what, recorded) => {
    expect(previewHostRule({ previewWildcard: null }, recorded)).toBeNull();
  });
});

describe('previewHost', () => {
  it('carves the host out of a wildcard, unchanged', () => {
    expect(
      previewHost('preview-web-app-abc123', {
        wildcard: '*.preview.example.com',
      }),
    ).toBe('preview-web-app-abc123.preview.example.com');
  });

  it('dashes an IPv4 address into the name', () => {
    expect(
      previewHost('preview-web-app-abc123', { address: '203.0.113.10' }),
    ).toBe('preview-web-app-abc123-203-0-113-10.sslip.io');
  });

  it('dashes an IPv6 address and keeps every label within 63', () => {
    const host = previewHost('preview-a-rather-long-application-name-abc123', {
      address: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    });

    expect(host).toMatch(
      /-2001-0db8-85a3-0000-0000-8a2e-0370-7334\.sslip\.io$/,
    );
    for (const label of host.split('.')) {
      expect(label.length).toBeLessThanOrEqual(63);
    }
    // The random suffix is what makes two previews of one Application two
    // hosts, so it is the part the cut spares.
    expect(host.split('.')[0]).toMatch(/^preview-.*-abc123-2001-/);
  });

  it('never cuts a name that already fits', () => {
    const appName = 'preview-web-app-abc123';
    expect(previewHost(appName, { address: '::1' })).toBe(
      `${appName}---1.sslip.io`,
    );
  });

  it('never answers a bare <name>.sslip.io', () => {
    for (const address of ['198.51.100.7', '2001:db8::1']) {
      expect(previewHost('preview-x-abc123', { address })).not.toMatch(
        /^preview-x-abc123\.sslip\.io$/,
      );
    }
  });
});
