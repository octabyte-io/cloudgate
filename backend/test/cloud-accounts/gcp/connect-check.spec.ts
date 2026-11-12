import { runGoogleConnectCheck } from '../../../src/cloud-accounts/gcp/connect-check';
import {
  instanceGoogleRole,
  requiredApis,
} from '../../../src/cloud-accounts/gcp/deploy-role';
import { makeSigningKey } from '../../../src/cloud-accounts/gcp/id-token';
import type { GoogleCloudPort } from '../../../src/cloud-accounts/google-cloud.port';

const PROJECT = 'shop-prod';
const INPUT = {
  projectId: PROJECT,
  cloudAccountId: 'cloud-acct-1',
  workloadIdentityProvider:
    'projects/123/locations/global/workloadIdentityPools/p/providers/p',
  deployServiceAccount: `cloudgate-deploy-x@${PROJECT}.iam.gserviceaccount.com`,
  signingKey: makeSigningKey(),
  issuer: 'https://cloudgate.example.com/x',
};

/**
 * Google answering as a project whose deploy role and APIs predate Stack
 * VMs: the five calls the connect check makes, nothing else (the port is
 * the seam).
 */
function project(lacking: {
  permissions?: readonly string[];
  apis?: readonly string[];
}): GoogleCloudPort {
  const token = { accessToken: 'token', expiresAt: '2099-01-01T00:00:00Z' };
  const port: Pick<
    GoogleCloudPort,
    | 'exchangeToken'
    | 'impersonate'
    | 'getProject'
    | 'testIamPermissions'
    | 'enabledApis'
  > = {
    exchangeToken: () => Promise.resolve({ ok: true, value: token }),
    impersonate: () => Promise.resolve({ ok: true, value: token }),
    getProject: () =>
      Promise.resolve({
        ok: true,
        value: { projectId: PROJECT, projectNumber: '123' },
      }),
    testIamPermissions: (_token, _project, permissions) =>
      Promise.resolve({
        ok: true,
        value: permissions.filter(
          (one) => !(lacking.permissions ?? []).includes(one),
        ),
      }),
    enabledApis: () =>
      Promise.resolve({
        ok: true,
        value: requiredApis(8).filter(
          (api) => !(lacking.apis ?? []).includes(api),
        ),
      }),
  };
  return port as GoogleCloudPort;
}

/**
 * The connect check on a Google Cloud account whose role predates Stack
 * VMs (#1366): "Check now" names the missing IAP and instance permissions,
 * or IAP's API, as the Stack VM gap, and says how to close it.
 */
describe('runGoogleConnectCheck: the Stack VM gap', () => {
  const FIX =
    "Run the Cloud account's new setup script in Cloud Shell, which updates the role and turns on IAP's API, then Check now";
  const GAP =
    "the Stack VM permissions (IAP tunnelling to the Stack VMs, and making and removing a Stack VM with its disks, snapshot schedule and the network's Cloud Router)";

  it.each([
    ['Self-hosted', false, 7],
    ['Hosted', true, 8],
  ])(
    'on a %s instance, names the Stack VM permissions the role lacks, and the fix',
    async (_, isHosted, version) => {
      const result = await runGoogleConnectCheck(
        project({
          permissions: [
            'iap.tunnelInstances.accessViaIAP',
            'compute.instances.create',
          ],
        }),
        INPUT,
        instanceGoogleRole({ isHosted }),
      );

      expect(result).toEqual({
        ok: false,
        step: 'permissions',
        missing: [
          'compute.instances.create',
          'iap.tunnelInstances.accessViaIAP',
        ],
        message: `The deploy service account is missing 2 permissions of role version ${version}: compute.instances.create, iap.tunnelInstances.accessViaIAP. They are ${GAP}, which version ${version} adds. ${FIX}`,
      });
    },
  );

  it("names IAP's API, off, as the same gap", async () => {
    const result = await runGoogleConnectCheck(
      project({ apis: ['iap.googleapis.com'] }),
      INPUT,
      instanceGoogleRole({ isHosted: false }),
    );

    expect(result).toEqual({
      ok: false,
      step: 'apis',
      missing: ['iap.googleapis.com'],
      message: `1 API Cloudgate needs is off in project ${PROJECT}: iap.googleapis.com. It is a part of ${GAP}, which version 7 adds. ${FIX}`,
    });
  });

  it('names no gap when what is missing is not a Stack VM permission', async () => {
    const result = await runGoogleConnectCheck(
      project({ permissions: ['run.services.create'] }),
      INPUT,
      instanceGoogleRole({ isHosted: false }),
    );

    expect(result).toMatchObject({
      message:
        'The deploy service account is missing 1 permission of role version 7: run.services.create. Update the role from the setup script',
    });
  });

  it('passes a project set up with the new script', async () => {
    expect(
      await runGoogleConnectCheck(
        project({}),
        INPUT,
        instanceGoogleRole({ isHosted: true }),
      ),
    ).toEqual({ ok: true, policyVersion: 8, projectNumber: '123' });
  });
});
