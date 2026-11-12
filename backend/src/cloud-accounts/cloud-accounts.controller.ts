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
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { CloudAccountsService } from './cloud-accounts.service';
import {
  CreateCloudAccountDto,
  CreateCloudAccountInput,
  SetupCloudAccountDto,
  SetupCloudAccountInput,
  UpdateCloudAccountDto,
  UpdateCloudAccountInput,
} from './dto/cloud-account.dto';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';

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
 * Cloud accounts, under their own `cloudAccount` statement:
 * `read` lists them and never calls AWS, `create` hands out the setup template
 * for a new one and connects it. `update` edits one, runs Check now, hands
 * out its template at the current policy version and, for a Google Cloud
 * one, changes its key; `delete` removes it.
 * No MCP tool reaches any of these.
 */
@Controller('cloud-accounts')
export class CloudAccountsController {
  constructor(private readonly cloudAccountsService: CloudAccountsService) {}

  /**
   * The setup for an account about to be connected: for AWS the template,
   * CloudFormation and plain JSON, carrying the external id and tag value it
   * will be connected under; for a Google Cloud project the `gcloud` script,
   * the JWKS of the key pair it will sign with and the role definition
   * (the Google Cloud spec). Keeps nothing, so `200`.
   */
  @Post('setup')
  @HttpCode(200)
  @RequirePermission('cloudAccount', 'create')
  setup(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: SetupCloudAccountDto,
  ) {
    // The pipe parsed it with the union the class cannot be typed as.
    return this.cloudAccountsService.setup(
      toCtx(user, session),
      body as SetupCloudAccountInput,
    );
  }

  @Post()
  @RequirePermission('cloudAccount', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateCloudAccountDto,
  ) {
    // The pipe parsed it with the union the class cannot be typed as.
    return this.cloudAccountsService.create(
      toCtx(user, session),
      body as CreateCloudAccountInput,
    );
  }

  @Get()
  @RequirePermission('cloudAccount', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.cloudAccountsService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('cloudAccount', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudAccountsService.findOne(toCtx(user, session), id);
  }

  /** The setup template (AWS) or script (Google) at the current version, for "permissions out of date" and a key change. */
  @Get(':id/template')
  @RequirePermission('cloudAccount', 'update')
  template(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudAccountsService.template(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('cloudAccount', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateCloudAccountDto,
  ) {
    return this.cloudAccountsService.update(
      toCtx(user, session),
      id,
      body as UpdateCloudAccountInput,
    );
  }

  /** "Check now": a failed check is the answer, so `200` either way. */
  @Post(':id/check')
  @HttpCode(200)
  @RequirePermission('cloudAccount', 'update')
  check(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudAccountsService.checkNow(toCtx(user, session), id);
  }

  /**
   * "New key" on a Google Cloud account: a new key pair,
   * pending until a check signed with it passes, and the setup with a JWKS of
   * both public halves. Nothing signs with it yet, so `200`.
   */
  @Post(':id/key')
  @HttpCode(200)
  @RequirePermission('cloudAccount', 'update')
  newKey(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudAccountsService.newKey(toCtx(user, session), id);
  }

  /** The check signed with the pending key: a pass switches to it, a failure (`400`) changes nothing. */
  @Post(':id/key/check')
  @HttpCode(200)
  @RequirePermission('cloudAccount', 'update')
  checkNewKey(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudAccountsService.checkNewKey(toCtx(user, session), id);
  }

  @Delete(':id')
  @AllowedWhenFrozen('disconnect')
  @RequirePermission('cloudAccount', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudAccountsService.remove(toCtx(user, session), id);
  }
}
