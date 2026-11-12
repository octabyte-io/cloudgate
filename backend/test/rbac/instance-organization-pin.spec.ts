import { ForbiddenException, Logger } from '@nestjs/common';
import { createInstanceOrganization } from '../../src/auth/instance-organization';
import { hasInstanceOwner } from '../../src/auth/sign-up-state';
import { member, organization, user } from '../../src/db/schema';
import type { LicenseService } from '../../src/enterprise/license/license.service';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import {
  INSTANCE_ORGANIZATION_UNDELETABLE_CODE,
  pinInstanceOrganization,
  readInstanceOrganizationPin,
  refuseDeletingInstanceOrganization,
} from '../../src/rbac/instance-organization-pin';
import { instanceOrganization } from '../../src/rbac/instance-organization.schema';
import { PermissionService } from '../../src/rbac/permission.service';
import { InMemoryDb } from './in-memory-db';

/**
 * The Instance organization is **pinned** (ADR-0077): one recorded id, and
 * instance authority is derived from it alone. The earliest owner `member`
 * row — ADR-0013's old definition — names nothing any more, so deleting the
 * pinned Organization, or its first owner's row, hands the authority to
 * nobody rather than to the next-earliest owner, who on the Hosted instance
 * is a paying customer.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

/**
 * Three Organizations whose owner rows sort customer-first: `early` (a
 * customer whose owner row is the *earliest*), `staff` (the pinned Instance
 * organization) and `late` (a customer signed up after it).
 */
function instance(options: { pinned: string | null }): InMemoryDb {
  const memory = new InMemoryDb();
  memory.seed(user, [
    { id: 'u-early', email: 'early@example.com', firstName: 'E' },
    { id: 'u-staff', email: 'staff@example.com', firstName: 'S' },
    { id: 'u-admin', email: 'admin@example.com', firstName: 'A' },
    { id: 'u-late', email: 'late@example.com', firstName: 'L' },
    {
      id: 'u-agent',
      email: 'agent@example.com',
      firstName: 'G',
      kind: 'agent',
    },
  ]);
  memory.seed(organization, [
    { id: 'org-early', name: 'Early', ownerId: 'u-early', createdAt: at(0) },
    { id: 'org-staff', name: 'Staff', ownerId: 'u-staff', createdAt: at(1) },
    { id: 'org-late', name: 'Late', ownerId: 'u-late', createdAt: at(2) },
  ]);
  memory.seed(member, [
    {
      id: 'm-early',
      organizationId: 'org-early',
      userId: 'u-early',
      role: 'owner',
      createdAt: at(0),
    },
    {
      id: 'm-staff',
      organizationId: 'org-staff',
      userId: 'u-staff',
      role: 'owner',
      createdAt: at(1),
    },
    {
      id: 'm-admin',
      organizationId: 'org-staff',
      userId: 'u-admin',
      role: 'admin',
      createdAt: at(1),
    },
    {
      id: 'm-agent',
      organizationId: 'org-staff',
      userId: 'u-agent',
      role: 'admin',
      createdAt: at(1),
    },
    {
      id: 'm-late',
      organizationId: 'org-late',
      userId: 'u-late',
      role: 'owner',
      createdAt: at(2),
    },
  ]);
  if (options.pinned) {
    memory.seed(instanceOrganization, [{ organizationId: options.pinned }]);
  }
  return memory;
}

function permissionsOver(memory: InMemoryDb): PermissionService {
  return new PermissionService(
    memory.db,
    {} as LicenseService,
    {} as InstanceMode,
  );
}

const holds = (service: PermissionService, userId: string) =>
  service.holdsInstanceAuthority({ user: { id: userId } });

