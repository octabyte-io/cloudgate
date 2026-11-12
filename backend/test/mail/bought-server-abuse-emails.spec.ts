import {
  formatDeadline,
  renderAbuseReportEmail,
  renderPaymentDisputedEmail,
} from '../../src/mail/templates/bought-server-abuse';

// The abuse and dispute emails (#1401).
describe('formatDeadline', () => {
  it('prints the deadline in UTC, to the minute', () => {
    expect(formatDeadline(new Date('2026-11-11T09:05:59Z'))).toBe(
      'Nov 11, 2026 at 09:05 UTC',
    );
  });
});

describe('renderAbuseReportEmail', () => {
  it('carries the report line by line, the deadline and how to answer, without naming the provider', async () => {
    const rendered = await renderAbuseReportEmail({
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      report: 'A port scan from 203.0.113.7.\n\nPlease stop it.',
      deadline: new Date('2026-11-11T09:05:00Z'),
    });

    expect(rendered.subject).toBe(
      'Abuse report about Hopper Labs: please answer by Nov 11, 2026 at 09:05 UTC',
    );
    expect(rendered.html).toContain('A port scan from 203.0.113.7.');
    expect(rendered.html).toContain('Please stop it.');
    expect(rendered.html).toContain(
      'Please answer by Nov 11, 2026 at 09:05 UTC, 24 hours from when we sent this.',
    );
    expect(rendered.html).toContain('Reply to this email');
    expect(rendered.html).toContain('Octabyte may suspend Hopper Labs');
    expect(rendered.html).not.toMatch(/hetzner/i);
  });
});

describe('renderPaymentDisputedEmail', () => {
  it('names the Organization, the amount, the reason and its Bought Servers', async () => {
    const rendered = await renderPaymentDisputedEmail({
      userName: 'Ops',
      organizationName: 'Hopper Labs',
      amount: '$25.00',
      reason: 'product_not_received',
      disputeId: 'dp_1',
      boughtServers: ['web-1', 'db-1'],
      operatorUrl: 'https://cloudgate.test/settings/operator',
    });

    expect(rendered.subject).toBe(
      'A payment by Hopper Labs, which has Bought Servers, was disputed',
    );
    expect(rendered.html).toContain('A payment of $25.00 by Hopper Labs');
    expect(rendered.html).toContain('product not received');
    expect(rendered.html).toContain('dp_1');
    expect(rendered.html).toContain('2 Bought Servers: web-1, db-1');
    expect(rendered.html).toContain('Nothing is suspended automatically.');
    expect(rendered.html).toContain('https://cloudgate.test/settings/operator');
    expect(rendered.html).not.toMatch(/hetzner/i);
  });
});
