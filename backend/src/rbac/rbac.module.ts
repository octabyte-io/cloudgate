import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionService } from './permission.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * Global so every feature module can inject PermissionService without
 * importing it. PermissionsGuard runs app-wide after AuthGuard (AuthModule
 * registers its APP_GUARD first) and only acts on @RequirePermission routes.
 *
 * LicenseService, which PermissionService consults to resolve custom roles, is
 * provided by the (also global) LicenseModule since phase 49.
 */
@Global()
@Module({
  providers: [
    PermissionService,
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [PermissionService],
})
export class RbacModule {}
