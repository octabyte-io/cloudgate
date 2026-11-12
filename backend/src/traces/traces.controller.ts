import {
  All,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthSession } from '../auth/auth.config';
import type { CredentialHandle, ValidatedRequest } from '../auth/auth.service';
import {
  CurrentCredential,
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { PutTracesDto, TracesServiceDto } from './dto/traces.dto';
import { TracesService } from './traces.service';

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
 * A Service's traces setting (ADR-0028): read it, and set it — on or
 * off, and its retention. The write is `service: ['update']` and the read
 * `service: ['read']`, here for the role and again in the service for the
 * entitlement to the one Service. The Service's id is the path parameter, so
 * the audit row's `resourceId` is the Service, and its kind the `serviceType`
 * query parameter. Every write is audited under `traces`
 * (`KIND_BY_SEGMENT`). No MCP tool reaches any of it.
 */
@Controller('traces')
export class TracesController {
  constructor(private readonly traces: TracesService) {}

  @Get(':serviceId')
  @RequirePermission('service', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceId') serviceId: string,
    @Query() query: TracesServiceDto,
  ) {
    return this.traces.get(toCtx(user, session), query.serviceType, serviceId);
  }

  /**
   * Where the console frames the Service's Trace store for this caller: its
   * UI's base path under a frame token, and when that token expires
   * (ADR-0075). `service: ['read']` here and the entitlement in the service,
   * the check every framed request re-runs.
   */
  @Get(':serviceId/frame')
  @RequirePermission('service', 'read')
  frame(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @CurrentCredential() credential: CredentialHandle | undefined,
    @Param('serviceId') serviceId: string,
  ) {
    if (!credential) throw new ForbiddenException('No credential');
    return this.traces.frame(toCtx(user, session), credential, serviceId);
  }

  /**
   * The Service's Trace store's UI and query API, proxied for a frame: every
   * path under `traceStoreFramePath`, forwarded to the store with the base
   * path it was configured with (`traceStoreBasePath`), and served sandboxed
   * (ADR-0075).
   *
   * **`@Public()` because the frame's requests carry no session**: the frame
   * is sandboxed into an opaque origin, so they are cross-site and the
   * `SameSite=Lax` cookie stays behind. The token in the path is their
   * credential, and the service checks it, the credential it was minted for,
   * and `service: ['read']` with the entitlement, as that Member, before
   * anything is forwarded. The route-permission census names that gate.
   *
   * `@All` so one route serves the UI's every method; the service forwards
   * the reads and refuses the rest. The audit census names the route as a read
   * the interceptor does not record (`NOT_RECORDED_ROUTES`). The response is
   * written here, not returned, so the store's answer comes back as the store
   * sent it; not a REST route, so not in the OpenAPI document.
   */
  @All(':serviceId/ui/t/:token{/*rest}')
  @Public()
  @ApiExcludeEndpoint()
  proxy(
    @Param('serviceId') serviceId: string,
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.traces.proxy(token, serviceId, req, res);
  }

  @Put(':serviceId')
  @RequirePermission('service', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('serviceId') serviceId: string,
    @Query() query: TracesServiceDto,
    @Body() body: PutTracesDto,
  ) {
    return this.traces.put(
      toCtx(user, session),
      query.serviceType,
      serviceId,
      body,
    );
  }
}
