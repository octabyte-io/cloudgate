import { previewOf } from '../../src/auth/invitation-preview';

const NOW = new Date('2026-11-03T12:00:00Z');
const LATER = new Date('2026-11-05T12:00:00Z');
const EARLIER = new Date('2026-11-01T12:00:00Z');

const row = (status: string, expiresAt: Date) => ({
  status,
  expiresAt,
  email: 'ada@example.com',
  organizationName: 'Acme',
});

/**
 * An invitation link is checked when its page loads, and only an open
 * invitation says what it was for.
 */
describe('previewOf', () => {
  it('names the Organization and the address of an open invitation', () => {
    expect(previewOf(row('pending', LATER), NOW)).toEqual({
      open: true,
      organizationName: 'Acme',
      email: 'ada@example.com',
    });
  });

  it('says a pending invitation past its date has expired, and names nothing', () => {
    expect(previewOf(row('pending', EARLIER), NOW)).toEqual({
      open: false,
      code: 'INVITATION_EXPIRED',
    });
  });

  it.each(['accepted', 'rejected', 'canceled'])(
    'answers a %s invitation as not open, naming nothing',
    (status) => {
      expect(previewOf(row(status, LATER), NOW)).toEqual({
        open: false,
        code: 'INVITATION_NOT_OPEN',
      });
    },
  );

  it('answers an id with no row exactly as a closed one', () => {
    expect(previewOf(undefined, NOW)).toEqual({
      open: false,
      code: 'INVITATION_NOT_OPEN',
    });
  });
});
