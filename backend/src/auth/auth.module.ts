import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { trustedProxyRanges } from '../common/config/trust-proxy';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { LicenseService } from '../enterprise/license/license.service';
import { SsoAddressPolicy } from '../enterprise/sso/sso-addresses';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { addressResolverProvider } from '../outbound/outbound-address';
import { createAuth } from './auth.config';
import type { Auth } from './auth.config';
import { AUTH } from './auth.constants';
import { AuthController } from './auth.controller';
import { SsoDialScope } from './sso-dial-scope';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { canSendMail } from './mail-configured';
import { SignUpController } from './sign-up.controller';
import { DeviceLoginController } from './device-login.controller';
import { DeviceLoginService } from './device-login.service';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { UnconfirmedAccountsService } from './unconfirmed-accounts.service';
import {
  CONFIRMATION_EMAIL_CLOCK,
  systemConfirmationEmailClock,
} from './confirmation-email-limit';
import type { ConfirmationEmailClock } from './confirmation-email-limit';
import {
  CLOUDFLARE_SITEVERIFY_URL,
  TURNSTILE_SITEVERIFY_URL,
} from './turnstile';

@Global()
@Module({
  imports: [ConfigModule, MailModule, SchedulingModule],
  controllers: [AuthController, SignUpController, DeviceLoginController],
  providers: [
    {
      provide: AUTH,
      inject: [
        DRIZZLE,
        ConfigService,
        AuditLogService,
        MailService,
        InstanceMode,
        LicenseService,
        TURNSTILE_SITEVERIFY_URL,
        CONFIRMATION_EMAIL_CLOCK,
        SsoAddressPolicy,
      ],
      useFactory: (
        db: DrizzleDB,
        config: ConfigService,
        auditLogs: AuditLogService,
        mail: MailService,
        instanceMode: InstanceMode,
        license: LicenseService,
        siteVerifyURL: string,
        confirmationEmailClock: ConfirmationEmailClock,
        ssoAddresses: SsoAddressPolicy,
      ): Auth =>
        createAuth(db, {
          secret: config.getOrThrow<string>('BETTER_AUTH_SECRET'),
          baseURL: config.get<string>('BETTER_AUTH_URL'),
          // The origins a browser may sign in from, on top of baseURL's own,
          // which better-auth trusts anyway. Without this the only lever a
          // self-hosted instance had was BETTER_AUTH_URL — one origin, and the
          // one every generated link is built from — because the runtime
          // allowlist `resolveTrustedOrigins` merges these with is behind the
          // enterprise licence. The schema has already parsed the
          // comma-separated key into origins and refused any that could not
          // match a request.
          trustedOrigins: config.get<string[]>('TRUSTED_ORIGINS', []),
          // The same TRUST_PROXY that decides Express's `req.ip`, read as the
          // address list better-auth needs before it will believe a forwarded
          // chain. One key rather than two so the two halves cannot be
          // configured to disagree — see common/config/trust-proxy.ts.
          trustedProxies: trustedProxyRanges(config.get<string>('TRUST_PROXY')),
          auditLogs,
          // Read on each sign-up: the Hosted instance opens sign-up only once
          // its Instance organization exists.
          instanceMode,
          // SSO sign-in stops for a provider whose Organization fails it
          // and SCIM's IdP-facing creates and reactivations ask it
          // Asked through the service on each request, so it follows
          // the plan or the key as they change.
          paidFeatures: {
            hasValidLicense: (organizationId) =>
              license.hasValidLicense(organizationId),
          },
          // MAIL_PROVIDER unset means this instance cannot send anything, and
          // MailService would only throw at send time. Handing better-auth no
          // sender at all instead keeps its RESET_PASSWORD_DISABLED refusal,
          // which /forgot-password already renders as an explanation rather
          // than a failure — and leaves the invitation email off, which the
          // invite dialog already covers by handing over the link.
          mail: canSendMail(config) ? mail : undefined,
          // Hosted only; the hosted boot refuses to start without
          // the key (`checkInstanceModeBoot`).
          turnstile: {
            secretKey: config.get<string>('TURNSTILE_SECRET_KEY') ?? '',
            siteVerifyURL,
          },
          confirmationEmailClock,
          // On the Hosted instance a customer's SSO URLs must be public and
          // its trusted origins count only on its own SSO (ADR-0076).
          ssoAddresses,
        }),
    },
    // The port to Cloudflare's Turnstile verification, and the clock the
    // per-address confirmation-email limit reads; e2e replaces both.
    { provide: TURNSTILE_SITEVERIFY_URL, useValue: CLOUDFLARE_SITEVERIFY_URL },
    {
      provide: CONFIRMATION_EMAIL_CLOCK,
      useValue: systemConfirmationEmailClock,
    },
    // Here rather than in SsoModule because the auth hooks ask it too;
    // SsoService injects it through this global module. Names resolve through
    // `ADDRESS_RESOLVER`, which a suite overrides to stay off real DNS.
    SsoAddressPolicy,
    addressResolverProvider,
    SsoDialScope,
    AuthService,
    DeviceLoginService,
    // Hosted only: deletes sign-ups never confirmed within 7 days.
    UnconfirmedAccountsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH, AuthService, SsoAddressPolicy],
})
export class AuthModule {}
