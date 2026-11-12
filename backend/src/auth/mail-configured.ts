import type { ConfigService } from '@nestjs/config';

/**
 * Whether this instance can send email — `MAIL_PROVIDER` set.
 *
 * One answer for two readers that must not disagree: `auth.module.ts` hands
 * better-auth a sender only when this is true, which is what turns password
 * reset on, and `GET /auth/password-reset-open` tells `/forgot-password` the
 * same fact before anyone types an address into a form that cannot send.
 */
export function canSendMail(config: ConfigService): boolean {
  return Boolean(config.get<string>('MAIL_PROVIDER'));
}
