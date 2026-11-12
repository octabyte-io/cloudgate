import {
  compareVersions,
  newerStateRefusal,
  stateProviderOf,
} from '../../src/cloud-accounts/infrastructure-state/state-versions';
import {
  AWS_PROVIDER_VERSION,
  GOOGLE_PROVIDER_VERSION,
  OPENTOFU_VERSION,
} from '../../src/cloud-accounts/tofu/tofu-environment';

/** Versions move forward only. */
describe('newerStateRefusal', () => {
  const installed = { tofuVersion: '1.13.1', providerVersion: '6.69.1' };
  const aws = { provider: 'aws' } as const;

  it('lets a state never written run', () => {
    expect(
      newerStateRefusal(
        's1',
        { ...aws, tofuVersion: null, providerVersion: null },
        installed,
      ),
    ).toBeNull();
  });

  it('lets an older or equal state run, to be brought forward', () => {
    for (const recorded of [
      { ...aws, tofuVersion: '1.13.1', providerVersion: '6.69.1' },
      { ...aws, tofuVersion: '1.10.0', providerVersion: '6.69.1' },
      { ...aws, tofuVersion: '1.13.1', providerVersion: '5.100.0' },
    ]) {
      expect(newerStateRefusal('s1', recorded, installed)).toBeNull();
    }
  });

  it('refuses a newer OpenTofu or a newer provider, naming both pairs and saying to upgrade Cloudgate', () => {
    expect(
      newerStateRefusal(
        's1',
        { ...aws, tofuVersion: '1.14.0', providerVersion: '6.69.1' },
        installed,
      ),
    ).toBe(
      'Infrastructure state s1 was last written by OpenTofu 1.14.0 with AWS provider 6.69.1, ' +
        "newer than this install's OpenTofu 1.13.1 with AWS provider 6.69.1. Upgrade Cloudgate to run it.",
    );
    expect(
      newerStateRefusal(
        's1',
        { ...aws, tofuVersion: '1.13.1', providerVersion: '6.70.0' },
        installed,
      ),
    ).toMatch(/AWS provider 6\.70\.0.*Upgrade Cloudgate/);
  });

  // Each state's provider version is compared with that provider's own pin
  // (spec S18): the two pins are far apart, so comparing a Google
  // state with the AWS pin would refuse every one of them.
  describe('against the pins of the provider that wrote the state', () => {
    it('lets a Google state at the Google pin run, though it is past the AWS pin', () => {
      expect(
        newerStateRefusal('s1', {
          provider: 'google',
          tofuVersion: OPENTOFU_VERSION,
          providerVersion: GOOGLE_PROVIDER_VERSION,
        }),
      ).toBeNull();
    });

    it('refuses a Google state written by a newer Google provider, naming the Google provider', () => {
      expect(
        newerStateRefusal('s1', {
          provider: 'google',
          tofuVersion: OPENTOFU_VERSION,
          providerVersion: '99.0.0',
        }),
      ).toBe(
        `Infrastructure state s1 was last written by OpenTofu ${OPENTOFU_VERSION} with Google provider 99.0.0, ` +
          `newer than this install's OpenTofu ${OPENTOFU_VERSION} with Google provider ${GOOGLE_PROVIDER_VERSION}. Upgrade Cloudgate to run it.`,
      );
    });

    it('refuses an AWS state written by a newer AWS provider, as before, though it is short of the Google pin', () => {
      expect(
        newerStateRefusal('s1', {
          provider: 'aws',
          tofuVersion: OPENTOFU_VERSION,
          providerVersion: '6.100.0',
        }),
      ).toBe(
        `Infrastructure state s1 was last written by OpenTofu ${OPENTOFU_VERSION} with AWS provider 6.100.0, ` +
          `newer than this install's OpenTofu ${OPENTOFU_VERSION} with AWS provider ${AWS_PROVIDER_VERSION}. Upgrade Cloudgate to run it.`,
      );
    });
  });

  it('compares versions part by part, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.4')).toBeGreaterThan(0);
    expect(compareVersions('6.100.0', '6.69.1')).toBeGreaterThan(0);
    expect(compareVersions('1.13.1', '1.13.1')).toBe(0);
  });
});

/** A state's provider follows its owner's Cloud account's cloud. */
describe('stateProviderOf', () => {
  it("writes an AWS Cloud account's states with the AWS provider and a Google one's with Google's", () => {
    expect(stateProviderOf('aws')).toBe('aws');
    expect(stateProviderOf('gcp')).toBe('google');
  });
});
