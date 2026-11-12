import {
  ALWAYS_HTTPS,
  certificatePollDue,
  cloudDomainRefusal,
  dnsRecordsOf,
  googleQuotaRefusal,
  isBareName,
  nextCertificateState,
  nextGoogleCertificateState,
  recordsLeftBehind,
} from '../../src/domains/cloud-domain';

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const REQUESTED = '2026-10-17T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(REQUESTED) + ms);

describe('cloudDomainRefusal', () => {
  const plain = {
    https: true,
    certificateType: 'none' as const,
    customCertResolver: null,
    customEntrypoint: null,
    middlewares: [],
    forwardAuthEnabled: false,
    stripPath: false,
    internalPath: '/',
  };

  it('passes a plain HTTPS Domain', () => {
    expect(cloudDomainRefusal(plain)).toBeNull();
  });

  it.each([
    [{ forwardAuthEnabled: true }, 'forwardAuthEnabled'],
    [{ middlewares: ['redirect@file'] }, 'middlewares'],
    [{ customEntrypoint: 'websecure' }, 'customEntrypoint'],
    [{ stripPath: true }, 'stripPath'],
    [{ internalPath: '/v1' }, 'internalPath'],
    [{ certificateType: 'letsencrypt' as const }, 'certificateType'],
    [{ certificateType: 'custom' as const }, 'certificateType'],
    [{ certificateType: 'stored' as const }, 'certificateType'],
    [{ customCertResolver: 'mine' }, 'customCertResolver'],
  ])('refuses %j, naming %s', (field, name) => {
    expect(cloudDomainRefusal({ ...plain, ...field })).toContain(name);
  });

  it('refuses HTTPS off in its own words', () => {
    expect(cloudDomainRefusal({ ...plain, https: false })).toBe(ALWAYS_HTTPS);
  });

  it('names Google Cloud, and its own certificate, for a Domain there', () => {
    expect(cloudDomainRefusal({ ...plain, https: false }, 'Google Cloud')).toBe(
      'Domains on Google Cloud are always HTTPS',
    );
    expect(
      cloudDomainRefusal({ ...plain, stripPath: true }, 'Google Cloud'),
    ).toBe(
      'stripPath: Strip path is not available on a Domain on Google Cloud',
    );
    expect(
      cloudDomainRefusal(
        { ...plain, certificateType: 'letsencrypt' },
        'Google Cloud',
      ),
    ).toContain('its own Google-managed certificate');
  });
});

describe('isBareName', () => {
  it.each([
    ['example.com', true],
    ['example.co.uk', true],
    ['shop.example.com', false],
    ['shop.example.co.uk', false],
  ])('%s → %s', (host, bare) => {
    expect(isBareName(host)).toBe(bare);
  });
});

