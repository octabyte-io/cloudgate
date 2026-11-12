import { createPrivateKey, X509Certificate } from 'node:crypto';
import { makeDefaultCertificate } from '../../../src/cloud-accounts/definitions/default-certificate';

/**
 * The HTTPS listener's default certificate is self-signed, made by Cloudgate
 * and imported into ACM (spec "The Environment network") — made here in
 * the backend, so a Cloud run needs no provider beside `hashicorp/aws`.
 */
describe('makeDefaultCertificate', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const made = makeDefaultCertificate(now);
  const certificate = new X509Certificate(made.certificatePem);

  it('is a certificate whose own key signed it', () => {
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(
      certificate.checkPrivateKey(createPrivateKey(made.privateKeyPem)),
    ).toBe(true);
    expect(certificate.issuer).toBe(certificate.subject);
  });

  it('names a host that can never be real', () => {
    expect(certificate.subject).toBe('CN=cloudgate.invalid');
    expect(certificate.subjectAltName).toBe('DNS:cloudgate.invalid');
  });

  it('is an RSA 2048 key in the PEM ACM imports', () => {
    expect(made.privateKeyPem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(made.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    const key = createPrivateKey(made.privateKeyPem);
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('is valid from now for about ten years, for a server and not a CA', () => {
    expect(new Date(certificate.validFrom).getTime()).toBe(now.getTime());
    expect(new Date(certificate.validTo).getUTCFullYear()).toBe(2036);
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
  });

  it('is a new key each time', () => {
    expect(makeDefaultCertificate(now).privateKeyPem).not.toBe(
      made.privateKeyPem,
    );
  });
});
