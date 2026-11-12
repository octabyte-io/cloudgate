import { SetMetadata } from '@nestjs/common';
import type { statements } from '../access-control';
import type { Permissions } from '../permission.service';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

type Statements = typeof statements;
type Resource = keyof Statements;

/**
 * Declares the permission a route needs; enforced by PermissionsGuard.
 */
export const RequirePermission = <R extends Resource>(
  resource: R,
  ...actions: Statements[R][number][]
) => SetMetadata(REQUIRE_PERMISSION_KEY, { [resource]: actions });