describe('dnsRecordsOf', () => {
  const alb = 'cg-123.eu-central-1.elb.amazonaws.com';
  const validation = {
    name: '_x1.shop.example.com.',
    type: 'CNAME',
    value: '_y2.acm-validations.aws.',
  };

  it('asks for the validation CNAME and a CNAME to the load balancer', () => {
    const records = dnsRecordsOf(
      {
        host: 'shop.example.com',
        validationRecord: validation,
        validationRecordFound: true,
        pointsAtLoadBalancer: false,
      },
      alb,
    );
    expect(records.validation).toEqual({ ...validation, seen: true });
    expect(records.pointing).toMatchObject({
      name: 'shop.example.com',
      type: 'CNAME',
      value: alb,
      seen: false,
    });
  });

  it('asks a bare name for an ALIAS, never an A record', () => {
    const { pointing } = dnsRecordsOf(
      {
        host: 'example.com',
        validationRecord: null,
        validationRecordFound: false,
        pointsAtLoadBalancer: false,
      },
      alb,
    );
    expect(pointing.type).toBe('ALIAS');
    expect(pointing.note).toMatch(/ALIAS, ANAME or flattened CNAME/);
    expect(pointing.note).toMatch(/never an A record/);
  });

  it("points a static site's Domain at its CloudFront distribution", () => {
    const { pointing } = dnsRecordsOf(
      {
        host: 'example.com',
        validationRecord: null,
        validationRecordFound: false,
        pointsAtLoadBalancer: false,
      },
      'd111111abcdef8.cloudfront.net',
      'cloudfront',
    );
    expect(pointing).toMatchObject({
      type: 'ALIAS',
      value: 'd111111abcdef8.cloudfront.net',
    });
    expect(pointing.note).toContain('to the CloudFront distribution');
    expect(pointing.note).not.toContain('load balancer');
  });

  it('points a Domain on Google Cloud at the fixed IP with an A record, a bare name too, and no AAAA', () => {
    for (const host of ['shop.acme.dev', 'acme.dev']) {
      const records = dnsRecordsOf(
        {
          host,
          validationRecord: {
            name: `_acme-challenge.${host}.`,
            type: 'CNAME',
            value: 'abc.4.authorize.certificatemanager.goog.',
          },
          validationRecordFound: false,
          pointsAtLoadBalancer: true,
        },
        '34.120.0.7',
        'fixed-ip',
      );
      expect(records.pointing).toMatchObject({
        name: host,
        type: 'A',
        value: '34.120.0.7',
        seen: true,
      });
      expect(records.pointing.note).not.toMatch(/ALIAS|AAAA|bare/);
      expect(records.validation).toMatchObject({ type: 'CNAME', seen: false });
    }
  });
});

describe('recordsLeftBehind', () => {
  const validation = {
    name: '_acme-challenge.acme.dev.',
    type: 'CNAME',
    value: 'abc.4.authorize.certificatemanager.goog.',
  };

  it('names the CNAME and the A record to the fixed IP on Google Cloud', () => {
    expect(
      recordsLeftBehind(
        { host: 'acme.dev', validationRecord: validation },
        '34.120.0.7',
        'fixed-ip',
      ),
    ).toEqual([
      validation,
      { name: 'acme.dev', type: 'A', value: '34.120.0.7' },
    ]);
  });

  it('names an ALIAS for a bare name on AWS', () => {
    expect(
      recordsLeftBehind({ host: 'acme.dev', validationRecord: null }, 'x.elb'),
    ).toEqual([{ name: 'acme.dev', type: 'ALIAS', value: 'x.elb' }]);
  });
});

describe('certificatePollDue', () => {
  const row = { certificateRequestedAt: REQUESTED };

  it('asks about once a minute for the first half hour', () => {
    expect(
      certificatePollDue({ ...row, certificateLastPolledAt: null }, at(0)),
    ).toBe(true);
    const polled = at(5 * MINUTE).toISOString();
    expect(
      certificatePollDue(
        { ...row, certificateLastPolledAt: polled },
        at(5 * MINUTE + 30_000),
      ),
    ).toBe(false);
    expect(
      certificatePollDue(
        { ...row, certificateLastPolledAt: polled },
        at(6 * MINUTE),
      ),
    ).toBe(true);
  });

  it('then about every 10 minutes', () => {
    const polled = at(40 * MINUTE).toISOString();
    expect(
      certificatePollDue(
        { ...row, certificateLastPolledAt: polled },
        at(45 * MINUTE),
      ),
    ).toBe(false);
    expect(
      certificatePollDue(
        { ...row, certificateLastPolledAt: polled },
        at(50 * MINUTE),
      ),
    ).toBe(true);
  });

  it('never asks before a certificate was requested', () => {
    expect(
      certificatePollDue(
        { certificateRequestedAt: null, certificateLastPolledAt: null },
        at(0),
      ),
    ).toBe(false);
  });
});