describe('PermissionService.holdsInstanceAuthority', () => {
  afterEach(() => jest.restoreAllMocks());

  it("grants it to the pinned Organization's owner and admins", async () => {
    const service = permissionsOver(instance({ pinned: 'org-staff' }));

    await expect(holds(service, 'u-staff')).resolves.toBe(true);
    await expect(holds(service, 'u-admin')).resolves.toBe(true);
    await expect(service.instanceOrganizationId()).resolves.toBe('org-staff');
  });

  it('never grants it to a customer owner, whether their owner row is earlier or later', async () => {
    const service = permissionsOver(instance({ pinned: 'org-staff' }));

    await expect(holds(service, 'u-early')).resolves.toBe(false);
    await expect(holds(service, 'u-late')).resolves.toBe(false);
  });

  it('still refuses an Agent admin of the pinned Organization', async () => {
    const service = permissionsOver(instance({ pinned: 'org-staff' }));

    await expect(holds(service, 'u-agent')).resolves.toBe(false);
  });

  it('grants it to nobody once the pinned Organization is gone, and says so loudly', async () => {
    const memory = instance({ pinned: 'org-staff' });
    memory.remove(member, 'organizationId', 'org-staff');
    memory.remove(organization, 'id', 'org-staff');
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = permissionsOver(memory);

    for (const userId of ['u-early', 'u-late', 'u-staff', 'u-admin']) {
      await expect(holds(service, userId)).resolves.toBe(false);
    }
    await expect(service.instanceOrganizationId()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('org-staff'));
  });

  it("grants it to nobody once the pinned Organization's first owner row is gone", async () => {
    const memory = instance({ pinned: 'org-staff' });
    memory.remove(member, 'id', 'm-staff');
    const service = permissionsOver(memory);

    await expect(holds(service, 'u-early')).resolves.toBe(false);
    await expect(holds(service, 'u-late')).resolves.toBe(false);
    await expect(holds(service, 'u-admin')).resolves.toBe(true);
  });

  it('grants it to nobody while nothing is pinned, owner rows notwithstanding', async () => {
    const service = permissionsOver(instance({ pinned: null }));

    await expect(holds(service, 'u-early')).resolves.toBe(false);
    await expect(service.instanceOrganizationId()).resolves.toBeNull();
  });
});

describe('createInstanceOrganization', () => {
  it('pins the Organization it makes as the Instance organization', async () => {
    const memory = new InMemoryDb();

    const created = await createInstanceOrganization(memory.db, {
      email: 'ops@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: 'a-long-enough-password',
      organizationName: 'Octabyte',
    });

    await expect(readInstanceOrganizationPin(memory.db)).resolves.toEqual({
      organizationId: created.organizationId,
      exists: true,
    });
    await expect(
      permissionsOver(memory).holdsInstanceAuthority({
        user: { id: created.userId },
      }),
    ).resolves.toBe(true);
  });

  it('refuses, writing nothing, once an Instance organization is pinned', async () => {
    const memory = instance({ pinned: 'org-staff' });
    memory.remove(member, 'organizationId', 'org-staff');
    memory.remove(member, 'organizationId', 'org-early');
    memory.remove(member, 'organizationId', 'org-late');

    await expect(
      createInstanceOrganization(memory.db, {
        email: 'ops@example.com',
        firstName: 'Ada',
        lastName: '',
        password: 'a-long-enough-password',
        organizationName: 'Again',
      }),
    ).rejects.toThrow(/already has an Instance organization/);
    expect(memory.rows(organization)).toHaveLength(3);
  });
});

describe('pinInstanceOrganization', () => {
  it('pins once: a second pin never moves it', async () => {
    const memory = instance({ pinned: null });

    await expect(pinInstanceOrganization(memory.db, 'org-staff')).resolves.toBe(
      true,
    );
    await expect(pinInstanceOrganization(memory.db, 'org-early')).resolves.toBe(
      false,
    );
    await expect(readInstanceOrganizationPin(memory.db)).resolves.toEqual({
      organizationId: 'org-staff',
      exists: true,
    });
  });
});

describe('hasInstanceOwner', () => {
  it('is true once an Organization is pinned, even with no owner row left', async () => {
    const memory = instance({ pinned: 'org-staff' });
    for (const id of ['m-early', 'm-staff', 'm-late']) {
      memory.remove(member, 'id', id);
    }

    await expect(hasInstanceOwner(memory.db)).resolves.toBe(true);
  });

  it('is false on an unclaimed instance', async () => {
    await expect(hasInstanceOwner(new InMemoryDb().db)).resolves.toBe(false);
  });
});

describe('refuseDeletingInstanceOrganization', () => {
  it('refuses the pinned Organization with its code', async () => {
    const memory = instance({ pinned: 'org-staff' });

    const refusal: unknown = await refuseDeletingInstanceOrganization(
      memory.db,
      ['org-late', 'org-staff'],
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: INSTANCE_ORGANIZATION_UNDELETABLE_CODE,
    });
  });

  it('lets any other Organization go', async () => {
    const memory = instance({ pinned: 'org-staff' });

    await expect(
      refuseDeletingInstanceOrganization(memory.db, ['org-early', 'org-late']),
    ).resolves.toBeUndefined();
  });
});
