import {
  appliedDomainHttps,
  generatedHostName,
  templateDomainHttps,
} from '../../../src/templates/setup/setup-domains';

describe('templateDomainHttps', () => {
  const on = (where: { cloud: boolean; generated: boolean }) => ({
    ...where,
    generatedHttps: false,
  });

  it('serves the generated host over plain HTTP on a Server whose address no certificate authority can reach', () => {
    expect(templateDomainHttps(on({ cloud: false, generated: true }))).toBe(
      false,
    );
  });

  it('serves the generated host over HTTPS on a Server with a public address, as a plan-made web is', () => {
    expect(
      templateDomainHttps({
        cloud: false,
        generated: true,
        generatedHttps: true,
      }),
    ).toBe(true);
  });

  it('serves a host the user typed over HTTPS on a Server, with a Let’s Encrypt certificate', () => {
    expect(templateDomainHttps(on({ cloud: false, generated: false }))).toBe(
      true,
    );
  });

  it('serves every host over HTTPS in a Cloud Environment, whose load balancer has its own certificate', () => {
    expect(templateDomainHttps(on({ cloud: true, generated: false }))).toBe(
      true,
    );
  });
});

describe('appliedDomainHttps', () => {
  const domain = { service: 'ghost', port: 2368, path: '/' };

  it('serves a Domain as its setup decided', () => {
    expect(
      appliedDomainHttps({
        ...domain,
        host: 'ghost-198-51-100-7.sslip.io',
        https: true,
      }),
    ).toBe(true);
    expect(
      appliedDomainHttps({ ...domain, host: 'blog.example.com', https: false }),
    ).toBe(false);
  });

  it('keeps every sslip.io host plain HTTP on a Pending setup saved before setup decided it, as its values were filled in', () => {
    expect(
      appliedDomainHttps({ ...domain, host: 'ghost-198-51-100-7.sslip.io' }),
    ).toBe(false);
    expect(appliedDomainHttps({ ...domain, host: 'blog.example.com' })).toBe(
      true,
    );
  });
});

describe('generatedHostName', () => {
  const template = { id: 'ackee' } as Parameters<typeof generatedHostName>[0];
  const domain = (service: string) =>
    ({ name: service, service, port: 3000 }) as Parameters<
      typeof generatedHostName
    >[1];

  it('names a service called as its Template once, not ackee-ackee', () => {
    expect(generatedHostName(template, domain('ackee'))).toBe('ackee');
  });

  it('names any other service after the Template and the service', () => {
    expect(generatedHostName(template, domain('ackee-mongo'))).toBe(
      'ackee-ackee-mongo',
    );
  });
});
