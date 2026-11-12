import { withGoogleImports } from '../../../../src/cloud-accounts/gcp/definitions/imports';

describe('withGoogleImports', () => {
  const definition = { resource: { google_compute_network: { network: {} } } };

  it('leaves a definition alone when the plan adopts nothing', () => {
    expect(withGoogleImports(definition, [])).toBe(definition);
  });

  it('imports each adopted thing at its address by the full name Google listed it under', () => {
    expect(
      withGoogleImports(definition, [
        {
          address: 'google_compute_network.network',
          resourceType: 'google_compute_network',
          arn: 'projects/shop-prod/global/networks/cloudgate-w33lemwkholw-net',
        },
      ]),
    ).toEqual({
      ...definition,
      import: [
        {
          to: 'google_compute_network.network',
          id: 'projects/shop-prod/global/networks/cloudgate-w33lemwkholw-net',
        },
      ],
    });
  });
});
