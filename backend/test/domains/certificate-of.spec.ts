import { certificateOf } from '../../src/domains/certificate-of';

/**
 * HTTPS off is certificate None: the console saved HTTPS off with
 * Let's Encrypt, and the row read "HTTP / Let's Encrypt".
 */
describe('certificateOf', () => {
  it('stores none, and no resolver, for a Domain that does not serve HTTPS', () => {
    expect(
      certificateOf({
        https: false,
        certificateType: 'custom',
        customCertResolver: 'internal-ca',
      }),
    ).toEqual({ certificateType: 'none', customCertResolver: null });
  });

  it('stores none for a Domain sent with no https at all', () => {
    expect(certificateOf({ certificateType: 'letsencrypt' })).toEqual({
      certificateType: 'none',
      customCertResolver: null,
    });
  });

  it('keeps the certificate asked for on a Domain that serves HTTPS', () => {
    expect(
      certificateOf({
        https: true,
        certificateType: 'custom',
        customCertResolver: 'internal-ca',
      }),
    ).toEqual({ certificateType: 'custom', customCertResolver: 'internal-ca' });
  });
});
