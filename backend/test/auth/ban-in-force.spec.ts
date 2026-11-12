import { banInForce } from '../../src/auth/ban';

/**
 * The one predicate both credential paths ask before they let a caller through.
 *
 * Two columns, and until the fix Cloudgate read one of them. `banned` was checked
 * on the api-key path only — a banned account's cookie went on answering 200
 * while its key answered 403 on the same route — and `banExpires` was read
 * nowhere at all, so a 24-hour ban on an account that never signed in again
 * refused its api keys for ever. The only code that clears an elapsed ban is
 * better-auth's `session.create.before` hook, which by definition never runs for
 * a credential that creates no session.
 *
 * One function rather than a check per path, because the two paths had already
 * drifted once and this is the seam they drifted at.
 */

const HOUR = 60 * 60 * 1000;

describe('banInForce', () => {
  it.each([
    ['null, the column default before anyone is banned', null],
    ['false', false],
    ['undefined, as better-auth types it on a session user', undefined],
  ])('is not in force when banned is %s', (_label, banned) => {
    expect(banInForce({ banned, banExpires: null })).toBe(false);
  });

  /**
   * A permanent ban: `banExpires` is what better-auth leaves unset when no
   * duration was given, so "no expiry" has to mean *in force*, not *expired*.
   */
  it('is in force when banned with no expiry', () => {
    expect(banInForce({ banned: true, banExpires: null })).toBe(true);
    expect(banInForce({ banned: true, banExpires: undefined })).toBe(true);
  });

  it('is in force while a temporary ban has time left', () => {
    expect(
      banInForce({ banned: true, banExpires: new Date(Date.now() + HOUR) }),
    ).toBe(true);
  });

  /**
   * The half nothing in the tree read. The columns are not repaired here on
   * purpose — clearing them stays the plugin's job on the next sign-in, because
   * a read path that repairs rows is a read path anyone who can make it read can
   * make write — so the row still says `banned: true` and this is the only thing
   * that lets the credential back in.
   */
  it('is not in force once a temporary ban has passed', () => {
    expect(
      banInForce({ banned: true, banExpires: new Date(Date.now() - HOUR) }),
    ).toBe(false);
  });
});
