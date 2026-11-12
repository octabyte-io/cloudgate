import {
  formatLapseWarning,
  toLapseEvent,
} from '../../../src/enterprise/license/license-lapse.service';
import type { LicenseLapseReport } from '../../../src/enterprise/license/license-lapse.service';
import { STOPPED_BY_LAPSE } from '../../../src/enterprise/license/paid-features';

/**
 * The warning is the whole of what the lapse handling delivers to an operator, so
 * its wording is behaviour rather than decoration: it has to name the people who are locked
 * out (an operator cannot act on a count), and it has to say why nobody was
 * moved off their role — otherwise the next person to read it proposes the
 * `member` fallback already rejected.
 */
describe('the warning a license lapse produces', () => {
  const report = (
    strandedMembers: LicenseLapseReport['strandedMembers'],
  ): LicenseLapseReport => ({
    organizationId: 'org_1',
    organizationName: 'Acme',
    validUntil: new Date('2026-08-01T00:00:00.000Z'),
    strandedMembers,
  });

  const ida = {
    id: 'mem_1',
    userId: 'usr_1',
    email: 'ida@example.com',
    firstName: 'Ida',
    lastName: 'Rhodes',
    role: 'read-only',
  };

  it('names the organization, the expiry and the people', () => {
    const message = formatLapseWarning(
      report([
        ida,
        {
          id: 'mem_2',
          userId: 'usr_2',
          email: 'jean@example.com',
          firstName: 'Jean',
          lastName: 'Bartik',
          role: 'deployer',
        },
      ]),
    );

    expect(message).toContain('"Acme" (org_1)');
    expect(message).toContain('lapsed on 2026-08-01T00:00:00.000Z');
    expect(message).toContain('2 members hold a custom role');
    expect(message).toContain('Ida Rhodes <ida@example.com> (read-only)');
    expect(message).toContain('Jean Bartik <jean@example.com> (deployer)');
  });

  it('counts one member as one', () => {
    expect(formatLapseWarning(report([ida]))).toContain(
      '1 member holds a custom role',
    );
  });

  it('falls back to the email when the account has no name', () => {
    const message = formatLapseWarning(
      report([{ ...ida, firstName: '', lastName: '' }]),
    );

    expect(message).toContain('ida@example.com <ida@example.com>');
  });

  // The decision, not a detail: The design rejected falling back to the static member
  // role because it grants backups, volumes and env vars outright, so a lapse
  // would *widen* a deliberately narrow custom role. If this assertion is ever
  // deleted, the reason goes with it.
  it('says why nobody was moved off their role', () => {
    const message = formatLapseWarning(report([ida]));

    expect(message).toContain('Nobody was moved automatically');
    expect(message).toContain('widen their access');
    expect(message).toContain('move them to the admin or member role');
  });

  // A lapse costs SSO sign-in and the rest whether or not anybody
  // holds a custom role, so the warning lists it every time.
  it('lists everything the lapse stopped', () => {
    for (const people of [[ida], []]) {
      const message = formatLapseWarning(report(people));
      for (const line of STOPPED_BY_LAPSE) {
        expect(message).toContain(line);
      }
    }
    expect(STOPPED_BY_LAPSE).toEqual([
      'SSO sign-in',
      'Adding members through SCIM',
      'Changes to forward auth',
      'Custom roles',
      'Editing white-labelling (the saved branding stays)',
      'Parallel builds and Cloud runs (back to one at a time)',
      'Creating more Organizations',
    ]);
  });

  it('says nobody is locked out when nobody holds a custom role', () => {
    const message = formatLapseWarning(report([]));

    expect(message).toContain('lapsed on 2026-08-01T00:00:00.000Z');
    expect(message).toContain('nobody is locked out');
    expect(message).not.toContain('hold a custom role');
    expect(message).not.toContain('move them');
  });
});

describe('toLapseEvent', () => {
  const report = (
    strandedMembers: LicenseLapseReport['strandedMembers'],
  ): LicenseLapseReport => ({
    organizationId: 'org_1',
    organizationName: 'Acme',
    validUntil: new Date('2026-08-01T00:00:00.000Z'),
    strandedMembers,
  });

  it('carries what stopped and names the custom-role holders', () => {
    const event = toLapseEvent(
      report([
        {
          id: 'mem_1',
          userId: 'usr_1',
          email: 'ida@example.com',
          firstName: 'Ida',
          lastName: 'Rhodes',
          role: 'read-only',
        },
      ]),
    );

    expect(event.stopped).toEqual(STOPPED_BY_LAPSE);
    expect(event.strandedMembers).toEqual([
      { name: 'Ida Rhodes', email: 'ida@example.com', role: 'read-only' },
    ]);
    expect(event.message).toContain('1 member holds a custom role');
    expect(event.message).toContain('Nobody was moved automatically');
  });

  it('names nobody when nobody holds a custom role', () => {
    const event = toLapseEvent(report([]));

    expect(event.stopped).toEqual(STOPPED_BY_LAPSE);
    expect(event.strandedMembers).toEqual([]);
    expect(event.message).toContain('nobody is locked out');
  });
});
