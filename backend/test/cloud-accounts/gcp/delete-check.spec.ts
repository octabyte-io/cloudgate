import {
  findGoogleLabelLeftovers,
  findGoogleNetworkLeftovers,
  subnetHeld,
  subnetHoldSentence,
} from '../../../src/cloud-accounts/gcp/delete-check';
import type { GoogleLeftover } from '../../../src/cloud-accounts/gcp/delete-check';
import {
  idKey,
  networkNamePrefix,
} from '../../../src/cloud-accounts/gcp/definitions/names';
import type {
  FindByLabelRequest,
  FindByNameRequest,
  FoundByLabel,
  FoundByName,
  GoogleCloudPort,
} from '../../../src/cloud-accounts/google-cloud.port';

const SUBNET: GoogleLeftover = {
  type: 'compute.googleapis.com/Subnetwork',
  googleName: 'cloudgate-abc-subnet',
  region: 'europe-west1',
  label: null,
};
const NETWORK: GoogleLeftover = {
  type: 'compute.googleapis.com/Network',
  googleName: 'cloudgate-abc-net',
  region: 'global',
  label: null,
};
const IN_USE =
  "Error waiting for Deleting Subnetwork: The subnetwork resource 'projects/shop/regions/europe-west1/subnetworks/cloudgate-abc-subnet' is already being used by 'projects/shop/regions/europe-west1/addresses/serverless-ipv4-123'";

/**
 * Spec "The subnet hold": the search after a
 * Google network's removal, and telling Google's subnet hold from any other
 * leftover.
 */
