import { SmtpSender } from '../../src/mail/senders/smtp';

// SmtpSender — nodemailer is the boundary, mocked here; we assert what reaches
// createTransport/sendMail.

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodemailer = require('nodemailer') as {
  createTransport: jest.Mock;
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

describe('SmtpSender', () => {
  const connection = {
    smtpServer: 'smtp.example.com',
    smtpPort: 587,
    username: 'mailer',
    password: 'hunter2',
    fromAddress: 'noreply@example.com',
    toAddresses: ['ada@example.com', 'ops@example.com'],
  };

  let sendMail: jest.Mock;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({});
    nodemailer.createTransport.mockReset();
    nodemailer.createTransport.mockReturnValue({ sendMail });
  });

  it('sends through an SMTP transport built from the connection', async () => {
    const sender = new SmtpSender();

    await sender.send(connection, 'Verify your email', '<html>hi</html>');

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'mailer', pass: 'hunter2' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'ada@example.com, ops@example.com',
      subject: 'Verify your email',
      html: '<html>hi</html>',
      textEncoding: 'base64',
      attachments: undefined,
    });
  });

  it('passes attachments through to sendMail', async () => {
    const sender = new SmtpSender();
    const attachments = [
      { filename: 'backup.log', content: Buffer.from('log') },
    ];

    await sender.send(connection, 'Backup', '<html/>', attachments);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments }),
    );
  });

  it('passes an inline image with its cid through, which nodemailer sends inline', async () => {
    const logo = {
      filename: 'cloudgate-logo.png',
      content: Buffer.from('png'),
      contentType: 'image/png',
      cid: 'cloudgate-logo',
    };

    await new SmtpSender().send(connection, 'Verify', '<html/>', [logo]);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [logo] }),
    );
  });

  /**
   * The sender is under transactional mail and under the email
   * notification channel both, so a sentence composed here named the wrong
   * subsystem for half its callers: a failed invitation read as a failed
   * *notification*. The transport's own words reach the caller, and the caller
   * says what it was sending.
   */
  it("a transport failure surfaces the transport's own words, named by nothing", async () => {
    sendMail.mockRejectedValue(new Error('connection refused'));
    const sender = new SmtpSender();

    const thrown = await thrownBy(
      sender.send(
        connection,
        'You are invited to join Acme on Cloudgate',
        '<html/>',
      ),
    );

    expect(thrown.message).toBe('connection refused');
    // An invitation is not a notification, and nothing here knows it is an
    // invitation either.
    expect(thrown.message).not.toContain('notification');
  });

  it('keeps the code and the cause the transport hung on its error', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND smtp.example.com');
    const refused = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
      cause,
    });
    sendMail.mockRejectedValue(refused);
    const sender = new SmtpSender();

    const thrown = await thrownBy(
      sender.send(connection, 'Verify your email', '<html/>'),
    );

    expect(thrown.code).toBe('ECONNREFUSED');
    expect(thrown.cause).toBe(cause);
  });

  it('normalises a transport that rejects with something that is not an error', async () => {
    sendMail.mockRejectedValue('nope');
    const sender = new SmtpSender();

    const thrown = await thrownBy(
      sender.send(connection, 'Verify your email', '<html/>'),
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('Unknown error');
    expect(thrown.cause).toBe('nope');
  });
});
