import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { googleStateResources } from '../../src/cloud-accounts/gcp/state-resources';
import type { TofuStateShow } from '../../src/cloud-accounts/tofu/state-show';

/** A Google state as `tofu show -json` prints it, by its name in `fixtures/states/`. */
function stored(name: string): TofuStateShow {
  return JSON.parse(
    readFileSync(
      resolve(__dirname, 'fixtures', 'states', `${name}.json`),
      'utf8',
    ),
  ) as TofuStateShow;
}

/** The labels Cloudgate's web definition wrote on what carries them. */
const WEB_LABELS = {
  'cloudgate-cloud-account': 'lqinodt54kzk',
  'cloudgate-environment': 'w33lemwkholw',
  'cloudgate-state': '7rhuqxy3gm43',
};

/** Values the stored states hold that a list must never show. */
const SECRETS = [
  'hunter2-very-secret',
  'another-secret-value',
  'OUTPUT-SECRET-VALUE',
  'INGRESS_TRAFFIC_ALL',
  'docker.pkg.dev/example-project-123',
];

describe('googleStateResources', () => {
  it("lists a Cloud Run Service's resources by type, Google name, region and labels, and whether each carries Cloudgate's", () => {
    const listed = googleStateResources(
      stored('google-web-state'),
      'europe-west1',
    );

    expect(
      listed.map(({ type, googleName, region, labelled }) => ({
        type,
        googleName,
        region,
        labelled,
      })),
    ).toEqual([
      {
        type: 'google_artifact_registry_repository',
        googleName: 'cloudgate-plb3nv2t74e6',
        region: 'europe-west1',
        labelled: true,
      },
      {
        type: 'google_cloud_run_v2_service',
        googleName: 'cloudgate-plb3nv2t74e6',
        region: 'europe-west1',
        labelled: true,
      },
      // A backend service takes no labels, and is global.
      {
        type: 'google_compute_backend_service',
        googleName: 'cloudgate-plb3nv2t74e6',
        region: 'global',
        labelled: false,
      },
      {
        type: 'google_compute_region_network_endpoint_group',
        googleName: 'cloudgate-plb3nv2t74e6',
        region: 'europe-west1',
        labelled: false,
      },
      {
        type: 'google_secret_manager_secret',
        googleName: 'cloudgate-plb3nv2t74e6-API_KEY',
        region: 'global',
        labelled: true,
      },
      {
        type: 'google_secret_manager_secret',
        googleName: 'cloudgate-plb3nv2t74e6-SESSION_SECRET',
        region: 'global',
        labelled: true,
      },
      // A secret's access binding has no name: Google's id for it.
      {
        type: 'google_secret_manager_secret_iam_member',
        googleName:
          'projects/example-project-123/secrets/cloudgate-plb3nv2t74e6-API_KEY/roles/secretmanager.secretAccessor/serviceAccount:cloudgate-plb3nv2t74e6@example-project-123.iam.gserviceaccount.com',
        region: 'global',
        labelled: false,
      },
      {
        type: 'google_secret_manager_secret_iam_member',
        googleName:
          'projects/example-project-123/secrets/cloudgate-plb3nv2t74e6-SESSION_SECRET/roles/secretmanager.secretAccessor/serviceAccount:cloudgate-plb3nv2t74e6@example-project-123.iam.gserviceaccount.com',
        region: 'global',
        labelled: false,
      },
      {
        type: 'google_secret_manager_secret_version',
        googleName:
          'projects/123456789012/secrets/cloudgate-plb3nv2t74e6-API_KEY/versions/1',
        region: 'global',
        labelled: false,
      },
      {
        type: 'google_secret_manager_secret_version',
        googleName:
          'projects/123456789012/secrets/cloudgate-plb3nv2t74e6-SESSION_SECRET/versions/1',
        region: 'global',
        labelled: false,
      },
      // Its account id, not the full name the provider gives as `name`.
      {
        type: 'google_service_account',
        googleName: 'cloudgate-plb3nv2t74e6',
        region: 'global',
        labelled: false,
      },
    ]);
    expect(listed[1].labels).toEqual(WEB_LABELS);
    expect(listed[2].labels).toEqual({});
  });

  it("shows a network endpoint group's region by its name, though Google stores a link to it", () => {
    // As Google stores it (the live walk).
    const show = stored('google-web-state');
    const link =
      'https://www.googleapis.com/compute/v1/projects/example-project-123/regions/europe-west1';
    const resources = show.values!.root_module!.resources!.map((one) =>
      one.type === 'google_compute_region_network_endpoint_group'
        ? { ...one, values: { ...one.values, region: link } }
        : one,
    );
    const listed = googleStateResources(
      { ...show, values: { ...show.values, root_module: { resources } } },
      'europe-west1',
    );

    expect(
      listed.find(
        (one) => one.type === 'google_compute_region_network_endpoint_group',
      )?.region,
    ).toBe('europe-west1');
  });

  it("lists the network's network and subnet as carrying no label of Cloudgate's", () => {
    const listed = googleStateResources(
      stored('google-network-state'),
      'europe-west1',
    );
    const of = (type: string) => listed.find((one) => one.type === type);

    expect(of('google_compute_network')).toEqual({
      type: 'google_compute_network',
      googleName: 'cloudgate-w33lemwkholw-net',
      region: 'global',
      labels: {},
      labelled: false,
    });
    expect(of('google_compute_subnetwork')).toMatchObject({
      googleName: 'cloudgate-w33lemwkholw-subnet',
      region: 'europe-west1',
      labelled: false,
    });
    expect(of('google_compute_global_address')).toMatchObject({
      region: 'global',
      labelled: true,
    });
    expect(of('google_certificate_manager_certificate')).toMatchObject({
      googleName: 'cloudgate-w33lemwkholw-default',
      region: 'global',
      labelled: true,
    });
  });

  it("puts a Cloud SQL database and user in their instance's region, and a Memorystore instance under its own id", () => {
    const listed = googleStateResources(
      {
        values: {
          root_module: {
            resources: [
              {
                mode: 'managed',
                type: 'google_sql_database_instance',
                values: { name: 'cloudgate-db', region: 'europe-west1' },
              },
              {
                mode: 'managed',
                type: 'google_sql_user',
                values: { name: 'app', password: 'SQL-USER-PASSWORD' },
              },
              {
                mode: 'managed',
                type: 'google_sql_database',
                values: { name: 'app' },
              },
              {
                mode: 'managed',
                type: 'google_memorystore_instance',
                values: {
                  instance_id: 'cloudgate-cache',
                  name: 'projects/p/locations/europe-west1/instances/cloudgate-cache',
                  location: 'europe-west1',
                },
              },
            ],
          },
        },
      },
      'europe-west1',
    );

    expect(
      listed.map(({ googleName, region }) => ({ googleName, region })),
    ).toEqual([
      { googleName: 'cloudgate-db', region: 'europe-west1' },
      { googleName: 'app', region: 'europe-west1' },
      { googleName: 'app', region: 'europe-west1' },
      { googleName: 'cloudgate-cache', region: 'europe-west1' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('SQL-USER-PASSWORD');
  });

  it("never shows a setting's value, an output, or a data source", () => {
    const state = stored('google-web-state');
    const withData: TofuStateShow = {
      values: {
        root_module: {
          resources: [
            ...(state.values?.root_module?.resources ?? []),
            {
              mode: 'data',
              type: 'google_project',
              values: { name: 'DATA-SOURCE-VALUE' },
            },
          ],
        },
      },
    };

    const text = JSON.stringify(googleStateResources(withData, 'europe-west1'));

    for (const secret of [...SECRETS, 'DATA-SOURCE-VALUE']) {
      expect(text).not.toContain(secret);
    }
  });

  it('lists nothing for an empty state', () => {
    expect(googleStateResources({}, 'europe-west1')).toEqual([]);
    expect(googleStateResources({ values: null }, 'europe-west1')).toEqual([]);
  });
});
