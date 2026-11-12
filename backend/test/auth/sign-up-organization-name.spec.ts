import { APIError } from 'better-auth/api';
import {
  DEFAULT_ORGANIZATION_NAME,
  signUpOrganizationName,
} from '../../src/auth/sign-up-organization-name';

/**
 * The owner names their first Organization on the sign-up form, and
 * "My Organization" is still what an unanswered question means.
 */
describe('signUpOrganizationName', () => {
  it('takes the name the form sent, trimmed', () => {
    expect(signUpOrganizationName({ organizationName: '  Acme Ops ' })).toBe(
      'Acme Ops',
    );
  });

  it.each([
    ['no body', undefined],
    ['no field', { email: 'a@example.com' }],
    ['a blank field', { organizationName: '   ' }],
    ['a field that is not a string', { organizationName: 42 }],
  ])('keeps the default for %s', (_, body) => {
    expect(signUpOrganizationName(body)).toBe(DEFAULT_ORGANIZATION_NAME);
    expect(DEFAULT_ORGANIZATION_NAME).toBe('My Organization');
  });

  it('refuses a name longer than an Organization can be renamed to', () => {
    expect(() =>
      signUpOrganizationName({ organizationName: 'x'.repeat(256) }),
    ).toThrow(APIError);
    expect(signUpOrganizationName({ organizationName: 'x'.repeat(255) })).toBe(
      'x'.repeat(255),
    );
  });
});
