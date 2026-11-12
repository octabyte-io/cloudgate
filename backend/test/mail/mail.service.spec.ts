import { ConfigService } from '@nestjs/config';
import { MailService } from '../../src/mail/mail.service';
import { ResendSender } from '../../src/mail/senders/resend';
import { SmtpSender } from '../../src/mail/senders/smtp';
import { renderInvitationEmail } from '../../src/mail/templates';

// The MailService.send(to, template) seam: dispatches to the SMTP or Resend
// sender based on env config (MAIL_PROVIDER). nodemailer / the Resend SDK are
// the boundaries — mocked; the senders themselves run for real.

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));
jest.mock('resend', () => {
  const emailsSend = jest.fn();
  return {
    Resend: jest.fn().mockImplementation(() => ({
      emails: { send: emailsSend },
    })),
    __emailsSend: emailsSend,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodemailer = require('nodemailer') as { createTransport: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Resend: resendCtor, __emailsSend: emailsSend } = require('resend') as {
  Resend: jest.Mock;
  __emailsSend: jest.Mock;
};

const buildService = (env: Record<string, unknown>) =>
  new MailService(new ConfigService(env), new SmtpSender(), new ResendSender());

/**
 * The error a send rejected with. A `send` resolves to `void`, so the error has
 * to come back out of the `catch` rather than off the settled promise.
 */
const thrownBy = async (
  call: Promise<void>,
): Promise<Error & { code?: string }> => {
  try {
    await call;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('the send resolved, so there is no failure to inspect');
};

describe('MailService', () => {
  let sendMail: jest.Mock;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({});
    nodemailer.createTransport.mockReset();
    nodemailer.createTransport.mockReturnValue({ sendMail });
    resendCtor.mockClear();
    emailsSend.mockReset();
    emailsSend.mockResolvedValue({ error: null });
  });

  const rendered = { subject: 'Verify your email', html: '<html>hi</html>' };

  it('MAIL_PROVIDER=smtp sends through nodemailer with the SMTP_* env config', async () => {
    const mail = buildService({
      MAIL_PROVIDER: 'smtp',
      MAIL_FROM_ADDRESS: 'noreply@cloudgate.example.com',
      SMTP_SERVER: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_USERNAME: 'mailer',
      SMTP_PASSWORD: 'hunter2',
    });

    await mail.send('ada@example.com', rendered);

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'mailer', pass: 'hunter2' },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'noreply@cloudgate.example.com',
        to: 'ada@example.com',
        subject: 'Verify your email',
        html: '<html>hi</html>',
      }),
    );
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it('MAIL_PROVIDER=resend sends through the Resend SDK with the API key', async () => {
    const mail = buildService({
      MAIL_PROVIDER: 'resend',
      MAIL_FROM_ADDRESS: 'noreply@cloudgate.example.com',
      RESEND_API_KEY: 're_test_key',
    });

    await mail.send('ada@example.com', rendered);

    expect(resendCtor).toHaveBeenCalledWith('re_test_key');
    expect(emailsSend).toHaveBeenCalledWith({
      from: 'noreply@cloudgate.example.com',
      to: ['ada@example.com'],
      subject: 'Verify your email',
      html: '<html>hi</html>',
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  /**
   * The header logo rides on the rendered email as an inline image,
   * so this seam attaches it on either provider without the caller passing
   * it — once, and beside any file the caller does attach (the invoice PDF).
   */
  describe('the inline header logo', () => {
    const logo = {
      filename: 'cloudgate-logo.png',
      content: Buffer.from('png'),
      contentType: 'image/png',
      cid: 'cloudgate-logo',
    };
    const pdf = { filename: 'invoice.pdf', content: Buffer.from('pdf') };
    const withLogo = { ...rendered, inlineImages: [logo] };

    it('reaches SMTP as an inline attachment, beside the caller’s file', async () => {
      const mail = buildService({
        MAIL_PROVIDER: 'smtp',
        SMTP_SERVER: 'smtp.example.com',
      });

      await mail.send('ada@example.com', withLogo, [pdf]);

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [logo, pdf] }),
      );
    });

    it('reaches Resend as an attachment with a contentId, beside the caller’s file', async () => {
      const mail = buildService({
        MAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key',
      });

      await mail.send('ada@example.com', withLogo, [pdf]);

      expect(emailsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            {
              filename: 'cloudgate-logo.png',
              content: logo.content,
              contentType: 'image/png',
              contentId: 'cloudgate-logo',
            },
            { filename: 'invoice.pdf', content: pdf.content },
          ],
        }),
      );
    });

    it.each([
      ['smtp', { MAIL_PROVIDER: 'smtp', SMTP_SERVER: 'smtp.example.com' }],
      ['resend', { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' }],
    ])(
      'a real rendered email sends its logo exactly once over %s',
      async (_provider, env) => {
        const invitation = await renderInvitationEmail({
          organizationName: 'Acme',
          inviterName: 'Ada',
          role: 'member',
          acceptUrl: 'https://console.example.com/accept-invitation/inv_1',
        });

        await buildService(env).send('ada@example.com', invitation);

        const sent = (sendMail.mock.calls[0] ?? emailsSend.mock.calls[0]) as [
          { attachments: { cid?: string; contentId?: string }[] },
        ];
        const inline = sent[0].attachments.filter(
          (a) => (a.cid ?? a.contentId) === 'cloudgate-logo',
        );
        expect(inline).toHaveLength(1);
      },
    );
  });

  /**
   * Both senders sit under this seam *and* under the notification
   * channels, and they used to flatten every failure into `Failed to send
   * email notification <reason>` — so an invitation that could not be sent
   * reported itself as a failed notification, naming the subsystem an operator
   * would then go and debug. Driven through the real invitation template, on
   * both providers, because the wording came from the sender rather than from
   * anything the caller passed.
   *
   * The sentence naming the invitation belongs to the caller, not here: this
   * service has one above it in every case (`BillingNotificationsService`
   * already composes its own), so a prefix added here would be half of a
   * doubled sentence.
   */
  it.each([
    ['smtp', { MAIL_PROVIDER: 'smtp', SMTP_SERVER: 'smtp.example.com' }],
    ['resend', { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' }],
  ])(
    'an invitation that cannot be sent over %s does not call itself a notification',
    async (_provider, env) => {
      sendMail.mockRejectedValue(new Error('connection refused'));
      emailsSend.mockRejectedValue(new Error('connection refused'));
      const invitation = await renderInvitationEmail({
        organizationName: 'Acme',
        inviterName: 'Ada',
        role: 'member',
        acceptUrl: 'https://console.example.com/accept-invitation/inv_1',
      });

      const thrown = await thrownBy(
        buildService(env).send('ada@example.com', invitation),
      );

      expect(thrown.message).toBe('connection refused');
      expect(thrown.message).not.toContain('notification');
    },
  );

  it('an unset MAIL_PROVIDER surfaces a clear not-configured error', async () => {
    const mail = buildService({});

    await expect(mail.send('ada@example.com', rendered)).rejects.toThrow(
      'Mail is not configured: set MAIL_PROVIDER to "smtp" or "resend"',
    );
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(emailsSend).not.toHaveBeenCalled();
  });
});
