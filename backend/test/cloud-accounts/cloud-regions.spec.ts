import { regionRefusal } from '../../src/cloud-accounts/cloud-regions';

describe('regionRefusal (spec S17)', () => {
  it('takes an AWS region Cloudgate deploys to', () => {
    expect(regionRefusal('aws', 'eu-west-1')).toBeNull();
    expect(regionRefusal('aws', 'us-east-1')).toBeNull();
  });

  it('refuses a region AWS does not have, naming it', () => {
    expect(regionRefusal('aws', 'eu-west1')).toBe(
      'eu-west1 is not an AWS region Cloudgate deploys to',
    );
  });

  it('refuses a region of a partition the setup template does not cover', () => {
    expect(regionRefusal('aws', 'us-gov-west-1')).toBe(
      'us-gov-west-1 is not an AWS region Cloudgate deploys to',
    );
  });

  it('takes a Google Cloud region, and refuses one Google does not have, naming it', () => {
    expect(regionRefusal('gcp', 'europe-west1')).toBeNull();
    expect(regionRefusal('gcp', 'us-central1')).toBeNull();
    expect(regionRefusal('gcp', 'europe-west-1')).toBe(
      'europe-west-1 is not a Google Cloud region Cloudgate deploys to',
    );
    expect(regionRefusal('gcp', 'eu-west-1')).toBe(
      'eu-west-1 is not a Google Cloud region Cloudgate deploys to',
    );
  });
});
