import { Module } from '@nestjs/common';
import { CustomRoleController } from './custom-role.controller';
import { CustomRolesService } from './custom-roles.service';

@Module({
  controllers: [CustomRoleController],
  providers: [CustomRolesService],
  exports: [CustomRolesService],
})
export class CustomRolesModule {}
