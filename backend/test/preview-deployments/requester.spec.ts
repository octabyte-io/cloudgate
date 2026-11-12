import { requesterIdOf } from '../../src/preview-deployments/requester';

describe('requesterIdOf', () => {
  const created = {
    userId: 'actor',
    metadata: JSON.stringify({ requesterId: 'recorded' }),
  };

  it("takes the preview's own column first", () => {
    expect(requesterIdOf(created, 'column')).toBe('column');
  });

  it("takes the create row's metadata copy once the column is nulled", () => {
    expect(requesterIdOf(created, null)).toBe('recorded');
  });

  it("takes the create row's actor when the metadata names nobody", () => {
    expect(requesterIdOf({ userId: 'actor', metadata: 'not json' }, null)).toBe(
      'actor',
    );
    expect(requesterIdOf({ userId: 'actor', metadata: null }, null)).toBe(
      'actor',
    );
  });

  it('names nobody when none of the three does', () => {
    expect(requesterIdOf({ userId: null, metadata: null }, null)).toBeNull();
    expect(requesterIdOf(null, null)).toBeNull();
  });
});
