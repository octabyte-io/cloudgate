import {
  scimAddOf,
  scimAddRefusalDetail,
} from '../../../src/enterprise/scim/scim-plan-gate';

/**
 * Which SCIM pushes add or widen access: read off the request alone,
 * before the plugin runs. Whether the user is deactivated now is the gate's
 * second question, asked of the database, and is covered by
 * `scim.e2e-spec.ts`.
 */
describe('scimAddOf', () => {
  const create = (body: unknown, method = 'POST') => ({
    path: '/scim/v2/Users',
    method,
    body,
  });
  const update = (method: string, body: unknown, userId = 'u1') => ({
    path: '/scim/v2/Users/:userId',
    method,
    params: { userId },
    body,
  });
  const patch = (...Operations: unknown[]) =>
    update('PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations,
    });

  it('reads a create as an add of the address the plugin would provision', () => {
    expect(
      scimAddOf(
        create({
          userName: 'someone@example.com',
          emails: [
            { value: 'Other@Example.com' },
            { value: 'Ada@Example.com', primary: true },
          ],
        }),
      ),
    ).toEqual({ kind: 'create', email: 'ada@example.com' });
    expect(
      scimAddOf(create({ userName: 'x', emails: [{ value: 'First@x.io' }] })),
    ).toEqual({ kind: 'create', email: 'first@x.io' });
    expect(scimAddOf(create({ userName: 'Ada@Example.com' }))).toEqual({
      kind: 'create',
      email: 'ada@example.com',
    });
  });

  it('leaves a create with no address to the plugin’s validation', () => {
    expect(scimAddOf(create({}))).toBeNull();
    expect(scimAddOf(create(undefined))).toBeNull();
  });

  it('takes the method from the request when the context has none', () => {
    expect(
      scimAddOf({
        path: '/scim/v2/Users',
        request: { method: 'post' },
        body: { userName: 'ada@example.com' },
      }),
    ).toEqual({ kind: 'create', email: 'ada@example.com' });
  });

  it('never reads a list, a read or a delete as an add', () => {
    expect(scimAddOf(create({ userName: 'a@b.c' }, 'GET'))).toBeNull();
    expect(scimAddOf(update('GET', undefined))).toBeNull();
    expect(scimAddOf(update('DELETE', undefined))).toBeNull();
    expect(
      scimAddOf({ path: '/scim/v2/Schemas', method: 'POST', body: {} }),
    ).toBeNull();
  });

  it('reads a PUT that sets active to anything but false as a possible reactivation', () => {
    const reactivate = { kind: 'reactivate', userId: 'u1' };
    expect(scimAddOf(update('PUT', { userName: 'a', active: true }))).toEqual(
      reactivate,
    );
    expect(scimAddOf(update('PUT', { userName: 'a', active: false }))).toBe(
      null,
    );
    // No `active` leaves the ban as it is.
    expect(scimAddOf(update('PUT', { userName: 'a' }))).toBeNull();
  });

  it('reads a PATCH the way the plugin applies it', () => {
    const reactivate = { kind: 'reactivate', userId: 'u1' };
    expect(
      scimAddOf(patch({ op: 'replace', path: 'active', value: true })),
    ).toEqual(reactivate);
    expect(
      scimAddOf(patch({ op: 'Add', path: '/active', value: 'true' })),
    ).toEqual(reactivate);
    // A missing `op` is a replace, and a path-less value is walked key by key.
    expect(scimAddOf(patch({ value: { active: true } }))).toEqual(reactivate);
    expect(
      scimAddOf(patch({ op: 'replace', value: { name: { givenName: 'A' } } })),
    ).toBeNull();
    expect(
      scimAddOf(patch({ op: 'replace', path: 'active', value: false })),
    ).toBe(null);
    expect(
      scimAddOf(patch({ op: 'replace', path: 'active', value: 'false' })),
    ).toBeNull();
    expect(scimAddOf(patch({ op: 'remove', path: 'active' }))).toBeNull();
    expect(
      scimAddOf(
        patch(
          { op: 'replace', path: 'name.givenName', value: 'Ada' },
          { op: 'replace', path: 'active', value: true },
        ),
      ),
    ).toEqual(reactivate);
  });

  it('needs a user id to reactivate', () => {
    expect(
      scimAddOf(update('PUT', { userName: 'a', active: true }, '')),
    ).toBeNull();
  });
});

describe('scimAddRefusalDetail', () => {
  it('points a Hosted IdP at Business and a Self-hosted one at the license', () => {
    expect(scimAddRefusalDetail({ isHosted: true })).toMatch(/Business plan/);
    expect(scimAddRefusalDetail({ isHosted: false })).toMatch(
      /enterprise license/,
    );
  });
});
