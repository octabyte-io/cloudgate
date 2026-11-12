import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthSession } from '../auth/auth.config';
import type { CredentialHandle, ValidatedRequest } from '../auth/auth.service';
import {
  CurrentCredential,
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { RevokeSessionDto } from './dto/revoke-session.dto';
import { TwoFactorPasswordDto, VerifyTwoFactorDto } from './dto/two-factor.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { WhoamiDto } from './dto/whoami.dto';
import { UsersService } from './users.service';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';

type Session = NonNullable<ValidatedRequest['session']>;

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  getProfile(@CurrentUser() user: AuthSession['user']) {
    return this.usersService.getProfile(user.id);
  }

  @Get('me/whoami')
  @ApiOkResponse({
    type: WhoamiDto,
    description:
      'Who this request is made as: the email, the Organization it acts in, ' +
      'and the Personal key it carries (null for a console session). Answers ' +
      'only about the key the request was made with, never another.',
  })
  whoami(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @CurrentCredential() credential: CredentialHandle | undefined,
  ) {
    return this.usersService.whoami(
      user.email,
      session.activeOrganizationId,
      credential,
    );
  }

  @Patch('me')
  @AllowedWhenFrozen('own-account')
  updateProfile(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(req.headers, user.id, body, {
      organizationId: session.activeOrganizationId,
      ip: req.ip,
    });
  }

  @Post('me/2fa/enable')
  @AllowedWhenFrozen('own-account')
  @HttpCode(200)
  async enableTwoFactor(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: TwoFactorPasswordDto,
  ) {
    return forwardAuthCookies(
      await this.usersService.enableTwoFactor(req.headers, body.password),
      res,
    );
  }

  @Post('me/2fa/verify')
  @AllowedWhenFrozen('own-account')
  @HttpCode(200)
  async verifyTwoFactor(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: VerifyTwoFactorDto,
  ) {
    return forwardAuthCookies(
      await this.usersService.verifyTwoFactor(req.headers, body.code),
      res,
    );
  }

  @Post('me/2fa/disable')
  @AllowedWhenFrozen('own-account')
  @HttpCode(200)
  async disableTwoFactor(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: TwoFactorPasswordDto,
  ) {
    return forwardAuthCookies(
      await this.usersService.disableTwoFactor(req.headers, body.password),
      res,
    );
  }
  @Get('me/sessions')
  // Stated by hand because there is no zod DTO to reflect: better-auth owns the
  // session row and `SessionSummary` is a projection of it, not a request shape
  // (the same situation as `listMembers` in organizations.controller.ts).
  // Worth stating anyway — the fields this route publishes are now a closed set,
  // and `token` being absent from it is the point, so the document says
  // so rather than leaving a reader to assume better-auth's row.
  @ApiOkResponse({
    description:
      "The caller's own sessions. Deliberately carries no session token — " +
      'the token is the credential, and revocation is by `id` (ADR-0009).',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'userId', 'createdAt', 'expiresAt'],
        properties: {
          id: { type: 'string' },
          userId: { type: 'string' },
          userAgent: { type: 'string', nullable: true },
          ipAddress: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  })
  listSessions(@Req() req: Request) {
    return this.usersService.listSessions(req.headers);
  }

  @Post('me/api-keys')
  @AllowedWhenFrozen('own-account')
  createApiKey(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateApiKeyDto,
  ) {
    return this.usersService.createApiKey(req.headers, body, {
      userId: user.id,
      organizationId: session.activeOrganizationId,
      ip: req.ip,
    });
  }

  @Get('me/api-keys')
  listApiKeys(@Req() req: Request) {
    return this.usersService.listApiKeys(req.headers);
  }

  @Delete('me/api-keys/:id')
  @AllowedWhenFrozen('own-account')
  deleteApiKey(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @CurrentCredential() credential: CredentialHandle | undefined,
  ) {
    return this.usersService.deleteApiKey(
      req.headers,
      id,
      {
        userId: user.id,
        organizationId: session.activeOrganizationId,
        ip: req.ip,
      },
      credential,
    );
  }

  /**
   * **`@HttpCode(200)` is the point of this route, not decoration**.
   * Nest answers `201 Created` for an undecorated `@Post`, and V02 measured this
   * one doing exactly that — `201` plus better-auth's `{"status":true}` for an
   * operation whose entire effect is deleting a `session` row. The refusals were
   * already right (404 for an unknown *or* a foreign id, deliberately the same
   * answer — see {@link UsersService.revokeSession}), so the success path was the
   * only thing lying.
   *
   * Rejected: leaving it, on the grounds that `client.ts` branches on
   * `response.ok` and so cannot tell. A status code is read by things that are
   * not this console — the brief that found it asserted `200`, and an audit trail
   * that reports a deletion as a creation is wrong whether or not today's caller
   * looks. `204` was also considered and rejected: better-auth's body stays
   * (changing it is a separate contract break), and 204 with a body is a defect.
   *
   * A later sweep then covered the other 195 undecorated `@Post`s on this
   * reasoning.
   */
  @Post('me/sessions/revoke')
  @AllowedWhenFrozen('own-account')
  @HttpCode(200)
  revokeSession(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @Body() body: RevokeSessionDto,
  ) {
    return this.usersService.revokeSession(
      req.headers,
      body.sessionId,
      user.id,
    );
  }
}

/**
 * better-auth rotates the session on some flows (e.g. verify-totp deletes the
 * old session and issues a new cookie) — its Set-Cookie must reach the client.
 */
function forwardAuthCookies<T>(
  result: { headers: Headers; response: T },
  res: Response,
): T {
  const cookies = result.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  return result.response;
}
