import { ForbiddenException } from '@nestjs/common';
import { createCustomRoleSchema } from '../../src/enterprise/custom-roles/dto/custom-role.dto';
import { assertRoleFitsKind } from '../../src/rbac/member-role';

/**
 * The platform's audit role is held by no Member (ADR-0026's
 * platform-actor pin). The database refuses the row itself
 * (`member_role_is_not_the_platform`, pinned in
 * `requested-preview-expiry.e2e-spec.ts`); these are the two refusals that
 * answer with a sentence before a write is tried.
 */
describe('assertRoleFitsKind', () => {
  it.each([
    [{ kind: 'human' }, 'system'],
    [{ kind: 'agent' }, 'system'],
    [{ kind: 'human' }, 'member,system'],
    [{ kind: 'human' }, 'member, system'],
  ])('refuses %o the role %s', (holder, role) => {
    expect(() => assertRoleFitsKind(holder, role)).toThrow(
      new ForbiddenException(
        "The system role is the platform's own and no Member can hold it",
      ),
    );
  });

  it('still admits a person to member and an Agent to its roles', () => {
    expect(() => assertRoleFitsKind({ kind: 'human' }, 'member')).not.toThrow();
    expect(() =>
      assertRoleFitsKind({ kind: 'agent' }, 'agentOperator'),
    ).not.toThrow();
  });
});

describe('createCustomRoleSchema', () => {
  it('refuses a custom role named system', () => {
    expect(
      createCustomRoleSchema.safeParse({ roleName: 'system', permissions: {} })
        .success,
    ).toBe(false);
  });
});
