import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CdnService } from './cdn.service';
import { ValidateDomainDto } from './dto/cdn.dto';

// Domain validation sits under /domains, with the other domain routes, even
// though the logic (CDN detection) is this module's.
@Controller('domains')
export class CdnController {
  constructor(private readonly cdnService: CdnService) {}

  @Post('validate')
  @HttpCode(200)
  @RequirePermission('domain', 'read')
  validateDomain(@Body() body: ValidateDomainDto) {
    return this.cdnService.validateDomain(body.domain, body.serverIp);
  }
}
