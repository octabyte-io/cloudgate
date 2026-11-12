import { renderBoughtServerPriceChangeEmail } from '../../src/mail/templates/bought-server-price-change';

// The price-change email (ADR-0071, #1400): the pure half of the mail seam,
// asserted on its rendered output.

describe('renderBoughtServerPriceChangeEmail', () => {
  const text = (html: string) => html.replace(/<!-- -->/g, '');

  it('gives a rise its old price, new price and start date, and says it may be deleted before then with no penalty', async () => {
    const rendered = await renderBoughtServerPriceChangeEmail({
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      changes: [
        {
          serverName: 'web-1',
          oldPrice: '$22.00',
          newPrice: '$25.00',
          startsOn: 'Dec 10, 2026',
          rise: true,
        },
      ],
      serversUrl: 'https://console.example.com/servers',
    });

    expect(rendered.subject).toBe(
      'The price of your Server web-1 changes on Dec 10, 2026',
    );
    const body = text(rendered.html);
    expect(body).toContain(
      'web-1: $22.00 a month now, $25.00 a month from Dec 10, 2026.',
    );
    expect(body).toContain(
      'You may delete the Server before its new price starts, with no penalty',
    );
    expect(body).toContain('https://console.example.com/servers');
    // A customer is never told who makes the machines.
    expect(body).not.toMatch(/hetzner/i);
    expect(rendered.subject).not.toMatch(/hetzner/i);
  });

  it('says a fall applies from today, and lists every Server of the Organization repriced', async () => {
    const rendered = await renderBoughtServerPriceChangeEmail({
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      changes: [
        {
          serverName: 'web-1',
          oldPrice: '$30.00',
          newPrice: '$25.00',
          startsOn: 'Nov 10, 2026',
          rise: false,
        },
        {
          serverName: 'db-1',
          oldPrice: '$22.00',
          newPrice: '$25.00',
          startsOn: 'Dec 10, 2026',
          rise: true,
        },
      ],
      serversUrl: 'https://console.example.com/servers',
    });

    expect(rendered.subject).toBe(
      'The prices of your Servers in Hopper Labs are changing',
    );
    const body = text(rendered.html);
    expect(body).toContain(
      'web-1: $25.00 a month instead of $30.00, from today, Nov 10, 2026.',
    );
    expect(body).toContain(
      'db-1: $22.00 a month now, $25.00 a month from Dec 10, 2026.',
    );
    expect(body).toContain('A lower price applies at once');
    expect(body).not.toMatch(/hetzner/i);
  });
});