describe('findGoogleNetworkLeftovers and the subnet hold', () => {
  describe('subnetHeld', () => {
    it('is held when Google refused the subnet as in use and only the subnet and network are left', () => {
      expect(subnetHeld([SUBNET, NETWORK], IN_USE)).toBe(true);
      expect(subnetHeld([SUBNET], 'resourceInUseByAnotherResource')).toBe(true);
    });

    it('is not held when anything else is left, no subnet is, or Google refused for another reason', () => {
      const address: GoogleLeftover = {
        type: 'compute.googleapis.com/Address',
        googleName: 'cloudgate-abc-ip',
        region: 'global',
        label: 'cloudgate-state=x',
      };
      expect(subnetHeld([SUBNET, NETWORK, address], IN_USE)).toBe(false);
      expect(subnetHeld([NETWORK], IN_USE)).toBe(false);
      expect(
        subnetHeld([SUBNET, NETWORK], 'Error 403: Permission denied'),
      ).toBe(false);
      expect(subnetHeld([SUBNET, NETWORK], null)).toBe(false);
    });
  });

  describe('subnetHoldSentence', () => {
    it('names the subnet and network, and when Cloudgate tries again', () => {
      expect(
        subnetHoldSentence([SUBNET, NETWORK], '2026-10-20T16:07:30.000Z'),
      ).toBe(
        'Google Cloud still holds subnet cloudgate-abc-subnet and network cloudgate-abc-net. Google releases this 1–2 hours after the services are gone; Cloudgate will try again at 16:07 UTC',
      );
    });

    it('says to Retry once Cloudgate has no try of its own left', () => {
      expect(subnetHoldSentence([SUBNET, NETWORK], null)).toBe(
        'Google Cloud still holds subnet cloudgate-abc-subnet and network cloudgate-abc-net. Google releases this 1–2 hours after the services are gone; Cloudgate has tried again twice by itself, so Retry once Google has released it, or Forget it',
      );
    });
  });

  describe('findGoogleNetworkLeftovers', () => {
    function port(found: FoundByName[]) {
      const asked: FindByNameRequest[] = [];
      const google = {
        findByName: (_token: unknown, request: FindByNameRequest) => {
          asked.push(request);
          return Promise.resolve({
            ok: true as const,
            value: found.filter(
              (one) => one.resourceType === request.resourceType,
            ),
          });
        },
      } as unknown as GoogleCloudPort;
      return { google, asked };
    }

    it('lists each network kind by its name prefix, private link included, and the map entries under its map', async () => {
      const { google, asked } = port([
        {
          resourceType: 'google_compute_subnetwork',
          name: `${networkNamePrefix('env-1')}psc`,
          id: 'x',
        },
      ]);

      const check = await findGoogleNetworkLeftovers(
        google,
        { accessToken: 't' },
        {
          projectId: 'shop',
          region: 'europe-west1',
          environmentId: 'env-1',
          certificateMap: 'cloudgate-certs',
        },
      );

      const prefix = networkNamePrefix('env-1');
      expect(
        asked.map((one) => [
          one.resourceType,
          one.namePrefix,
          one.parent ?? null,
        ]),
      ).toEqual([
        [
          'google_certificate_manager_certificate_map_entry',
          'cloudgate-',
          'cloudgate-certs',
        ],
        ['google_compute_global_forwarding_rule', prefix, null],
        ['google_compute_target_https_proxy', prefix, null],
        ['google_compute_target_http_proxy', prefix, null],
        ['google_compute_url_map', prefix, null],
        ['google_certificate_manager_certificate', prefix, null],
        ['google_certificate_manager_certificate_map', prefix, null],
        ['google_compute_global_address', prefix, null],
        ['google_network_connectivity_service_connection_policy', prefix, null],
        ['google_compute_firewall', prefix, null],
        // The Private web services' run.app zone.
        ['google_dns_managed_zone', prefix, null],
        ['google_compute_subnetwork', prefix, null],
        ['google_compute_network', prefix, null],
      ]);
      expect(check).toEqual({
        ok: true,
        left: [
          {
            type: 'compute.googleapis.com/Subnetwork',
            googleName: `${prefix}psc`,
            region: 'europe-west1',
            label: null,
          },
        ],
      });
    });

    it('reads a certificate map the destroy removed as holding no entry, and still finds the held subnet and network', async () => {
      // The live walk: the map went with the network's destroy, Google
      // answered NOT_FOUND for its entries, and the subnet it held was
      // missed.
      const prefix = networkNamePrefix('env-1');
      const google = {
        findByName: (_token: unknown, request: FindByNameRequest) =>
          Promise.resolve(
            request.parent
              ? {
                  ok: false as const,
                  code: 'NOT_FOUND',
                  message: `Resource 'certificateMaps/${request.parent}' was not found`,
                }
              : {
                  ok: true as const,
                  value:
                    request.resourceType === 'google_compute_subnetwork'
                      ? [
                          {
                            resourceType: request.resourceType,
                            name: `${prefix}subnet`,
                            id: 's',
                          },
                        ]
                      : request.resourceType === 'google_compute_network'
                        ? [
                            {
                              resourceType: request.resourceType,
                              name: `${prefix}net`,
                              id: 'n',
                            },
                          ]
                        : [],
                },
          ),
      } as unknown as GoogleCloudPort;

      const check = await findGoogleNetworkLeftovers(
        google,
        { accessToken: 't' },
        {
          projectId: 'shop',
          region: 'europe-west1',
          environmentId: 'env-1',
          certificateMap: `${prefix}certs`,
        },
      );

      expect(check).toEqual({
        ok: true,
        left: [
          expect.objectContaining({
            type: 'compute.googleapis.com/Subnetwork',
            googleName: `${prefix}subnet`,
          }),
          expect.objectContaining({
            type: 'compute.googleapis.com/Network',
            googleName: `${prefix}net`,
          }),
        ],
      });
      if (!check.ok) return;
      expect(
        subnetHeld(
          check.left,
          "The subnetwork resource '…' is already being used by '…/addresses/serverless-ipv4-cloudrun-1', resourceInUseByAnotherResource",
        ),
      ).toBe(true);
    });

    it('is a search that did not happen when Google refuses a list call', async () => {
      const google = {
        findByName: () =>
          Promise.resolve({
            ok: false as const,
            code: 'PERMISSION_DENIED',
            message: 'Permission compute.networks.list denied',
          }),
      } as unknown as GoogleCloudPort;

      expect(
        await findGoogleNetworkLeftovers(
          google,
          { accessToken: 't' },
          {
            projectId: 'shop',
            region: 'europe-west1',
            environmentId: 'env-1',
            certificateMap: null,
          },
        ),
      ).toEqual({
        ok: false,
        message:
          'Google refused the search for compute.googleapis.com/ForwardingRule: Permission compute.networks.list denied',
      });
    });
  });
});

