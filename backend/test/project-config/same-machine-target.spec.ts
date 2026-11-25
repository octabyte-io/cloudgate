import { onCloudgateMachine } from '../../src/project-config/same-machine-target';

/**
 * Whether a plan's Deploy target is Cloudgate's own machine (spec #146),
 * which puts the Same-machine warning on each of its creates: the platform
 * host, or a Server saved as `sameMachine`, and never on the Hosted instance.
 */
describe('onCloudgateMachine', () => {
  const server = { kind: 'server', serverId: 'srv-1' } as const;

  it('is the platform host on a Self-hosted instance', () => {
    expect(
      onCloudgateMachine({ kind: 'platform-host' }, { hosted: false }),
    ).toBe(true);
  });

  it('is a Server whose address is the box itself', () => {
    expect(
      onCloudgateMachine(server, {
        hosted: false,
        server: { sameMachine: true },
      }),
    ).toBe(true);
  });

  it('is not a Server elsewhere, a missing one, or a Cloud account', () => {
    expect(
      onCloudgateMachine(server, {
        hosted: false,
        server: { sameMachine: false },
      }),
    ).toBe(false);
    expect(onCloudgateMachine(server, { hosted: false })).toBe(false);
    expect(
      onCloudgateMachine(
        { kind: 'cloud', cloudAccountId: 'ca-1', region: 'eu-west-1' },
        { hosted: false },
      ),
    ).toBe(false);
  });

  it('is never anything on the Hosted instance', () => {
    expect(
      onCloudgateMachine({ kind: 'platform-host' }, { hosted: true }),
    ).toBe(false);
    expect(
      onCloudgateMachine(server, {
        hosted: true,
        server: { sameMachine: true },
      }),
    ).toBe(false);
  });
});
