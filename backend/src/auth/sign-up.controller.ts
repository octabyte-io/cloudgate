import { Controller, Get, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import type { InvitationPreview } from './invitation-preview';
import { canSendMail } from './mail-configured';
import { acceptsUninvitedSignUp } from './sign-up-state';
import type { SignUpState } from './sign-up-state';

/**
 * The one question the sign-up screen has to be able to ask before it renders
 * anything.
 *
 * `@Public()` for the same reason `GET /sso/show-sign-in` is: it is read on the
 * way in, before there is a session to check. It leaks nothing an anonymous
 * caller cannot already establish — `POST /api/auth/sign-up/email` answers the
 * same question with a refusal, only after someone has filled in five fields.
 *
 * Mounted at `/auth` rather than on `AuthController`'s `/api/auth`: that
 * controller is better-auth's handler behind an `@All('*splat')`, so a Cloudgate
 * route inside its path would both read as a better-auth endpoint and depend on
 * Nest matching it ahead of the catch-all.
 */
@Controller('auth')
export class SignUpController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * `open` is whether an uninvited sign-up is accepted now; `state` says which
   * of the four `SignUpState`s that is, because the screen says
   * different things for each: "Set up this instance" and "Already set up"
   * when Self-hosted, "Not open yet" and the public form when Hosted.
   *
   * `turnstileSiteKey` is the Hosted instance's only: the public site
   * key the form renders Cloudflare's Turnstile widget with, whose token the
   * sign-up must carry. Self-hosted has no captcha and sends none.
   */
  @Public()
  @Get('sign-up-open')
  async signUpOpen(): Promise<{
    open: boolean;
    state: SignUpState;
    turnstileSiteKey?: string;
  }> {
    const state = await this.auth.signUpState();
    return {
      open: acceptsUninvitedSignUp(state),
      state,
      ...(this.instanceMode.isHosted
        ? { turnstileSiteKey: this.config.get<string>('TURNSTILE_SITE_KEY') }
        : {}),
    };
  }

  /**
   * Whether an invitation link is still good, read when its page loads
   * rather than after the visitor has filled in a sign-up form. `@Public()`
   * because that visitor has no account yet. Only an open invitation names its
   * Organization and address; any other id answers `open: false` and a code.
   */
  /**
   * Whether password reset works on this instance: it needs an email
   * sender, and `/forgot-password` used to find out only after a submit. Public
   * for the same reason as `sign-up-open` — the person asking is locked out —
   * and it says only what the refusal at submit already says to anyone.
   */
  @Public()
  @Get('password-reset-open')
  passwordResetOpen(): { open: boolean } {
    return { open: canSendMail(this.config) };
  }

  @Public()
  @Get('invitations/:id')
  invitationPreview(@Param('id') id: string): Promise<InvitationPreview> {
    return this.auth.invitationPreview(id);
  }
}
