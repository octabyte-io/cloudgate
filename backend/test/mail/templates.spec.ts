import {
  renderBoughtServerChangeRefundedEmail,
  renderBoughtServerRefundedEmail,
  renderBoughtServerSetupFailedEmail,
  renderBoughtServersDeletionEmail,
  renderCustomRolesStoppedEmail,
  renderInvitationEmail,
  renderInvoiceNotificationEmail,
  renderLicenseExpiringEmail,
  renderLapseEmail,
  renderPaymentFailedEmail,
  renderResetPasswordEmail,
  renderStoppedPayingEmail,
  renderSuspensionEmail,
  renderTrialEndingEmail,
  renderTrialStartedEmail,
  renderVerificationEmail,
} from '../../src/mail/templates';
import type { RenderedEmail } from '../../src/mail/templates';
import { renderEventEmail } from '../../src/notifications/events/event-emails';

// React Email templates rendered to { subject, html } — the pure half of the
// mail seam (`src/mail/templates/*`). Senders are tested separately; here we
// assert the rendered output carries the dynamic values.

describe('mail templates', () => {
  it('verification email renders subject and html with the dynamic values', async () => {
    const rendered = await renderVerificationEmail({
      userName: 'Ada',
      verificationUrl: 'https://cloudgate.example.com/verify?token=abc123',
    });

    expect(rendered.subject).toBe('Verify your email');
    // React SSR splits text around expressions with <!-- --> markers, so
    // match the greeting and the interpolated name separately.
    expect(rendered.html).toMatch(/Hello (<!-- -->)?Ada/);
    expect(rendered.html).toContain(
      'https://cloudgate.example.com/verify?token=abc123',
    );
    // It is a full HTML e-mail document, not a fragment.
    expect(rendered.html).toContain('<html');
  });

  it('verification email for a change of email says so, and carries the link', async () => {
    const rendered = await renderVerificationEmail({
      userName: 'Ada',
      verificationUrl: 'https://cloudgate.example.com/verify?token=new456',
      purpose: 'email-change',
    });

    expect(rendered.subject).toBe('Confirm your new email address');
    expect(rendered.html).toContain('keeps its current address');
    expect(rendered.html).not.toContain('thank you for signing up');
    expect(rendered.html).toContain(
      'https://cloudgate.example.com/verify?token=new456',
    );
  });

  it('reset-password email renders subject and html with the dynamic values', async () => {
    const resetUrl =
      'https://cloudgate.example.com/api/auth/reset-password/tok123?callbackURL=https%3A%2F%2Fapp.example.com%2Freset-password';

    const rendered = await renderResetPasswordEmail({
      userName: 'Ada',
      resetUrl,
    });

    expect(rendered.subject).toBe('Reset your password');
    // React SSR splits text around expressions with <!-- --> markers, so
    // match the greeting and the interpolated name separately.
    expect(rendered.html).toMatch(/Hello (<!-- -->)?Ada/);
    expect(rendered.html).toContain(resetUrl);
    // The lifetime the /forgot-password screen already promises — better-auth's
    // `resetPasswordTokenExpiresIn` default of one hour.
    expect(rendered.html).toContain('one hour');
    // It is a full HTML e-mail document, not a fragment.
    expect(rendered.html).toContain('<html');
  });

  it('reset-password email falls back to a neutral greeting when the account has no name', async () => {
    const rendered = await renderResetPasswordEmail({
      userName: '',
      resetUrl: 'https://cloudgate.example.com/api/auth/reset-password/tok123',
    });

    expect(rendered.html).toMatch(/Hello (<!-- -->)?User/);
  });

  it('invitation email names the organization, the inviter and the accept link', async () => {
    const acceptUrl = 'https://console.example.com/accept-invitation/inv_123';

    const rendered = await renderInvitationEmail({
      organizationName: 'Analytical Engines',
      inviterName: 'Grace Hopper',
      role: 'member',
      acceptUrl,
    });

    expect(rendered.subject).toBe(
      'You are invited to join Analytical Engines on Cloudgate',
    );
    expect(rendered.html).toContain('Analytical Engines');
    expect(rendered.html).toContain('Grace Hopper');
    expect(rendered.html).toContain('member');
    // The link is the only thing the invitee can act on, so it appears as the
    // button target and in full as copyable text.
    expect(rendered.html).toContain(acceptUrl);
    // better-auth's `invitationExpiresIn` default, which nothing overrides.
    expect(rendered.html).toContain('48 hours');
    // It is a full HTML e-mail document, not a fragment.
    expect(rendered.html).toContain('<html');
  });

  it('invitation email falls back to the inviter address when they have no name', async () => {
    const rendered = await renderInvitationEmail({
      organizationName: 'Analytical Engines',
      inviterName: '',
      inviterEmail: 'grace@example.com',
      role: 'admin',
      acceptUrl: 'https://console.example.com/accept-invitation/inv_123',
    });

    expect(rendered.html).toContain('grace@example.com');
  });

  describe('suspension emails', () => {
    const base = {
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      billingUrl: 'https://console.example.com/settings/billing',
    };
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");

    it('a suspension gives the reason and says a payment does not lift it', async () => {
      const rendered = await renderSuspensionEmail({
        ...base,
        notice: { kind: 'suspended', reason: 'Abuse of the free tier' },
      });
      expect(rendered.subject).toBe(
        'Hopper Labs has been suspended on Cloudgate',
      );
      expect(text(rendered.html)).toContain(
        'The reason given: Abuse of the free tier',
      );
      expect(text(rendered.html)).toContain(
        'A payment does not lift a suspension',
      );
    });

    it('a lift on a still-lapsed Organization asks for payment; otherwise it does not', async () => {
      const lapsed = await renderSuspensionEmail({
        ...base,
        notice: { kind: 'lifted', stillLapsed: true },
      });
      expect(lapsed.subject).toBe(
        'The suspension of Hopper Labs on Cloudgate has been lifted',
      );
      expect(text(lapsed.html)).toContain('Pay to continue');
      expect(lapsed.html).toContain(base.billingUrl);

      const clear = await renderSuspensionEmail({
        ...base,
        notice: { kind: 'lifted', stillLapsed: false },
      });
      expect(clear.html).not.toContain(base.billingUrl);
    });
  });

  describe('the Bought Server setup-failed email to Operators', () => {
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");

    it('names the Server, its Organization and the failure, and says nothing was refunded', async () => {
      const rendered = await renderBoughtServerSetupFailedEmail({
        userName: 'Ops',
        organizationName: 'Hopper Labs',
        serverName: 'web-1',
        serverId: 'abc123',
        failure: 'apt-get exited 100',
        operatorUrl: 'https://console.example.com/settings/operator',
      });

      expect(rendered.subject).toBe(
        "First setup failed on Hopper Labs's Bought Server web-1",
      );
      const body = text(rendered.html);
      expect(body).toContain(
        'The first Setup run on web-1 (abc123), a Bought Server of Hopper Labs, failed: apt-get exited 100',
      );
      expect(body).toContain('Nothing was refunded');
      expect(rendered.html).toContain(
        'https://console.example.com/settings/operator',
      );
      // The provider is never named, in any Bought Server email.
      expect(body.toLowerCase()).not.toContain('hetzner');
      // Its footer says whom it went to: the Operators, not a customer's admins.
      expect(body).toContain(
        'This is an automated email to the Operators of this Cloudgate instance',
      );
      expect(body).not.toContain('every owner and admin, and');
    });
  });

  describe('the footer of an owner-only email', () => {
    it('says it goes to every owner, never to the admins', async () => {
      const rendered = await renderBoughtServerRefundedEmail({
        userName: 'Grace',
        organizationName: 'Hopper Labs',
        serverName: 'web-1',
        amount: '$12.34',
        serversUrl: 'https://console.example.com/servers',
      });

      const body = rendered.html.replace(/&#x27;/g, "'");
      expect(body).toContain(
        'It goes to every owner, and cannot be turned off.',
      );
      expect(body).not.toContain('owner and admin');
    });
  });

  describe('lapse emails', () => {
    const base = {
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      billingUrl: 'https://console.example.com/settings/billing',
    };
    // React SSR escapes the apostrophe and splits text around expressions.
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");

    it('the 3-day warning names the day Stripe stops retrying and links to billing', async () => {
      const rendered = await renderLapseEmail({
        ...base,
        notice: { kind: 'lapse-warning', lapsesOn: 'Mar 15, 2026' },
      });
      expect(rendered.subject).toBe(
        '3 days left to pay for Hopper Labs on Cloudgate',
      );
      expect(text(rendered.html)).toContain('stops retrying on Mar 15, 2026');
      expect(rendered.html).toContain(base.billingUrl);
    });

    it('a lapse says frozen and names the deletion day; a cancel says the plan ended', async () => {
      const lapsed = await renderLapseEmail({
        ...base,
        notice: { kind: 'lapsed', deletesOn: 'Apr 01, 2026' },
      });
      expect(lapsed.subject).toBe(
        'Hopper Labs is frozen: your Cloudgate payment failed',
      );
      expect(text(lapsed.html)).toContain('deleted on Apr 01, 2026');
      expect(text(lapsed.html)).toContain('Pay to continue');

      const ended = await renderLapseEmail({
        ...base,
        notice: { kind: 'plan-ended', deletesOn: 'Apr 01, 2026' },
      });
      expect(ended.subject).toBe(
        'Your Cloudgate plan for Hopper Labs has ended',
      );
      expect(text(ended.html)).not.toContain('payment');
      expect(text(ended.html)).toContain(
        'Nothing on your Servers or in your clouds is touched',
      );
    });

    it('an ended Enterprise agreement says so, not that a cancellation took effect', async () => {
      const ended = await renderLapseEmail({
        ...base,
        notice: {
          kind: 'plan-ended',
          cause: 'enterprise',
          deletesOn: 'Apr 01, 2026',
        },
      });

      expect(ended.subject).toBe(
        'Your Cloudgate plan for Hopper Labs has ended',
      );
      expect(text(ended.html)).toContain(
        "Hopper Labs's Enterprise agreement with Octabyte has ended",
      );
      expect(text(ended.html)).not.toContain('cancellation');
      expect(text(ended.html)).toContain('deleted on Apr 01, 2026');
      expect(text(ended.html)).toContain('Pay to continue');
    });

    it('the 7-day warning and the deleted email', async () => {
      const warning = await renderLapseEmail({
        ...base,
        notice: { kind: 'deletion-warning', deletesOn: 'Apr 01, 2026' },
      });
      expect(warning.subject).toBe(
        'Hopper Labs will be deleted from Cloudgate on Apr 01, 2026',
      );

      const deleted = await renderLapseEmail({
        ...base,
        notice: { kind: 'deleted' },
      });
      expect(deleted.subject).toBe(
        'Hopper Labs has been deleted from Cloudgate',
      );
      expect(deleted.html).not.toContain(base.billingUrl);
      expect(text(deleted.html)).toContain(
        'Nothing on your Servers or in your clouds was touched',
      );
    });

    /**
     * To an Attached Organization's owners and admins (ADR-0059):
     * worded "the plan <Paying Organization> pays for this Organization
     * with…", and never asking them to fix a payment that is not theirs.
     */
    describe("to an Attached Organization, about its Paying Organization's plan", () => {
      const attached = {
        ...base,
        organizationName: 'Turing Works',
        payingOrganizationName: 'Hopper Labs',
      };
      const PLAN = 'the plan Hopper Labs pays for this Organization with';

      it('the 3-day warning', async () => {
        const rendered = await renderLapseEmail({
          ...attached,
          notice: { kind: 'lapse-warning', lapsesOn: 'Mar 15, 2026' },
        });
        expect(rendered.subject).toBe(
          '3 days left on the plan Hopper Labs pays for Turing Works with',
        );
        expect(text(rendered.html)).toContain(PLAN);
        expect(text(rendered.html)).toContain('stops retrying on Mar 15, 2026');
        expect(text(rendered.html)).toContain(
          "Only Hopper Labs's owners and admins can update its payment method.",
        );
        expect(text(rendered.html)).not.toContain('Update payment method');
      });

      it('the lapse, after a failed payment and after each kind of end', async () => {
        const lapsed = await renderLapseEmail({
          ...attached,
          notice: { kind: 'lapsed', deletesOn: 'Apr 01, 2026' },
        });
        expect(lapsed.subject).toBe(
          'Turing Works is frozen: the plan Hopper Labs pays for it with has lapsed',
        );
        expect(text(lapsed.html)).toContain(PLAN);
        expect(text(lapsed.html)).toContain(
          'Unless Hopper Labs pays again, Turing Works',
        );
        expect(text(lapsed.html)).toContain(
          'deleted on Apr 01, 2026, together with Hopper Labs',
        );

        for (const [cause, because] of [
          [undefined, 'Hopper Labs cancelled it.'],
          [
            'enterprise',
            "Hopper Labs's Enterprise agreement with Octabyte has ended.",
          ],
          ['trial', "Hopper Labs's free trial ended without a charge."],
        ] as const) {
          const ended = await renderLapseEmail({
            ...attached,
            notice: { kind: 'plan-ended', deletesOn: 'Apr 01, 2026', cause },
          });
          expect(ended.subject).toBe(
            'The plan Hopper Labs pays for Turing Works with has ended',
          );
          expect(text(ended.html)).toContain(
            `The plan Hopper Labs pays for this Organization with has ended: ${because}`,
          );
        }
      });

      it('the 7-day warning and the deleted email', async () => {
        const warning = await renderLapseEmail({
          ...attached,
          notice: { kind: 'deletion-warning', deletesOn: 'Apr 01, 2026' },
        });
        expect(warning.subject).toBe(
          'Turing Works will be deleted from Cloudgate on Apr 01, 2026',
        );
        expect(text(warning.html)).toContain(
          `Turing Works has been frozen since ${PLAN} ended.`,
        );

        const deleted = await renderLapseEmail({
          ...attached,
          notice: { kind: 'deleted' },
        });
        expect(deleted.subject).toBe(
          'Turing Works has been deleted from Cloudgate',
        );
        expect(text(deleted.html)).toContain(
          'Turing Works was deleted together with Hopper Labs, 30 days after the plan Hopper Labs paid for this Organization with ended.',
        );
      });
    });
  });

  /**
   * "Stop paying for it" (ADR-0059): to the detached Organization's
   * owner, who alone can now pay for it.
   */
  describe('the "stopped paying" email', () => {
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");

    it('says who stopped paying, that it is frozen and has left the plan, when it is deleted unless its owner pays, and that there is no free trial', async () => {
      const rendered = await renderStoppedPayingEmail({
        userName: 'Alan',
        organizationName: 'Turing Works',
        payingOrganizationName: 'Hopper Labs',
        billingUrl: 'https://console.example.com/settings/billing',
        deletesOn: 'Dec 08, 2026',
      });

      expect(rendered.subject).toBe(
        'Turing Works is frozen: Hopper Labs has stopped paying for it',
      );
      const body = text(rendered.html);
      expect(body).toMatch(/Hello (<!-- -->)?Alan/);
      expect(body).toContain(
        'Hopper Labs has stopped paying for Turing Works. It has left the plan Hopper Labs pays for, and its Servers and Cloud Environments no longer count against it.',
      );
      expect(body).toContain('Turing Works is now frozen');
      expect(body).toContain(
        'Unless you pay, Turing Works and everything Cloudgate stores for it (secrets, keys, cloud credentials, configs and logs) will be deleted on Dec 08, 2026.',
      );
      expect(body).toContain(
        'You can pay for Turing Works yourself, without a free trial, unless you already own another Organization that pays for itself.',
      );
      expect(body).toContain('Pay to continue');
      expect(rendered.html).toContain(
        'https://console.example.com/settings/billing',
      );
    });
  });

  describe('the Bought Server refunded email', () => {
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");
    const props = {
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      serverName: 'web-1',
      amount: '$12.34',
      serversUrl: 'https://console.example.com/servers',
    };

    it('says the Server could not be made, that the payment was refunded in full, and that nothing more is charged', async () => {
      const rendered = await renderBoughtServerRefundedEmail(props);

      expect(rendered.subject).toBe(
        'Your Server web-1 could not be created, so your payment was refunded',
      );
      const body = text(rendered.html);
      expect(body).toMatch(/Hello (<!-- -->)?Grace/);
      expect(body).toContain(
        'Cloudgate could not create the Server web-1 for Hopper Labs after you paid for it, and tried twice.',
      );
      expect(body).toContain(
        'Your payment of $12.34 was refunded in full to the card it was charged to.',
      );
      expect(body).toContain(
        'web-1 is removed from your Servers, and nothing more will be charged for it.',
      );
      expect(rendered.html).toContain('https://console.example.com/servers');
    });

    it('says the payment was refunded without an amount when none is known', async () => {
      const rendered = await renderBoughtServerRefundedEmail({
        ...props,
        amount: null,
      });

      expect(text(rendered.html)).toContain(
        'Your payment was refunded in full to the card it was charged to.',
      );
    });

    it('never names the provider', async () => {
      const rendered = await renderBoughtServerRefundedEmail(props);

      expect(rendered.subject).not.toMatch(/hetzner/i);
      expect(rendered.html).not.toMatch(/hetzner/i);
    });
  });

  describe('renderBoughtServersDeletionEmail', () => {
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");
    const props = {
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      serverNames: ['web-1', 'db-1'],
      billingUrl: 'https://console.example.com/settings/billing',
      serversUrl: 'https://console.example.com/servers',
    };
    const notices = [
      { kind: 'payment-failed', deletesOn: 'Nov 17, 2026' },
      {
        kind: 'day-before',
        deletesOn: 'Nov 17, 2026',
        dueTo: 'payment-failed',
      },
      { kind: 'deleted', deletedOn: 'Nov 17, 2026', dueTo: 'payment-failed' },
      { kind: 'suspended', deletesOn: 'Nov 17, 2026' },
      { kind: 'cancel', deletesOn: 'Nov 17, 2026' },
      { kind: 'day-before', deletesOn: 'Nov 17, 2026', dueTo: 'suspension' },
      { kind: 'deleted', deletedOn: 'Nov 17, 2026', dueTo: 'suspension' },
      { kind: 'deleted', deletedOn: 'Nov 17, 2026', dueTo: 'lapse' },
    ] as const;

    it.each(notices)(
      '$kind gives the date and says the data and backups go with the machine',
      async (notice) => {
        const rendered = await renderBoughtServersDeletionEmail({
          ...props,
          notice,
        });
        const body = text(rendered.html);

        expect(body).toMatch(/Hello (<!-- -->)?Grace/);
        expect(body).toContain('Nov 17, 2026');
        expect(body).toMatch(/data and (its|their) backups/);
        expect(body).toMatch(/cannot be (undone|brought back)/);
        expect(body).toContain('web-1');
        expect(body).toContain('db-1');
      },
    );

    it.each(notices)('$kind never names the provider', async (notice) => {
      const rendered = await renderBoughtServersDeletionEmail({
        ...props,
        notice,
      });

      expect(rendered.subject).not.toMatch(/hetzner/i);
      expect(rendered.html).not.toMatch(/hetzner/i);
    });

    it('asks for the open invoice to be paid before the deletion', async () => {
      const rendered = await renderBoughtServersDeletionEmail({
        ...props,
        notice: notices[0],
      });

      expect(rendered.subject).toBe(
        'Your Servers for Hopper Labs will be deleted on Nov 17, 2026 unless you pay',
      );
      expect(rendered.html).toContain(
        'https://console.example.com/settings/billing',
      );
    });

    it('says the deleted records stay listed with their Services', async () => {
      const rendered = await renderBoughtServersDeletionEmail({
        ...props,
        notice: notices[2],
      });

      expect(rendered.subject).toBe(
        'Your Servers for Hopper Labs were deleted',
      );
      expect(text(rendered.html)).toContain(
        'still listed in Servers, marked Deleted, with the Services it carried',
      );
    });

    it('a suspension says lifting it, not paying, keeps them', async () => {
      const rendered = await renderBoughtServersDeletionEmail({
        ...props,
        notice: { kind: 'suspended', deletesOn: 'Nov 17, 2026' },
      });

      expect(rendered.subject).toBe(
        'Your Servers for Hopper Labs will be deleted on Nov 17, 2026 unless the suspension is lifted',
      );
      expect(text(rendered.html)).toContain('Paying does not lift it');
      expect(rendered.html).not.toContain('Pay the open invoice');
    });

    it('a cancel names the day the plan ends', async () => {
      const rendered = await renderBoughtServersDeletionEmail({
        ...props,
        notice: { kind: 'cancel', deletesOn: 'Nov 17, 2026' },
      });

      expect(rendered.subject).toBe(
        'Your Servers for Hopper Labs will be deleted on Nov 17, 2026',
      );
      expect(text(rendered.html)).toContain(
        "Hopper Labs's plan is cancelled and ends on Nov 17, 2026",
      );
    });

    it('the deletion says what caused it', async () => {
      const said = async (dueTo: 'payment-failed' | 'suspension' | 'lapse') =>
        text(
          (
            await renderBoughtServersDeletionEmail({
              ...props,
              notice: { kind: 'deleted', deletedOn: 'Nov 17, 2026', dueTo },
            })
          ).html,
        );

      expect(await said('payment-failed')).toContain(
        "Hopper Labs's invoice was not paid, so on Nov 17, 2026",
      );
      expect(await said('suspension')).toContain(
        'Hopper Labs stayed suspended, so on Nov 17, 2026',
      );
      expect(await said('lapse')).toContain(
        "Hopper Labs's plan ended, so on Nov 17, 2026",
      );
    });
  });

  describe('free-trial emails', () => {
    const text = (html: string) =>
      html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'");
    const facts = {
      userName: 'Grace',
      organizationName: 'Hopper Labs',
      planLabel: 'Business',
      addOns: 2,
      monthly: '$45.00',
      endsOn: 'Dec 05, 2026',
      billingUrl: 'https://console.example.com/settings/billing',
    };

    it('"trial started" names the 30 days, the end, the plan and price after, and how to cancel', async () => {
      const started = await renderTrialStartedEmail(facts);
      expect(started.subject).toBe(
        'Your 30-day Cloudgate free trial for Hopper Labs has started',
      );
      const body = text(started.html);
      expect(body).toContain('30-day free trial of the Business plan');
      expect(body).toContain('ends on Dec 05, 2026');
      expect(body).toContain(
        'charged $45.00 per month for Business with 2 Add-ons',
      );
      expect(body).toContain('Cancel trial');
      expect(body).not.toContain('Stripe');
      expect(started.html).toContain(facts.billingUrl);
    });

    it('"trial ends in 7 days" names the date, the amount held now and links to Billing', async () => {
      const ending = await renderTrialEndingEmail({
        ...facts,
        addOns: 1,
        monthly: null,
      });
      expect(ending.subject).toBe(
        'Your Cloudgate free trial for Hopper Labs ends in 7 days',
      );
      const body = text(ending.html);
      expect(body).toContain('ends on Dec 05, 2026');
      expect(body).toContain('Business with 1 Add-on,');
      expect(body).toContain('the Billing page shows the amount');
      expect(ending.html).toContain(facts.billingUrl);
    });

    it('a trial that ended uncharged says so, never "lapsed"', async () => {
      const ended = await renderLapseEmail({
        userName: 'Grace',
        organizationName: 'Hopper Labs',
        billingUrl: facts.billingUrl,
        notice: {
          kind: 'plan-ended',
          cause: 'trial',
          deletesOn: 'Jan 04, 2027',
        },
      });
      expect(ended.subject).toBe(
        'Your Cloudgate free trial for Hopper Labs has ended',
      );
      const body = text(ended.html);
      expect(body).toContain('free trial has ended and you were not charged');
      expect(body).not.toContain('lapsed');
      expect(body).toContain('deleted on Jan 04, 2027');
    });

    it('the first charge after the trial says the trial has ended', async () => {
      const invoice = {
        userName: 'Grace',
        invoiceNumber: 'INV-1',
        amountPaid: '$15.00',
        currency: 'usd',
        date: 'Dec 05, 2026',
        hostedInvoiceUrl: 'https://invoice.stripe.test/INV-1',
        hasPdf: false,
      };
      const first = await renderInvoiceNotificationEmail({
        ...invoice,
        trialEnded: true,
      });
      expect(text(first.html)).toContain('Your free trial has ended');
      const later = await renderInvoiceNotificationEmail(invoice);
      expect(text(later.html)).not.toContain('free trial');
    });
  });

  // The owner email 14 and 3 days before a Self-hosted license expires.
  describe('renderLicenseExpiringEmail', () => {
    const input = {
      userName: 'Grace',
      organizationName: 'Acme',
      expiresOn: '2027-03-15 00:00:00 UTC',
      stopped: ['SSO sign-in', 'Custom roles'],
      licenseUrl: 'https://cloudgate.example.com/settings/license',
    };

    it('names the organization, the date on the key and what stops then', async () => {
      const rendered = await renderLicenseExpiringEmail(input);

      expect(rendered.subject).toBe(
        'The enterprise license for Acme expires on 2027-03-15 00:00:00 UTC',
      );
      expect(rendered.html).toContain('Hello <!-- -->Grace');
      expect(rendered.html).toContain('SSO sign-in; Custom roles');
      expect(rendered.html).toContain(
        'https://cloudgate.example.com/settings/license',
      );
      // Only validUntil: the grace days inside it are never named (ADR-0054).
      expect(rendered.html).not.toMatch(/grace period|14 extra days/i);
    });

    it('leaves the button out when the instance has no address', async () => {
      const rendered = await renderLicenseExpiringEmail({
        ...input,
        licenseUrl: null,
      });

      expect(rendered.html).not.toContain('Open the License page');
    });
  });

  describe('renderCustomRolesStoppedEmail', () => {
    const input = {
      userName: 'Grace',
      organizationName: 'Acme',
      cause: 'starter' as const,
      holders: [
        { name: 'Ida Rhodes', email: 'ida@example.com', role: 'auditor' },
        { name: 'Alan Kay', email: 'alan@example.com', role: 'deployer' },
      ],
      membersUrl: 'https://cloudgate.example.com/settings/members',
    };
    const text = (html: string) => html.replace(/<!-- -->/g, '');

    it('names every holder and their role, and links to the Members page', async () => {
      const rendered = await renderCustomRolesStoppedEmail(input);

      expect(rendered.subject).toBe(
        '2 members of Acme are on custom roles that no longer work',
      );
      const html = text(rendered.html);
      expect(html).toContain(
        'Acme has moved from the Business plan to Starter.',
      );
      expect(html).toContain(
        'Ida Rhodes (ida@example.com), role &quot;auditor&quot;',
      );
      expect(html).toContain(
        'Alan Kay (alan@example.com), role &quot;deployer&quot;',
      );
      expect(html).toContain('Nobody was moved to another role automatically');
      expect(html).toContain('Change their role');
      expect(html).toContain('https://cloudgate.example.com/settings/members');
    });

    it('says why Business ended: a lapse, or the end of an Enterprise agreement', async () => {
      const ended = await renderCustomRolesStoppedEmail({
        ...input,
        cause: 'ended',
        holders: input.holders.slice(0, 1),
      });
      expect(ended.subject).toBe(
        '1 member of Acme is on a custom role that no longer works',
      );
      expect(text(ended.html)).toContain(
        'Acme is no longer on the Business plan.',
      );

      const enterprise = await renderCustomRolesStoppedEmail({
        ...input,
        cause: 'enterprise',
      });
      expect(text(enterprise.html)).toContain(
        'Acme&#x27;s Enterprise agreement with Octabyte has ended.',
      );
    });
  });

  describe('renderBoughtServerChangeRefundedEmail', () => {
    it('says what could not be done, the full refund, and that the Server is as it was', async () => {
      const rendered = await renderBoughtServerChangeRefundedEmail({
        userName: 'Grace',
        serverName: 'web-1',
        attempted: 'turn on backups for web-1',
        amount: '$4.12',
        serverUrl: 'https://console.example.com/servers/abc/settings',
      });

      expect(rendered.subject).toBe(
        "We couldn't turn on backups for web-1, so the payment was refunded",
      );
      const text = rendered.html.replace(/<!-- -->/g, '');
      expect(text).toContain(
        'We tried twice to turn on backups for web-1, and it could not be done.',
      );
      expect(text).toContain(
        'The $4.12 paid for it was refunded in full to the card it was charged to.',
      );
      expect(text).toContain('web-1 is as it was before the change');
      expect(text).toContain(
        'https://console.example.com/servers/abc/settings',
      );
      // A customer is never told who makes the machines.
      expect(text).not.toMatch(/hetzner/i);
    });

    it('still says the refund was in full when no amount is known', async () => {
      const rendered = await renderBoughtServerChangeRefundedEmail({
        userName: 'Grace',
        serverName: 'web-1',
        attempted: 'turn on backups for web-1',
        amount: null,
        serverUrl: 'https://console.example.com/servers/abc/settings',
      });

      expect(rendered.html.replace(/<!-- -->/g, '')).toContain(
        'Its payment was refunded in full to the card it was charged to.',
      );
    });

    it('says a change paid from the account credit went back to that credit, not to a card', async () => {
      const rendered = await renderBoughtServerChangeRefundedEmail({
        userName: 'Grace',
        serverName: 'web-1',
        attempted: 'turn on backups for web-1',
        amount: '$4.12',
        refundedTo: 'balance',
        serverUrl: 'https://console.example.com/servers/abc/settings',
      });

      const text = rendered.html.replace(/<!-- -->/g, '');
      expect(text).toContain(
        'The $4.12 paid for it came from your account&#x27;s credit, so it was credited back to that credit in full',
      );
      expect(text).not.toContain('card');
    });
  });

  /**
   * The logo in the header: an inline CID image, never a remote URL —
   * a Self-hosted instance may have no internet access or no address of its
   * own, and Gmail and Outlook render no SVG. So every rendered email carries
   * the PNG it references, exactly once, and the header still reads
   * "Cloudgate" when images are blocked.
   */
  describe('the logo in the header', () => {
    const org = 'Acme';
    const url = 'https://console.example.com/settings/billing';
    const trial = {
      userName: 'Grace',
      organizationName: org,
      planLabel: 'Business',
      addOns: 0,
      monthly: '$25.00',
      endsOn: 'Dec 05, 2026',
      billingUrl: url,
    };
    const invoice = {
      userName: 'Grace',
      invoiceNumber: 'INV-1',
      currency: 'usd',
      date: 'Nov 06, 2026',
      hostedInvoiceUrl: url,
    };
    const renders: [string, () => Promise<RenderedEmail | null>][] = [
      [
        'verification',
        () =>
          renderVerificationEmail({ userName: 'Ada', verificationUrl: url }),
      ],
      [
        'reset password',
        () => renderResetPasswordEmail({ userName: 'Ada', resetUrl: url }),
      ],
      [
        'invitation',
        () =>
          renderInvitationEmail({
            organizationName: org,
            inviterName: 'Ada',
            role: 'member',
            acceptUrl: url,
          }),
      ],
      [
        'invoice',
        () =>
          renderInvoiceNotificationEmail({
            ...invoice,
            amountPaid: '$25.00',
            hasPdf: false,
          }),
      ],
      [
        'payment failed',
        () => renderPaymentFailedEmail({ ...invoice, amountDue: '$25.00' }),
      ],
      [
        'lapse',
        () =>
          renderLapseEmail({
            userName: 'Grace',
            organizationName: org,
            billingUrl: url,
            notice: { kind: 'deleted' },
          }),
      ],
      [
        'suspension',
        () =>
          renderSuspensionEmail({
            userName: 'Grace',
            organizationName: org,
            billingUrl: url,
            notice: { kind: 'suspended', reason: 'Abuse' },
          }),
      ],
      [
        'custom roles stopped',
        () =>
          renderCustomRolesStoppedEmail({
            userName: 'Grace',
            organizationName: org,
            cause: 'ended',
            holders: [{ name: 'Ida', email: 'ida@example.com', role: 'x' }],
            membersUrl: url,
          }),
      ],
      [
        'license expiring',
        () =>
          renderLicenseExpiringEmail({
            userName: 'Grace',
            organizationName: org,
            expiresOn: '2027-03-15',
            stopped: ['SSO sign-in'],
            licenseUrl: null,
          }),
      ],
      ['trial started', () => renderTrialStartedEmail(trial)],
      ['trial ending', () => renderTrialEndingEmail(trial)],
      [
        'notification',
        () =>
          renderEventEmail({
            type: 'app-deploy',
            projectName: 'shop',
            applicationName: 'storefront',
            applicationType: 'application',
            environmentName: 'production',
            domains: [],
          }),
      ],
    ];

    it.each(renders)(
      'the %s email shows the logo as an inline cid: image with alt text, and carries it once',
      async (_name, renderIt) => {
        const rendered = await renderIt();
        if (!rendered) throw new Error('rendered nothing');

        const images = rendered.html.match(/<img[^>]*>/g) ?? [];
        expect(images).toHaveLength(1);
        const [img] = images;
        expect(img).toContain('src="cid:cloudgate-logo"');
        expect(img).toContain('alt="Cloudgate"');
        expect(img).toMatch(/width="\d+"/);
        expect(img).toMatch(/height="\d+"/);
        expect(img).toContain('display:block');
        expect(rendered.html).not.toMatch(/src="https?:/);
        // The wordmark is kept, so the header reads with images blocked.
        expect(rendered.html).toMatch(/>Cloudgate<\/h1>/);

        expect(rendered.inlineImages).toHaveLength(1);
        const [logo] = rendered.inlineImages ?? [];
        expect(logo.cid).toBe('cloudgate-logo');
        expect(logo.contentType).toBe('image/png');
        expect(logo.filename).toMatch(/\.png$/);
        // A PNG, not an SVG: Gmail and Outlook render no SVG.
        expect(logo.content.subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
      },
    );

    it('the dark transactional header and the light notification header use different variants', async () => {
      const transactional = await renderResetPasswordEmail({
        userName: 'Ada',
        resetUrl: url,
      });
      const notification = await renderEventEmail({
        type: 'app-deploy',
        projectName: 'shop',
        applicationName: 'storefront',
        applicationType: 'application',
        environmentName: 'production',
        domains: [],
      });

      expect(transactional.inlineImages?.[0].content).not.toEqual(
        notification?.inlineImages?.[0].content,
      );
    });
  });
});
