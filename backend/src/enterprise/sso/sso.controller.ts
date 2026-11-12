import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../../auth/auth.config';
import { Public } from '../../auth/decorators/public.decorator';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { ValidatedRequest } from '../../auth/auth.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { SettingsService } from '../../settings/settings.service';
import {
  EnforceSsoDto,
  ProvenDomainDto,
  RegisterSsoProviderDto,
  TrustedOriginDto,
  UpdateSsoProviderDto,
  UpdateTrustedOriginDto,
} from './dto/sso.dto';
import { ProvenDomainsService } from './proven-domains.service';
import { SsoService } from './sso.service';

type Session = NonNullable<ValidatedRequest['session']>;

/** The caller's permission ctx in the session's active organization. */
function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

/**
 * SSO routes. Everything but the two sign-in-screen queries requires an
 * owner/admin in an organization with a valid enterprise licence, enforced in
 * the service; those two are public because the login screen asks before
 * anyone is signed in.
 */
@Controller('sso')
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    private readonly settings: SettingsService,
    private readonly provenDomains: ProvenDomainsService,
  ) {}

  @Public()
  @Get('show-sign-in')
  async showSignIn(): Promise<{ enabled: boolean }> {
    return { enabled: await this.sso.showSignInWithSso() };
  }

  @Public()
  @Get('enforce')
  async enforce(): Promise<{ enforced: boolean }> {
    return { enforced: await this.sso.enforceSso() };
  }

  /**
   * Sets the instance's `enforceSSO` flag. The write and its gate live in
   * SettingsService, since the flag is a web-server setting.
   */
  @Patch('enforce')
  setEnforce(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: EnforceSsoDto,
  ) {
    return this.settings.updateEnforceSso(
      toCtx(user, session),
      body.enforceSSO,
    );
  }

  /**
   * The OIDC redirect URI, with `{providerId}` still in it — the console needs
   * it on the Add dialog, where no provider exists yet.
   */
  @Get('redirect-uri')
  redirectUri(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.sso.getRedirectUri(toCtx(user, session));
  }

  @Get('providers')
  listProviders(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.sso.listProviders(toCtx(user, session));
  }

  @Get('trusted-origins')
  getTrustedOrigins(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.sso.getTrustedOrigins(toCtx(user, session));
  }

  /**
   * **`200`, while `POST /sso/providers` below keeps `201`**. Both are
   * noun-shaped collection POSTs, and only one creates: registering a provider
   * inserts a row with an id. A trusted origin is a string appended to a `jsonb`
   * array on the owner's user row — no id, nothing to address, and adding one
   * twice is a no-op — so `201 Created` had nothing to point at.
   */
  @Post('trusted-origins')
  @HttpCode(200)
  addTrustedOrigin(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TrustedOriginDto,
  ) {
    return this.sso.addTrustedOrigin(toCtx(user, session), body.origin);
  }

  @Put('trusted-origins')
  updateTrustedOrigin(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateTrustedOriginDto,
  ) {
    return this.sso.updateTrustedOrigin(
      toCtx(user, session),
      body.oldOrigin,
      body.newOrigin,
    );
  }

  @Delete('trusted-origins')
  removeTrustedOrigin(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TrustedOriginDto,
  ) {
    return this.sso.removeTrustedOrigin(toCtx(user, session), body.origin);
  }

  @Post('providers')
  register(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: RegisterSsoProviderDto,
  ) {
    return this.sso.register(toCtx(user, session), req.headers, body);
  }

  @Get('providers/:providerId')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('providerId') providerId: string,
  ) {
    return this.sso.findOne(toCtx(user, session), providerId);
  }

  @Put('providers/:providerId')
  update(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('providerId') providerId: string,
    @Body() body: UpdateSsoProviderDto,
  ) {
    return this.sso.update(toCtx(user, session), req.headers, {
      ...body,
      providerId,
    });
  }

  @Delete('providers/:providerId')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('providerId') providerId: string,
  ) {
    return this.sso.remove(toCtx(user, session), providerId);
  }

  /**
   * Proven domains (ADR-0051), Hosted only. The domain is the key: one
   * per Organization, and it is what the owner types and publishes a record
   * for.
   */
  @Get('proven-domains')
  listProvenDomains(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.provenDomains.list(toCtx(user, session));
  }

  @Post('proven-domains')
  addProvenDomain(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: ProvenDomainDto,
  ) {
    return this.provenDomains.add(toCtx(user, session), body.domain);
  }

  /** `200`: a check changes the row's state at most, it creates nothing. */
  @Post('proven-domains/:domain/check')
  @HttpCode(200)
  checkProvenDomain(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('domain') domain: string,
  ) {
    return this.provenDomains.check(toCtx(user, session), domain);
  }

  @Delete('proven-domains/:domain')
  removeProvenDomain(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('domain') domain: string,
  ) {
    return this.provenDomains.remove(toCtx(user, session), domain);
  }
}
