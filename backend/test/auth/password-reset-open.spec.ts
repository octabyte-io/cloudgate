import type { ConfigService } from '@nestjs/config';
import type { AuthService } from '../../src/auth/auth.service';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { SignUpController } from '../../src/auth/sign-up.controller';

const withMail = (provider: string | undefined) =>
  new SignUpController(
    {} as AuthService,
    {
      get: (key: string) => (key === 'MAIL_PROVIDER' ? provider : undefined),
    } as unknown as ConfigService,
    { isHosted: false } as InstanceMode,
  );

/**
 * `/forgot-password` asks before offering a form whether reset can send
 * anything, by the same test `auth.module.ts` uses to hand better-auth a
 * sender (`canSendMail`), so the screen and the refusal cannot disagree.
 */
describe('SignUpController.passwordResetOpen', () => {
  it('is open when a mail provider is configured', () => {
    expect(withMail('smtp').passwordResetOpen()).toEqual({ open: true });
  });

  it.each([undefined, ''])('is closed when MAIL_PROVIDER is %p', (provider) => {
    expect(withMail(provider).passwordResetOpen()).toEqual({ open: false });
  });
});
