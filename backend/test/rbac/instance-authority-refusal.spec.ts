import { ForbiddenException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import type { LicenseService } from '../../src/enterprise/license/license.service';
import {
  INSTANCE_AUTHORITY_REQUIRED_CODE,
  PermissionService,
} from '../../src/rbac/permission.service';

/**
 * The shape of `checkInstanceAuthority`'s refusal (ADR-0013).
 *
 * It was a bare `ForbiddenException(message)`, and the console has one
 * sentence for an uncoded 403 — "Ask an owner or an admin to do it, or to
 * change your role" — which is false here: the caller may already own their
 * Organization, and no role in it grants instance authority. So the refusal
 * carries a code the console words on its own (`auth-error.ts`), and keeps its
 * message, which the journal and the HTTP suites read.
 *
 * Whether the caller holds the authority is `holdsInstanceAuthority`'s
 * question and is stubbed here; what is asserted is only what a "no" answers.
 */
describe('PermissionService.checkInstanceAuthority', () => {
  const service = new PermissionService(
    {} as DrizzleDB,
    {} as LicenseService,
    {} as InstanceMode,
  );
  const ctx = {
    user: { id: 'user-1' },
    session: { activeOrganizationId: 'org-2' },
  };

  it('refuses with the instance-authority code and its unchanged message', async () => {
    jest.spyOn(service, 'holdsInstanceAuthority').mockResolvedValue(false);

    const refusal: unknown = await service.checkInstanceAuthority(ctx).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ForbiddenException);
    const forbidden = refusal as ForbiddenException;
    expect(forbidden.getResponse()).toEqual({
      message:
        'Only an owner or admin of the instance organization can configure the platform host',
      code: 'INSTANCE_AUTHORITY_REQUIRED',
    });
    expect(forbidden.message).toBe(
      'Only an owner or admin of the instance organization can configure the platform host',
    );
    expect(INSTANCE_AUTHORITY_REQUIRED_CODE).toBe(
      'INSTANCE_AUTHORITY_REQUIRED',
    );
  });

  it('admits a caller who holds it', async () => {
    jest.spyOn(service, 'holdsInstanceAuthority').mockResolvedValue(true);

    await expect(service.checkInstanceAuthority(ctx)).resolves.toBeUndefined();
  });
});
