import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
import { CertificatesService } from './certificates.service';
import {
  CreateCertificateDto,
  UpdateCertificateDto,
} from './dto/certificate.dto';

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

// Permission mapping: read on queries, create on create, update on update,
// delete on remove.
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post()
  @RequirePermission('certificate', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateCertificateDto,
  ) {
    return this.certificatesService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('certificate', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.certificatesService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('certificate', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.certificatesService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('certificate', 'update')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateCertificateDto,
  ) {
    return this.certificatesService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('certificate', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.certificatesService.remove(toCtx(user, session), id);
  }
}