/**
 * Spec "Deleting the Environment": the label search after an
 * Environment's Delete, by Cloudgate's Environment label, naming each
 * thing it finds by type, Google id, region and label.
 */
describe('findGoogleLabelLeftovers', () => {
  const ENV_LABEL = `cloudgate-environment=${idKey('env-1')}`;

  it("asks for the Environment's label in the project and names each thing found by type, Google id, region and Cloudgate's label", async () => {
    const asked: FindByLabelRequest[] = [];
    const found: FoundByLabel[] = [
      {
        type: 'compute.googleapis.com/Address',
        id: 'projects/shop/regions/europe-west1/addresses/sca-auto-addr-1',
        region: 'europe-west1',
        labels: {
          'cloudgate-environment': idKey('env-1'),
          'cloudgate-state': 'statekey',
        },
      },
      {
        type: 'memorystore.googleapis.com/Instance',
        id: 'projects/shop/locations/europe-west1/instances/cloudgate-redis',
        region: 'europe-west1',
        labels: { 'cloudgate-environment': idKey('env-1') },
      },
    ];
    const google = {
      findByLabel: (_token: unknown, request: FindByLabelRequest) => {
        asked.push(request);
        return Promise.resolve({ ok: true as const, value: found });
      },
    } as unknown as GoogleCloudPort;

    const check = await findGoogleLabelLeftovers(
      google,
      { accessToken: 't' },
      { projectId: 'shop', environmentId: 'env-1' },
    );

    expect(asked).toEqual([
      {
        projectId: 'shop',
        label: { key: 'cloudgate-environment', value: idKey('env-1') },
      },
    ]);
    expect(check).toEqual({
      ok: true,
      left: [
        {
          type: 'compute.googleapis.com/Address',
          googleName:
            'projects/shop/regions/europe-west1/addresses/sca-auto-addr-1',
          region: 'europe-west1',
          label: 'cloudgate-state=statekey',
        },
        {
          type: 'memorystore.googleapis.com/Instance',
          googleName:
            'projects/shop/locations/europe-west1/instances/cloudgate-redis',
          region: 'europe-west1',
          label: ENV_LABEL,
        },
      ],
    });
  });

  it('is a search that did not happen when Google refuses it, or does not answer', async () => {
    const refusing = {
      findByLabel: () =>
        Promise.resolve({
          ok: false as const,
          code: 'PERMISSION_DENIED',
          message: "Required 'compute.addresses.list' permission",
        }),
    } as unknown as GoogleCloudPort;
    const silent = {
      findByLabel: () => Promise.reject(new Error('socket hang up')),
    } as unknown as GoogleCloudPort;
    const search = { projectId: 'shop', environmentId: 'env-1' };

    expect(
      await findGoogleLabelLeftovers(refusing, { accessToken: 't' }, search),
    ).toEqual({
      ok: false,
      message: `Google refused the search by Cloudgate's label ${ENV_LABEL}: Required 'compute.addresses.list' permission`,
    });
    expect(
      await findGoogleLabelLeftovers(silent, { accessToken: 't' }, search),
    ).toEqual({
      ok: false,
      message:
        "Google Cloud did not answer the search by Cloudgate's label: socket hang up",
    });
  });
});
