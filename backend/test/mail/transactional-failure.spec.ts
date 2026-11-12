import { createAuth } from '../../src/auth/auth.config';
import { sendTransactional } from '../../src/mail/transactional-failure';
import type { RenderedEmail } from '../../src/mail/templates';

/**
 * The two senders under `src/mail/senders` used to flatten every failure
 * into `Failed to send email notification <reason>`, so an invitation that
 * could not be sent reported itself as a failed *notification* — the wrong
 * subsystem, and one whose screen has nothing to do with the problem. The
 * senders now report the transport failure and the caller names what it was
 * sending. These pin the naming, at the seam and on the hook better-auth
 * actually calls.
 */
const anEmail: RenderedEmail = { subject: 'Subject', html: '<p>Body</p>' };

/**
 * The error a send rejected with. A send resolves to `void`, so the error has
 * to come back out of the `catch`; the same helper `smtp.sender.spec.ts` uses.
 */
const thrownBy = async (call: Promise<void>): Promise<Error> => {
  try {
    await call;
  } catch (err) {
    return err as Error;
  }
  throw new Error('the send resolved, so there is no failure to inspect');
};

describe('sendTransactional', () => {
  it('names what was being sent, and never calls it a notification', async () => {
    const mailer = {
      send: () =>
        Promise.reject(new Error('Invalid login: 535 Authentication failed')),
    };

    const err = await thrownBy(
      sendTransactional(mailer, 'invitation', 'someone@example.com', anEmail),
    );

    expect(err.message).toBe(
      'Failed to send the invitation email: Invalid login: 535 Authentication failed',
    );
    expect(err.message).not.toContain('notification');
  });

  it('keeps the transport error as the cause, so its code survives', async () => {
    const transport = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const mailer = {
      send: () => Promise.reject(transport),
    };

    const err = await thrownBy(
      sendTransactional(
        mailer,
        'password reset',
        'someone@example.com',
        anEmail,
      ),
    );

    expect(err.message).toBe(
      'Failed to send the password reset email: connect ECONNREFUSED',
    );
    expect(err.cause).toBe(transport);
  });

  it('falls back for a non-Error throw rather than printing [object Object]', async () => {
    const mailer = {
      // A non-Error rejection is the case under test, which is what the
      // rule below would otherwise forbid writing down.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      send: () => Promise.reject({ status: 502 }),
    };

    const err = await thrownBy(
      sendTransactional(mailer, 'invitation', 'someone@example.com', anEmail),
    );

    expect(err.message).toBe(
      'Failed to send the invitation email: Unknown error',
    );
  });
});

describe('createAuth, on the password-reset hook it hands better-auth', () => {
  it('reports a failed reset as a reset and not as a notification', async () => {
    const auth = createAuth(
      {} as never,
      {
        secret: 'a-long-enough-secret-value-for-tests',
        baseURL: 'http://localhost:3000',
        instanceMode: { isHosted: false },
        mail: {
          send: () =>
            Promise.reject(
              new Error('Invalid login: 535 Authentication failed'),
            ),
        },
      } as never,
    );

    const sendResetPassword = (
      auth as unknown as {
        options: {
          emailAndPassword: {
            sendResetPassword: (args: {
              user: { email: string; name: string };
              url: string;
            }) => Promise<void>;
          };
        };
      }
    ).options.emailAndPassword.sendResetPassword;

    const err = await thrownBy(
      sendResetPassword({
        user: { email: 'someone@example.com', name: 'Someone' },
        url: 'http://localhost:3000/reset-password/abc',
      }),
    );

    expect(err.message).toBe(
      'Failed to send the password reset email: Invalid login: 535 Authentication failed',
    );
    expect(err.message).not.toContain('notification');
  });
});
