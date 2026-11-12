import {
  requestedByFrom,
  requesterStanding,
} from '../../src/preview-deployments/requested-preview-reads';

const HOUR = 3_600_000;

describe('requesterStanding', () => {
  it('reads a requester still in the Organization and not banned as a member', () => {
    expect(
      requesterStanding({ member: { banned: false, banExpires: null } }),
    ).toBe('member');
  });

  it('reads a requester with no member row, or no id left at all, as removed', () => {
    expect(requesterStanding({ member: null })).toBe('removed');
  });

  it('reads a ban in force as suspended, and a lapsed one as a member', () => {
    expect(
      requesterStanding({ member: { banned: true, banExpires: null } }),
    ).toBe('suspended');
    expect(
      requesterStanding({
        member: { banned: true, banExpires: new Date(Date.now() + HOUR) },
      }),
    ).toBe('suspended');
    expect(
      requesterStanding({
        member: { banned: true, banExpires: new Date(Date.now() - HOUR) },
      }),
    ).toBe('member');
  });
});

describe('requestedByFrom', () => {
  it('names the requester from the create row, whatever the user row says now', () => {
    expect(
      requestedByFrom(
        {
          userName: 'deploy-bot',
          userId: null,
          metadata: '{"requesterId":"u1"}',
        },
        null,
        new Map(),
      ),
    ).toEqual({ id: 'u1', name: 'deploy-bot', standing: 'removed' });
  });

  it('prefers the preview column, then the metadata copy, then the actor id', () => {
    const members = new Map([
      ['col', { banned: false, banExpires: null }],
      ['meta', { banned: false, banExpires: null }],
      ['actor', { banned: false, banExpires: null }],
    ]);
    const row = {
      userName: 'Ida',
      userId: 'actor',
      metadata: '{"requesterId":"meta"}',
    };
    expect(requestedByFrom(row, 'col', members).id).toBe('col');
    expect(requestedByFrom(row, null, members).id).toBe('meta');
    expect(
      requestedByFrom({ ...row, metadata: 'not json' }, null, members).id,
    ).toBe('actor');
  });

  it('names nobody when there is no create row, and still says removed', () => {
    expect(requestedByFrom(null, null, new Map())).toEqual({
      id: null,
      name: null,
      standing: 'removed',
    });
  });
});
