import { ResendSender } from '../../src/mail/senders/resend';

// ResendSender — the Resend SDK is the boundary, mocked here; we assert the
// client construction and what reaches emails.send.

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
const { Resend: resendCtor, __emailsSend: emailsSend } = require('resend') as {
  Resend: jest.Mock;
  __emailsSend: jest.Mock;
};

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

describe('ResendSender', () => {
  const connection = {
    apiKey: 're_test_key',
    fromAddress: 'noreply@example.com',
    toAddresses: ['ada@example.com'],
  };

  beforeEach(() => {
    resendCtor.mockClear();
    emailsSend.mockReset();
    emailsSend.mockResolvedValue({ error: null });
  });

  it('sends through a Resend client built from the connection', async () => {
    const sender = new ResendSender();

    await sender.send(connection, 'Verify your email', '<html>hi</html>');

    expect(resendCtor).toHaveBeenCalledWith('re_test_key');
    expect(emailsSend).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: ['ada@example.com'],
      subject: 'Verify your email',
      html: '<html>hi</html>',
    });
  });

  it('passes no attachments field when there are none', async () => {
    await new ResendSender().send(connection, 'Subject', '<html/>', []);

    const [sent] = emailsSend.mock.calls[0] as [Record<string, unknown>];
    expect(sent).not.toHaveProperty('attachments');
  });

  /**
   * The header logo is an inline image the HTML references as
   * `cid:cloudgate-logo`; Resend makes an attachment inline when it carries
   * a `contentId`, so the `cid` arrives under that name.
   */
  it('sends an inline image with its cid as Resend contentId, and a file as a plain attachment', async () => {
    const logo = Buffer.from('png');
    const pdf = Buffer.from('pdf');

    await new ResendSender().send(connection, 'Invoice', '<html/>', [
      {
        filename: 'cloudgate-logo.png',
        content: logo,
        contentType: 'image/png',
        cid: 'cloudgate-logo',
      },
      { filename: 'invoice.pdf', content: pdf },
    ]);

    expect(emailsSend).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: ['ada@example.com'],
      subject: 'Invoice',
      html: '<html/>',
      attachments: [
        {
          filename: 'cloudgate-logo.png',
          content: logo,
          contentType: 'image/png',
          contentId: 'cloudgate-logo',
        },
        { filename: 'invoice.pdf', content: pdf },
      ],
    });
  });

  /**
   * The SMTP sibling's case: this sender serves transactional mail and
   * the resend notification channel both, so the `Failed to send Resend
   * notification <reason>` it used to compose called a failed password reset a
   * failed notification. Resend's own words reach the caller instead.
   */
  it("a Resend API error result surfaces Resend's own words, named by nothing", async () => {
    emailsSend.mockResolvedValue({ error: { message: 'invalid api key' } });
    const sender = new ResendSender();

    const thrown = await thrownBy(
      sender.send(connection, 'Reset your password', '<html/>'),
    );

    expect(thrown.message).toBe('invalid api key');
    expect(thrown.message).not.toContain('notification');
  });

  it("a rejected send surfaces the SDK's own error, cause intact", async () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.4:443');
    emailsSend.mockRejectedValue(new Error('network down', { cause }));
    const sender = new ResendSender();

    const thrown = await thrownBy(
      sender.send(connection, 'Verify your email', '<html/>'),
    );

    expect(thrown.message).toBe('network down');
    expect(thrown.cause).toBe(cause);
  });
});
