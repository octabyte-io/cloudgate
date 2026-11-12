import {
  FOREIGN_KEY_MESSAGE,
  NO_KEY_MESSAGE,
  unusableKeyMessage,
} from '../../src/servers/server-connection.provider';

/**
 * The branch `ServerConnectionProvider` reaches once its organization-scoped
 * join comes back with no private key.
 *
 * Unit-tested rather than only driven through the provider because the
 * distinction is a judgement about *what to tell an operator*, and the three
 * states are one `and`/`or` apart: the e2e proves the join stopped handing
 * over a foreign key, and this proves the row is not then misdescribed as one
 * that never had a key. `name-category.spec.ts` is the precedent for
 * unit-testing an exported helper out of this module's service files.
 */
describe('unusableKeyMessage', () => {
  it('names the assignment gap when the Server carries no key id at all', () => {
    expect(unusableKeyMessage(null, null)).toBe(NO_KEY_MESSAGE);
    expect(NO_KEY_MESSAGE).toBe('Server has no SSH key assigned');
  });

  it('names the tenancy fault when a key id resolved to nothing in the Server’s organization', () => {
    // The only way a non-null `ssh_key_id` resolves to nothing: the row exists
    // — `server.ssh_key_id` is a foreign key onto `ssh_key` — and the
    // organization predicate in the join is what missed.
    expect(unusableKeyMessage('other-orgs-key', null)).toBe(
      FOREIGN_KEY_MESSAGE,
    );
    expect(FOREIGN_KEY_MESSAGE).toBe(
      "Server's SSH key belongs to another organization",
    );
  });

  it('does not call an in-organization key with empty material a tenancy fault', () => {
    // `sshKey.privateKey` is `.notNull()` with a `''` default, so a key the
    // join *did* resolve can still carry nothing. That answered
    // NO_KEY_MESSAGE before the fix and must keep answering it: it is a gap in
    // the key, not a cross-organization row, and reporting it as one would
    // send an operator to fix tenancy on a row whose tenancy is correct.
    expect(unusableKeyMessage('our-own-key', 'our-own-key')).toBe(
      NO_KEY_MESSAGE,
    );
  });

  // Not decoration: the two sentences are the whole output of this function
  // and they travel to an API caller, so neither may quote the material the
  // refusal is about.
  it('never puts key material in either message', () => {
    for (const message of [NO_KEY_MESSAGE, FOREIGN_KEY_MESSAGE]) {
      expect(message).not.toMatch(/PRIVATE KEY|BEGIN|ssh-(rsa|ed25519)/);
    }
  });
});