describe('nextCertificateState', () => {
  const row = { certificateRequestedAt: REQUESTED };

  it('waits for DNS until the validation record is seen', () => {
    expect(
      nextCertificateState(row, { status: 'PENDING_VALIDATION' }, false, at(0)),
    ).toEqual({ status: 'waiting-for-dns', issued: false, failure: null });
  });

  it('is checking once the record is seen', () => {
    expect(
      nextCertificateState(row, { status: 'PENDING_VALIDATION' }, true, at(0)),
    ).toEqual({ status: 'checking', issued: false, failure: null });
  });

  it('is issued, still checking until a run attaches it', () => {
    expect(
      nextCertificateState(row, { status: 'ISSUED' }, true, at(0)),
    ).toEqual({ status: 'checking', issued: true, failure: null });
  });

  it("fails in ACM's words", () => {
    expect(
      nextCertificateState(
        row,
        { status: 'FAILED', reason: 'CAA_ERROR' },
        true,
        at(0),
      ),
    ).toEqual({
      status: 'failed',
      issued: false,
      failure: expect.stringContaining('CAA_ERROR') as string,
    });
  });

  it('fails after 72 hours without the record', () => {
    const state = nextCertificateState(
      row,
      { status: 'PENDING_VALIDATION' },
      false,
      at(72 * HOUR),
    );
    expect(state.status).toBe('failed');
    expect(state.failure).toMatch(/72 hours/);
  });
});

describe('nextGoogleCertificateState', () => {
  const row = { certificateRequestedAt: REQUESTED };

  it('waits for DNS while provisioning and the CNAME is not seen', () => {
    expect(
      nextGoogleCertificateState(
        row,
        { state: 'PROVISIONING', reason: null },
        false,
        at(0),
      ),
    ).toEqual({ status: 'waiting-for-dns', issued: false, failure: null });
  });

  it('is checking once the CNAME is seen', () => {
    expect(
      nextGoogleCertificateState(
        row,
        { state: 'PROVISIONING', reason: 'AUTHORIZATION_ISSUE' },
        true,
        at(0),
      ),
    ).toEqual({ status: 'checking', issued: false, failure: null });
  });

  it('is live once active: its map entry already serves it', () => {
    expect(
      nextGoogleCertificateState(
        row,
        { state: 'ACTIVE', reason: null },
        true,
        at(0),
      ),
    ).toEqual({ status: 'live', issued: true, failure: null });
  });

  it("fails in Google's words", () => {
    const state = nextGoogleCertificateState(
      row,
      { state: 'FAILED', reason: 'CAA' },
      true,
      at(0),
    );
    expect(state).toMatchObject({ status: 'failed', issued: false });
    expect(state.failure).toContain('CAA');
    expect(state.failure).toContain('Ask again');
  });

  it('fails after 72 hours still provisioning', () => {
    const state = nextGoogleCertificateState(
      row,
      { state: 'PROVISIONING', reason: null },
      false,
      at(72 * HOUR),
    );
    expect(state.status).toBe('failed');
    expect(state.failure).toMatch(/72 hours/);
  });
});

describe('googleQuotaRefusal', () => {
  it('names the quota and the limit Google reported', () => {
    const refusal = googleQuotaRefusal(
      "Error creating Certificate: googleapi: Error 429: Quota exceeded for quota metric 'Certificates' and limit 'Certificates per project per region' of service 'certificatemanager.googleapis.com' for consumer 'project_number:123456789012'., rateLimitExceeded",
    );
    expect(refusal).toContain('"Certificates per project per region"');
    expect(refusal).toContain('certificatemanager.googleapis.com');
    expect(refusal).toContain('Quotas');
  });

  it('reads a RESOURCE_EXHAUSTED refusal that names its quota and number', () => {
    const refusal = googleQuotaRefusal(
      "Error creating CertificateMapEntry: googleapi: Error 429: RESOURCE_EXHAUSTED: Quota 'CertificateMapEntriesPerMap' exceeded. Limit: 1000.",
    );
    expect(refusal).toContain('"CertificateMapEntriesPerMap"');
    expect(refusal).toContain('1000');
  });

  it('quotes Google when it names no quota', () => {
    expect(
      googleQuotaRefusal('googleapi: Error 429: Quota exceeded.'),
    ).toContain('Quota exceeded.');
  });

  it('is null for any other refusal', () => {
    expect(
      googleQuotaRefusal('googleapi: Error 403: Permission denied'),
    ).toBeNull();
  });
});
