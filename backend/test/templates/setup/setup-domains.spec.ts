import {
  appliedDomainHttps,
  templateDomainHttps,
} from '../../../src/templates/setup/setup-domains';

describe('templateDomainHttps', () => {
  it('serves the generated host over plain HTTP on a Server, as a plan-made web and a console-generated Domain are', () => {
    expect(templateDomainHttps({ cloud: false, generated: true })).toBe(false);
  });

  it('serves a host the user typed over HTTPS on a Server, with a Let’s Encrypt certificate', () => {
    expect(templateDomainHttps({ cloud: false, generated: false })).toBe(true);
  });

  it('serves every host over HTTPS in a Cloud Environment, whose load balancer has its own certificate', () => {
    expect(templateDomainHttps({ cloud: true, generated: false })).toBe(true);
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
