import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';

import { GoogleCloudAdapter } from '../../../src/cloud-accounts/gcp/google-cloud.adapter';
import type { Env } from '../../../src/common/config/env.schema';

/**
 * The Google adapter against Google's REST shapes, at the `fetch` boundary:
 * what it sends, and how Google's answers and refusals come back. Nothing
 * reaches Google.
 */

type Reply = { status: number; body: unknown };

describe('GoogleCloudAdapter', () => {
  // No OpenTofu is installed here: no `tofu` runs in these tests.
  const adapter = new GoogleCloudAdapter({
    get: () => undefined,
  } as unknown as ConfigService<Env, true>);
  adapter.imageDeletePollMs = 0;
  adapter.operationPollMs = 0;
  const token = { accessToken: 'ya29.token' };
  let sent: { url: string; init: RequestInit }[];
  let replies: Reply[];
  const realFetch = global.fetch;

  beforeEach(() => {
    sent = [];
    replies = [];
    global.fetch = jest.fn(
      (url: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: url instanceof Request ? url.url : url.toString(),
          init: init ?? {},
        });
        const reply = replies.shift() ?? { status: 200, body: {} };
        return Promise.resolve(
          new Response(JSON.stringify(reply.body), { status: reply.status }),
        );
      },
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('trades a signed token at STS for the provider audience', async () => {
    replies.push({ status: 200, body: { access_token: 'federated' } });

    const answer = await adapter.exchangeToken({
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
      subjectToken: 'header.payload.signature',
    });

    expect(answer).toEqual({ ok: true, value: { accessToken: 'federated' } });
    expect(sent[0].url).toBe('https://sts.googleapis.com/v1/token');
    const form = new URLSearchParams(sent[0].init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: 'header.payload.signature',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
  });

  it("answers STS's OAuth refusal in its own words", async () => {
    replies.push({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'The audience in ID Token does not match',
      },
    });

    expect(
      await adapter.exchangeToken({ audience: 'a', subjectToken: 't' }),
    ).toEqual({
      ok: false,
      code: 'invalid_grant',
      message: 'The audience in ID Token does not match',
    });
  });

  it('steps into the service account for the asked lifetime', async () => {
    replies.push({ status: 200, body: { accessToken: 'impersonated' } });

    const answer = await adapter.impersonate(token, {
      serviceAccount: 'deploy@shop-prod.iam.gserviceaccount.com',
      lifetimeSeconds: 300,
    });

    expect(answer).toEqual({
      ok: true,
      value: { accessToken: 'impersonated' },
    });
    expect(sent[0].url).toBe(
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/deploy%40shop-prod.iam.gserviceaccount.com:generateAccessToken',
    );
    expect(JSON.parse(sent[0].init.body as string)).toEqual({
      scope: ['https://www.googleapis.com/auth/cloud-platform'],
      lifetime: '300s',
    });
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.token',
    );
  });

  it.each([
    ['NOT_FOUND', 404],
    ['PERMISSION_DENIED', 403],
  ])("answers Google's %s as a refusal, not a throw", async (status, code) => {
    replies.push({
      status: code,
      body: { error: { code, status, message: `${status} said Google` } },
    });

    expect(await adapter.getProject(token, 'shop-prod')).toEqual({
      ok: false,
      code: status,
      message: `${status} said Google`,
    });
  });

  it("reads a project's id and number", async () => {
    replies.push({
      status: 200,
      body: { projectId: 'shop-prod', projectNumber: '123456789012' },
    });

    expect(await adapter.getProject(token, 'shop-prod')).toEqual({
      ok: true,
      value: { projectId: 'shop-prod', projectNumber: '123456789012' },
    });
    expect(sent[0].url).toBe(
      'https://cloudresourcemanager.googleapis.com/v1/projects/shop-prod',
    );
  });

  it('tests permissions 100 at a time and answers every granted one', async () => {
    const permissions = Array.from({ length: 150 }, (_, i) => `a.b.c${i}`);
    replies.push(
      { status: 200, body: { permissions: ['a.b.c0'] } },
      { status: 200, body: {} },
    );

    const answer = await adapter.testIamPermissions(
      token,
      'shop-prod',
      permissions,
    );

    expect(answer).toEqual({ ok: true, value: ['a.b.c0'] });
    expect(
      sent.map(
        (call) =>
          (JSON.parse(call.init.body as string) as { permissions: string[] })
            .permissions.length,
      ),
    ).toEqual([100, 50]);
  });

  it('lists every enabled API across pages', async () => {
    replies.push(
      {
        status: 200,
        body: {
          services: [
            {
              name: 'projects/1/services/run.googleapis.com',
              config: { name: 'run.googleapis.com' },
            },
          ],
          nextPageToken: 'next',
        },
      },
      {
        status: 200,
        body: {
          services: [{ name: 'projects/1/services/iam.googleapis.com' }],
        },
      },
    );

    expect(await adapter.enabledApis(token, '1')).toEqual({
      ok: true,
      value: ['run.googleapis.com', 'iam.googleapis.com'],
    });
    expect(sent[1].url).toContain('pageToken=next');
    expect(sent[0].url).toContain('filter=state%3AENABLED');
  });

  it.each([
    [
      'run.googleapis.com',
      'https://run.googleapis.com/v1/projects/shop-prod/locations',
    ],
    [
      'artifactregistry.googleapis.com',
      'https://artifactregistry.googleapis.com/v1/projects/shop-prod/locations',
    ],
  ] as const)(
    "lists %s's locations by region id, across pages",
    async (api, url) => {
      replies.push(
        {
          status: 200,
          body: {
            locations: [
              {
                name: 'projects/shop-prod/locations/europe-west1',
                locationId: 'europe-west1',
              },
            ],
            nextPageToken: 'next',
          },
        },
        {
          status: 200,
          body: {
            locations: [{ name: 'projects/shop-prod/locations/us-central1' }],
          },
        },
      );

      expect(await adapter.listLocations(token, 'shop-prod', api)).toEqual({
        ok: true,
        value: ['europe-west1', 'us-central1'],
      });
      expect(sent[0].url.split('?')[0]).toBe(url);
      expect(sent[1].url).toContain('pageToken=next');
      expect(sent[0].init.headers).toEqual({
        authorization: 'Bearer ya29.token',
      });
    },
  );

  it("counts the project's networks across pages", async () => {
    replies.push(
      {
        status: 200,
        body: {
          items: [{ name: 'default' }, { name: 'a' }],
          nextPageToken: 'n',
        },
      },
      { status: 200, body: { items: [{ name: 'b' }] } },
    );

    expect(await adapter.countNetworks(token, 'shop-prod')).toEqual({
      ok: true,
      value: 3,
    });
    expect(sent[0].url.split('?')[0]).toBe(
      'https://compute.googleapis.com/compute/v1/projects/shop-prod/global/networks',
    );
    expect(sent[1].url).toContain('pageToken=n');
  });

  it('counts none in a project with no network', async () => {
    replies.push({ status: 200, body: {} });

    expect(await adapter.countNetworks(token, 'shop-prod')).toEqual({
      ok: true,
      value: 0,
    });
  });

  it("answers Compute's refusal in its own words", async () => {
    replies.push({
      status: 403,
      body: {
        error: {
          status: 'PERMISSION_DENIED',
          message: "Required 'compute.networks.list' permission",
        },
      },
    });

    expect(await adapter.countNetworks(token, 'shop-prod')).toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: "Required 'compute.networks.list' permission",
    });
  });

  it("finds a Compute kind by Cloudgate's name prefix, filtered on Google's side, with its import id", async () => {
    replies.push({
      status: 200,
      body: {
        items: [
          {
            name: 'cloudgate-abcdefghijkl-net',
            description: 'Cloudgate cloud-account=ca environment=env state=s',
          },
          { name: 'someone-elses-net' },
        ],
      },
    });

    const answer = await adapter.findByName(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      resourceType: 'google_compute_network',
      namePrefix: 'cloudgate-abcdefghijkl-',
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        {
          resourceType: 'google_compute_network',
          name: 'cloudgate-abcdefghijkl-net',
          id: 'projects/shop-prod/global/networks/cloudgate-abcdefghijkl-net',
          description: 'Cloudgate cloud-account=ca environment=env state=s',
        },
      ],
    });
    const url = new URL(sent[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://compute.googleapis.com/compute/v1/projects/shop-prod/global/networks',
    );
    expect(url.searchParams.get('filter')).toBe(
      'name eq "cloudgate-abcdefghijkl-.*"',
    );
  });

  it.each([
    [
      'google_compute_instance',
      'zones/europe-west1-b/instances',
      'cloudgate-abcdefghijkl',
    ],
    [
      'google_compute_disk',
      'zones/europe-west1-b/disks',
      'cloudgate-abcdefghijkl-data',
    ],
    [
      'google_compute_resource_policy',
      'regions/europe-west1/resourcePolicies',
      'cloudgate-abcdefghijkl-snapshots',
    ],
    [
      'google_compute_router',
      'regions/europe-west1/routers',
      'cloudgate-abcdefghijkl-router',
    ],
  ])(
    "finds a Stack VM's %s by its fixed name, in its zone or region",
    async (resourceType, collection, name) => {
      replies.push({
        status: 200,
        body: { items: [{ name, description: 'Cloudgate mark' }] },
      });

      const answer = await adapter.findByName(token, {
        projectId: 'shop-prod',
        region: 'europe-west1',
        resourceType,
        namePrefix: 'cloudgate-abcdefghijkl',
      });

      expect(answer).toEqual({
        ok: true,
        value: [
          {
            resourceType,
            name,
            id: `projects/shop-prod/${collection}/${name}`,
            description: 'Cloudgate mark',
          },
        ],
      });
      expect(sent[0].url.split('?')[0]).toBe(
        `https://compute.googleapis.com/compute/v1/projects/shop-prod/${collection}`,
      );
    },
  );

  it('finds a Cloud Run service by its fixed name, through every page, keeping its labels', async () => {
    const service = (key: string) => ({
      name: `projects/shop-prod/locations/europe-west1/services/cloudgate-${key}`,
      labels: { 'cloudgate-state': 'k' },
    });
    replies.push(
      {
        status: 200,
        body: { services: [service('aaaaaaaaaaaa')], nextPageToken: 'n' },
      },
      { status: 200, body: { services: [service('bbbbbbbbbbbb')] } },
    );

    const answer = await adapter.findByName(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      resourceType: 'google_cloud_run_v2_service',
      namePrefix: 'cloudgate-bbbbbbbbbbbb',
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        {
          resourceType: 'google_cloud_run_v2_service',
          name: 'cloudgate-bbbbbbbbbbbb',
          id: 'projects/shop-prod/locations/europe-west1/services/cloudgate-bbbbbbbbbbbb',
          labels: { 'cloudgate-state': 'k' },
        },
      ],
    });
    expect(sent[0].url.split('?')[0]).toBe(
      'https://run.googleapis.com/v2/projects/shop-prod/locations/europe-west1/services',
    );
    expect(sent[1].url).toContain('pageToken=n');
  });

  it('finds a certificate map entry under each map found by the same prefix, by its own full name', async () => {
    const maps = 'projects/shop-prod/locations/global/certificateMaps';
    replies.push(
      {
        status: 200,
        body: {
          certificateMaps: [
            { name: `${maps}/cloudgate-abcdefghijkl-certs` },
            { name: `${maps}/someone-elses-map` },
          ],
        },
      },
      {
        status: 200,
        body: {
          certificateMapEntries: [
            {
              name: `${maps}/cloudgate-abcdefghijkl-certs/certificateMapEntries/cloudgate-abcdefghijkl-default`,
              description: 'Cloudgate cloud-account=ca environment=env state=s',
              labels: { 'cloudgate-state': 'k' },
            },
            {
              name: `${maps}/cloudgate-abcdefghijkl-certs/certificateMapEntries/cloudgate-zzzzzzzzzzzz`,
            },
          ],
        },
      },
    );

    const answer = await adapter.findByName(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      resourceType: 'google_certificate_manager_certificate_map_entry',
      namePrefix: 'cloudgate-abcdefghijkl-',
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        {
          resourceType: 'google_certificate_manager_certificate_map_entry',
          name: 'cloudgate-abcdefghijkl-default',
          id: `${maps}/cloudgate-abcdefghijkl-certs/certificateMapEntries/cloudgate-abcdefghijkl-default`,
          description: 'Cloudgate cloud-account=ca environment=env state=s',
          labels: { 'cloudgate-state': 'k' },
        },
      ],
    });
    expect(sent.map((one) => one.url.split('?')[0])).toEqual([
      `https://certificatemanager.googleapis.com/v1/${maps}`,
      `https://certificatemanager.googleapis.com/v1/${maps}/cloudgate-abcdefghijkl-certs/certificateMapEntries`,
    ]);
  });

  it('finds a Cloud Storage bucket by its name’s prefix, in the project, with its labels', async () => {
    replies.push({
      status: 200,
      body: {
        items: [
          {
            name: 'cloudgate-abcdefghijkl-k3f9a2qd',
            labels: { 'cloudgate-state': 'k' },
          },
        ],
      },
    });

    const answer = await adapter.findByName(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      resourceType: 'google_storage_bucket',
      namePrefix: 'cloudgate-abcdefghijkl',
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        {
          resourceType: 'google_storage_bucket',
          name: 'cloudgate-abcdefghijkl-k3f9a2qd',
          id: 'cloudgate-abcdefghijkl-k3f9a2qd',
          labels: { 'cloudgate-state': 'k' },
        },
      ],
    });
    const url = new URL(sent[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://storage.googleapis.com/storage/v1/b',
    );
    expect(url.searchParams.get('project')).toBe('shop-prod');
    expect(url.searchParams.get('prefix')).toBe('cloudgate-abcdefghijkl');
  });

  it("answers a list refusal in Google's own words", async () => {
    replies.push({
      status: 403,
      body: {
        error: {
          status: 'PERMISSION_DENIED',
          message:
            'Cloud Run Admin API has not been used in project 123456789012 before or it is disabled.',
        },
      },
    });

    expect(
      await adapter.findByName(token, {
        projectId: 'shop-prod',
        region: 'europe-west1',
        resourceType: 'google_cloud_run_v2_service',
        namePrefix: 'cloudgate-',
      }),
    ).toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message:
        'Cloud Run Admin API has not been used in project 123456789012 before or it is disabled.',
    });
  });

  describe("a static site's objects in Cloud Storage", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudgate-adapter-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('lists every object under a prefix through every page, each with its MD5 and size', async () => {
      replies.push(
        {
          status: 200,
          body: {
            items: [{ name: 'live/index.html', md5Hash: 'aGk=', size: '2' }],
            nextPageToken: 'next',
          },
        },
        { status: 200, body: { items: [{ name: 'live/app.js', size: '7' }] } },
      );

      const answer = await adapter.listObjects(token, {
        bucket: 'cloudgate-abc-p4x8m2rt',
        prefix: 'live/',
      });

      expect(answer).toEqual({
        ok: true,
        value: [
          { name: 'live/index.html', md5Hash: 'aGk=', size: 2 },
          { name: 'live/app.js', md5Hash: null, size: 7 },
        ],
      });
      expect(sent[0].url.split('?')[0]).toBe(
        'https://storage.googleapis.com/storage/v1/b/cloudgate-abc-p4x8m2rt/o',
      );
      expect(new URL(sent[0].url).searchParams.get('prefix')).toBe('live/');
      expect(new URL(sent[1].url).searchParams.get('pageToken')).toBe('next');
    });

    it('uploads a file as one object with the content type it is served as', async () => {
      const file = join(dir, 'index.html');
      writeFileSync(file, '<h1>hi</h1>');
      replies.push({
        status: 200,
        body: { name: 'deployments/d1/index.html', md5Hash: 'x', size: '11' },
      });

      const answer = await adapter.uploadObject(token, {
        bucket: 'site',
        name: 'deployments/d1/index.html',
        file,
        contentType: 'text/html; charset=utf-8',
      });

      expect(answer).toEqual({
        ok: true,
        value: { name: 'deployments/d1/index.html', md5Hash: 'x', size: 11 },
      });
      const url = new URL(sent[0].url);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://storage.googleapis.com/upload/storage/v1/b/site/o',
      );
      expect(url.searchParams.get('uploadType')).toBe('media');
      expect(url.searchParams.get('name')).toBe('deployments/d1/index.html');
      expect(sent[0].init.method).toBe('POST');
      expect(
        (sent[0].init.headers as Record<string, string>)['content-type'],
      ).toBe('text/html; charset=utf-8');
    });

    it('copies within the bucket on Google’s side, asking again until the rewrite is done', async () => {
      replies.push(
        { status: 200, body: { done: false, rewriteToken: 'more' } },
        { status: 200, body: { done: true } },
      );

      const answer = await adapter.copyObject(token, {
        bucket: 'site',
        from: 'deployments/d1/about/index.html',
        to: 'live/about/',
      });

      expect(answer).toEqual({ ok: true, value: true });
      expect(sent.map((one) => one.url.split('?')[0])).toEqual([
        'https://storage.googleapis.com/storage/v1/b/site/o/deployments%2Fd1%2Fabout%2Findex.html/rewriteTo/b/site/o/live%2Fabout%2F',
        'https://storage.googleapis.com/storage/v1/b/site/o/deployments%2Fd1%2Fabout%2Findex.html/rewriteTo/b/site/o/live%2Fabout%2F',
      ]);
      expect(new URL(sent[1].url).searchParams.get('rewriteToken')).toBe(
        'more',
      );
    });

    it('deletes one object, and answers one already gone as Google’s NOT_FOUND', async () => {
      replies.push({
        status: 404,
        body: { error: { status: 'NOT_FOUND', message: 'No such object' } },
      });

      const answer = await adapter.deleteObject(token, {
        bucket: 'site',
        name: 'live/old.js',
      });

      expect(answer).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'No such object',
      });
      expect(sent[0].url).toBe(
        'https://storage.googleapis.com/storage/v1/b/site/o/live%2Fold.js',
      );
      expect(sent[0].init.method).toBe('DELETE');
    });
  });

  describe("findByName's list call for each kind a Delete's search reads", () => {
    const at = 'projects/shop-prod/locations';
    const KINDS: readonly [string, string, string][] = [
      [
        'google_compute_backend_service',
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/global/backendServices',
        'items',
      ],
      // A static site's Cloud CDN backend bucket.
      [
        'google_compute_backend_bucket',
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/global/backendBuckets',
        'items',
      ],
      [
        'google_compute_region_network_endpoint_group',
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/regions/europe-west1/networkEndpointGroups',
        'items',
      ],
      [
        'google_cloud_run_v2_service',
        `https://run.googleapis.com/v2/${at}/europe-west1/services`,
        'services',
      ],
      // A Worker's.
      [
        'google_cloud_run_v2_worker_pool',
        `https://run.googleapis.com/v2/${at}/europe-west1/workerPools`,
        'workerPools',
      ],
      // A Cron service's job.
      [
        'google_cloud_run_v2_job',
        `https://run.googleapis.com/v2/${at}/europe-west1/jobs`,
        'jobs',
      ],
      [
        'google_artifact_registry_repository',
        `https://artifactregistry.googleapis.com/v1/${at}/europe-west1/repositories`,
        'repositories',
      ],
      [
        'google_secret_manager_secret',
        'https://secretmanager.googleapis.com/v1/projects/shop-prod/secrets',
        'secrets',
      ],
      [
        'google_certificate_manager_certificate',
        `https://certificatemanager.googleapis.com/v1/${at}/global/certificates`,
        'certificates',
      ],
      [
        'google_certificate_manager_dns_authorization',
        `https://certificatemanager.googleapis.com/v1/${at}/global/dnsAuthorizations`,
        'dnsAuthorizations',
      ],
    ];

    it.each(KINDS)(
      'lists %s by name prefix, keeping only Cloudgate-named things with their labels',
      async (resourceType, url, items) => {
        const named = (name: string) =>
          url.startsWith('https://compute.')
            ? { name }
            : {
                name: `${url.split('/v1/').pop()?.split('/v2/').pop()}/${name}`,
              };
        replies.push({
          status: 200,
          body: {
            [items]: [
              {
                ...named('cloudgate-abcdefghijkl'),
                labels: { 'cloudgate-state': 'k' },
              },
              named('someone-elses'),
            ],
          },
        });

        const answer = await adapter.findByName(token, {
          projectId: 'shop-prod',
          region: 'europe-west1',
          resourceType,
          namePrefix: 'cloudgate-abcdefghijkl',
        });

        expect(answer).toEqual({
          ok: true,
          value: [
            expect.objectContaining({
              resourceType,
              name: 'cloudgate-abcdefghijkl',
              labels: { 'cloudgate-state': 'k' },
            }),
          ],
        });
        expect(sent[0].url.split('?')[0]).toBe(url);
      },
    );

    it('lists a certificate map entry under the certificate map it names, and else under the maps found by its prefix', async () => {
      replies.push({
        status: 200,
        body: {
          certificateMapEntries: [
            {
              name: `${at}/global/certificateMaps/cloudgate-envkey-certs/certificateMapEntries/cloudgate-domainkey12`,
            },
          ],
        },
      });

      const answer = await adapter.findByName(token, {
        projectId: 'shop-prod',
        region: 'europe-west1',
        resourceType: 'google_certificate_manager_certificate_map_entry',
        namePrefix: 'cloudgate-domainkey12',
        parent: 'cloudgate-envkey-certs',
      });

      expect(answer).toEqual({
        ok: true,
        value: [
          {
            resourceType: 'google_certificate_manager_certificate_map_entry',
            name: 'cloudgate-domainkey12',
            id: `${at}/global/certificateMaps/cloudgate-envkey-certs/certificateMapEntries/cloudgate-domainkey12`,
          },
        ],
      });
      expect(sent[0].url.split('?')[0]).toBe(
        `https://certificatemanager.googleapis.com/v1/${at}/global/certificateMaps/cloudgate-envkey-certs/certificateMapEntries`,
      );

      sent.length = 0;
      expect(
        await adapter.findByName(token, {
          projectId: 'shop-prod',
          region: 'europe-west1',
          resourceType: 'google_certificate_manager_certificate_map_entry',
          namePrefix: 'cloudgate-domainkey12',
        }),
      ).toEqual({ ok: true, value: [] });
      // No map is named for a Domain, so only the maps' list call is sent.
      expect(sent.map((one) => one.url.split('?')[0])).toEqual([
        `https://certificatemanager.googleapis.com/v1/${at}/global/certificateMaps`,
      ]);
    });

    it("finds a service account by its email's first part", async () => {
      replies.push({
        status: 200,
        body: {
          accounts: [
            {
              name: 'projects/shop-prod/serviceAccounts/cloudgate-abcdefghijkl@shop-prod.iam.gserviceaccount.com',
              email: 'cloudgate-abcdefghijkl@shop-prod.iam.gserviceaccount.com',
              description: 'Cloudgate cloud-account=ca environment=env state=s',
            },
            {
              name: 'projects/shop-prod/serviceAccounts/deploy@shop-prod.iam.gserviceaccount.com',
              email: 'deploy@shop-prod.iam.gserviceaccount.com',
            },
          ],
        },
      });

      const answer = await adapter.findByName(token, {
        projectId: 'shop-prod',
        region: 'europe-west1',
        resourceType: 'google_service_account',
        namePrefix: 'cloudgate-abcdefghijkl',
      });

      expect(answer).toEqual({
        ok: true,
        value: [
          {
            resourceType: 'google_service_account',
            name: 'cloudgate-abcdefghijkl',
            id: 'projects/shop-prod/serviceAccounts/cloudgate-abcdefghijkl@shop-prod.iam.gserviceaccount.com',
            description: 'Cloudgate cloud-account=ca environment=env state=s',
          },
        ],
      });
      expect(sent[0].url.split('?')[0]).toBe(
        'https://iam.googleapis.com/v1/projects/shop-prod/serviceAccounts',
      );
    });

    it('answers "permission denied" as a refusal, not an exception', async () => {
      replies.push({
        status: 403,
        body: {
          error: {
            status: 'PERMISSION_DENIED',
            message: "Permission 'secretmanager.secrets.list' denied",
          },
        },
      });

      expect(
        await adapter.findByName(token, {
          projectId: 'shop-prod',
          region: 'europe-west1',
          resourceType: 'google_secret_manager_secret',
          namePrefix: 'cloudgate-abcdefghijkl',
        }),
      ).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: "Permission 'secretmanager.secrets.list' denied",
      });
    });
  });

  describe("findByLabel: the label search after an Environment's Delete", () => {
    const LABELS = {
      'cloudgate-environment': 'envkeyenvkey',
      'cloudgate-state': 'statekeystat',
    };
    const request = {
      projectId: 'shop-prod',
      label: { key: 'cloudgate-environment', value: 'envkeyenvkey' },
    };

    it('lists each labelled kind in every region, filtered by the label on Google’s side, each with its type, Google id, region and labels', async () => {
      replies.push(
        // Compute's aggregated addresses, through every page.
        {
          status: 200,
          body: {
            items: {
              'regions/europe-west1': {
                addresses: [
                  {
                    name: 'sca-auto-addr-1',
                    status: 'RESERVED',
                    labels: LABELS,
                  },
                ],
              },
              'regions/us-east1': {
                warning: { code: 'NO_RESULTS_ON_PAGE' },
              },
            },
            nextPageToken: 'n',
          },
        },
        {
          status: 200,
          body: {
            items: {
              global: {
                addresses: [{ name: 'cloudgate-x-ip', labels: LABELS }],
              },
            },
          },
        },
        // Compute's aggregated forwarding rules.
        {
          status: 200,
          body: {
            items: {
              'regions/europe-west1': {
                forwardingRules: [
                  {
                    name: 'sca-auto-fr-1',
                    pscConnectionStatus: 'CLOSED',
                    labels: LABELS,
                  },
                ],
              },
            },
          },
        },
        // Cloud SQL, which keeps its labels in its settings.
        {
          status: 200,
          body: {
            items: [
              {
                name: 'cloudgate-pg1',
                region: 'europe-west1',
                settings: { userLabels: LABELS },
              },
            ],
          },
        },
        // Memorystore, in every location.
        {
          status: 200,
          body: {
            instances: [
              {
                name: 'projects/shop-prod/locations/europe-west1/instances/cloudgate-redis',
                labels: LABELS,
              },
            ],
          },
        },
      );

      const answer = await adapter.findByLabel(token, request);

      expect(answer).toEqual({
        ok: true,
        value: [
          {
            type: 'compute.googleapis.com/Address',
            id: 'projects/shop-prod/regions/europe-west1/addresses/sca-auto-addr-1',
            region: 'europe-west1',
            labels: LABELS,
          },
          {
            type: 'compute.googleapis.com/Address',
            id: 'projects/shop-prod/global/addresses/cloudgate-x-ip',
            region: 'global',
            labels: LABELS,
          },
          {
            type: 'compute.googleapis.com/ForwardingRule',
            id: 'projects/shop-prod/regions/europe-west1/forwardingRules/sca-auto-fr-1',
            region: 'europe-west1',
            labels: LABELS,
          },
          {
            type: 'sqladmin.googleapis.com/Instance',
            id: 'projects/shop-prod/instances/cloudgate-pg1',
            region: 'europe-west1',
            labels: LABELS,
          },
          {
            type: 'memorystore.googleapis.com/Instance',
            id: 'projects/shop-prod/locations/europe-west1/instances/cloudgate-redis',
            region: 'europe-west1',
            labels: LABELS,
          },
        ],
      });
      const urls = sent.map((one) => new URL(one.url));
      expect(urls.map((url) => url.origin + url.pathname)).toEqual([
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/aggregated/addresses',
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/aggregated/addresses',
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/aggregated/forwardingRules',
        'https://sqladmin.googleapis.com/v1/projects/shop-prod/instances',
        'https://memorystore.googleapis.com/v1/projects/shop-prod/locations/-/instances',
      ]);
      expect(urls[1].searchParams.get('pageToken')).toBe('n');
      expect(urls.map((url) => url.searchParams.get('filter'))).toEqual([
        'labels.cloudgate-environment = "envkeyenvkey"',
        'labels.cloudgate-environment = "envkeyenvkey"',
        'labels.cloudgate-environment = "envkeyenvkey"',
        'settings.userLabels.cloudgate-environment:envkeyenvkey',
        'labels.cloudgate-environment="envkeyenvkey"',
      ]);
    });

    it('answers "permission denied" as a refusal, not an exception, and asks nothing more', async () => {
      replies.push({
        status: 403,
        body: {
          error: {
            status: 'PERMISSION_DENIED',
            message: "Required 'compute.addresses.list' permission",
          },
        },
      });

      expect(await adapter.findByLabel(token, request)).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: "Required 'compute.addresses.list' permission",
      });
      expect(sent).toHaveLength(1);
    });
  });

  it("reads a Cloud Run service's rollout: its revisions by last name, its Ready condition and its traffic", async () => {
    const at = 'projects/shop-prod/locations/europe-west1';
    replies.push({
      status: 200,
      body: {
        name: `${at}/services/cloudgate-abc`,
        reconciling: false,
        latestCreatedRevision: `${at}/services/cloudgate-abc/revisions/cloudgate-abc-00002-xyz`,
        latestReadyRevision: `${at}/services/cloudgate-abc/revisions/cloudgate-abc-00001-old`,
        terminalCondition: {
          type: 'Ready',
          state: 'CONDITION_FAILED',
          reason: 'CONTAINER_FAILED',
          message:
            "Revision 'cloudgate-abc-00002-xyz' is not ready and cannot serve traffic.",
        },
        trafficStatuses: [
          { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 },
        ],
      },
    });

    const answer = await adapter.cloudRunService(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      name: 'cloudgate-abc',
    });

    expect(answer).toEqual({
      ok: true,
      value: {
        reconciling: false,
        latestCreatedRevision: 'cloudgate-abc-00002-xyz',
        latestReadyRevision: 'cloudgate-abc-00001-old',
        terminalCondition: {
          state: 'CONDITION_FAILED',
          reason: 'CONTAINER_FAILED',
          message:
            "Revision 'cloudgate-abc-00002-xyz' is not ready and cannot serve traffic.",
        },
        traffic: [{ revision: null, percent: 100 }],
      },
    });
    expect(sent[0].url).toBe(
      'https://run.googleapis.com/v2/projects/shop-prod/locations/europe-west1/services/cloudgate-abc',
    );
    expect(sent[0].init.headers).toEqual({
      authorization: 'Bearer ya29.token',
    });
  });

  it("reads the project's log store newest first, each entry's text from whichever payload it has", async () => {
    replies.push({
      status: 200,
      body: {
        entries: [
          { timestamp: '2026-10-20T10:00:03Z', textPayload: 'listening' },
          {
            timestamp: '2026-10-20T10:00:02Z',
            jsonPayload: { message: 'booting', level: 'info' },
          },
          { timestamp: '2026-10-20T10:00:01Z', jsonPayload: { code: 7 } },
        ],
      },
    });

    const answer = await adapter.listLogEntries(token, {
      projectId: 'shop-prod',
      filter: 'resource.type="cloud_run_revision"',
      limit: 50,
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          timestamp: '2026-10-20T10:00:03Z',
          text: 'listening',
        }),
        expect.objectContaining({
          timestamp: '2026-10-20T10:00:02Z',
          text: 'booting',
        }),
        expect.objectContaining({
          timestamp: '2026-10-20T10:00:01Z',
          text: '{"code":7}',
        }),
      ],
    });
    expect(sent[0].url).toBe('https://logging.googleapis.com/v2/entries:list');
    expect(JSON.parse(sent[0].init.body as string)).toEqual({
      resourceNames: ['projects/shop-prod'],
      filter: 'resource.type="cloud_run_revision"',
      orderBy: 'timestamp desc',
      pageSize: 50,
    });
  });

  it('reads oldest first when asked, each entry naming its log, revision and copy', async () => {
    replies.push({
      status: 200,
      body: {
        entries: [
          {
            insertId: 'abc123',
            logName: 'projects/shop-prod/logs/run.googleapis.com%2Fstderr',
            timestamp: '2026-10-20T10:00:01.123456789Z',
            resource: {
              type: 'cloud_run_revision',
              labels: {
                service_name: 'cloudgate-abc',
                revision_name: 'cloudgate-abc-00002-xyz',
              },
            },
            labels: { instanceId: '00f1e2d3c4' },
            textPayload: 'boom',
          },
          {
            logName:
              'projects/shop-prod/logs/cloudaudit.googleapis.com%2Fsystem_event',
            timestamp: '2026-10-20T10:00:02Z',
            protoPayload: {
              '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
              methodName: '/Services.UpdateService',
              status: {
                message:
                  'Ready condition status changed to True for Service cloudgate-abc.',
              },
            },
          },
          {
            insertId: 'act1',
            logName:
              'projects/shop-prod/logs/cloudaudit.googleapis.com%2Factivity',
            timestamp: '2026-10-20T10:00:03Z',
            protoPayload: {
              methodName: 'google.cloud.run.v2.Services.UpdateService',
              status: {},
            },
          },
          {
            insertId: 'json1',
            logName: 'projects/shop-prod/logs/run.googleapis.com%2Fstdout',
            timestamp: '2026-10-20T10:00:04Z',
            jsonPayload: { probe: { pg: true } },
          },
        ],
      },
    });

    const answer = await adapter.listLogEntries(token, {
      projectId: 'shop-prod',
      filter: 'resource.type="cloud_run_revision"',
      limit: 1000,
      oldestFirst: true,
    });

    expect(answer).toEqual({
      ok: true,
      value: [
        {
          insertId: 'abc123',
          logName: 'projects/shop-prod/logs/run.googleapis.com%2Fstderr',
          timestamp: '2026-10-20T10:00:01.123456789Z',
          revision: 'cloudgate-abc-00002-xyz',
          instance: '00f1e2d3c4',
          text: 'boom',
        },
        {
          insertId: '',
          logName:
            'projects/shop-prod/logs/cloudaudit.googleapis.com%2Fsystem_event',
          timestamp: '2026-10-20T10:00:02Z',
          revision: null,
          instance: null,
          text: 'Ready condition status changed to True for Service cloudgate-abc.',
        },
        {
          insertId: 'act1',
          logName:
            'projects/shop-prod/logs/cloudaudit.googleapis.com%2Factivity',
          timestamp: '2026-10-20T10:00:03Z',
          revision: null,
          instance: null,
          text: 'google.cloud.run.v2.Services.UpdateService',
        },
        {
          insertId: 'json1',
          logName: 'projects/shop-prod/logs/run.googleapis.com%2Fstdout',
          timestamp: '2026-10-20T10:00:04Z',
          revision: null,
          instance: null,
          text: '{"probe":{"pg":true}}',
        },
      ],
    });
    expect(JSON.parse(sent[0].init.body as string)).toMatchObject({
      orderBy: 'timestamp asc',
      pageSize: 1000,
    });
  });

  it('deletes every version of an image but the one carrying the kept tag, with its tags', async () => {
    const image =
      'projects/shop-prod/locations/europe-west1/repositories/cloudgate-abc/packages/service';
    replies.push(
      {
        status: 200,
        body: {
          versions: [
            {
              name: `${image}/versions/sha256:1`,
              relatedTags: [{ name: `${image}/tags/dep_old` }],
            },
          ],
          nextPageToken: 'more',
        },
      },
      {
        status: 200,
        body: {
          versions: [
            {
              name: `${image}/versions/sha256:2`,
              relatedTags: [{ name: `${image}/tags/dep_live` }],
            },
            { name: `${image}/versions/sha256:3` },
          ],
        },
      },
      { status: 200, body: {} },
      { status: 200, body: {} },
    );

    const answer = await adapter.deleteImageVersionsExcept(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      repository: 'cloudgate-abc',
      image: 'service',
      keepTag: 'dep_live',
    });

    expect(answer).toEqual({ ok: true, value: { deleted: 2 } });
    const base = 'https://artifactregistry.googleapis.com/v1';
    expect(sent.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
      [
        'GET',
        `${base}/${image}/versions?view=FULL&pageSize=500&pageToken=more`,
      ],
      ['DELETE', `${base}/${image}/versions/sha256:1?force=true`],
      ['DELETE', `${base}/${image}/versions/sha256:3?force=true`],
      // Listed again: both are gone.
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
    ]);
  });

  it('keeps the live index’s own manifests, read from the registry, and deletes an older index before its manifests', async () => {
    // As the live walk found: a push from Docker's containerd image
    // store is an index whose image and attestation manifests are untagged
    // versions of their own.
    const image =
      'projects/shop-prod/locations/europe-west1/repositories/cloudgate-abc/packages/service';
    const INDEX = 'application/vnd.oci.image.index.v1+json';
    const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
    replies.push(
      {
        status: 200,
        body: {
          versions: [
            {
              name: `${image}/versions/sha256:oldimage`,
              metadata: { mediaType: MANIFEST },
            },
            {
              name: `${image}/versions/sha256:old`,
              relatedTags: [{ name: `${image}/tags/dep_old` }],
              metadata: { mediaType: INDEX },
            },
            {
              name: `${image}/versions/sha256:liveimage`,
              metadata: { mediaType: MANIFEST },
            },
            {
              name: `${image}/versions/sha256:liveattestation`,
              metadata: { mediaType: MANIFEST },
            },
            {
              name: `${image}/versions/sha256:live`,
              relatedTags: [{ name: `${image}/tags/dep_live` }],
              metadata: { mediaType: INDEX },
            },
          ],
        },
      },
      {
        status: 200,
        body: {
          mediaType: INDEX,
          manifests: [
            { digest: 'sha256:liveimage' },
            { digest: 'sha256:liveattestation' },
          ],
        },
      },
      { status: 200, body: {} },
      { status: 200, body: {} },
    );

    const answer = await adapter.deleteImageVersionsExcept(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      repository: 'cloudgate-abc',
      image: 'service',
      keepTag: 'dep_live',
    });

    expect(answer).toEqual({ ok: true, value: { deleted: 2 } });
    const base = 'https://artifactregistry.googleapis.com/v1';
    expect(sent.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
      [
        'GET',
        'https://europe-west1-docker.pkg.dev/v2/shop-prod/cloudgate-abc/service/manifests/sha256:live',
      ],
      ['DELETE', `${base}/${image}/versions/sha256:old?force=true`],
      ['DELETE', `${base}/${image}/versions/sha256:oldimage?force=true`],
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
    ]);
  });

  it('counts a version as deleted only once it is no longer listed, and answers one Google kept', async () => {
    // As the live walk saw: the delete answers at once, and fails later,
    // when the repository's tags were immutable; the role cannot read the
    // operation, so the list is read again.
    adapter.imageDeletePolls = 2;
    const image =
      'projects/shop-prod/locations/europe-west1/repositories/cloudgate-abc/packages/service';
    const both = {
      status: 200,
      body: {
        versions: [
          {
            name: `${image}/versions/sha256:old`,
            relatedTags: [{ name: `${image}/tags/dep_old` }],
          },
          {
            name: `${image}/versions/sha256:live`,
            relatedTags: [{ name: `${image}/tags/dep_live` }],
          },
        ],
      },
    };
    replies.push(
      both,
      {
        status: 200,
        body: {
          name: 'projects/shop-prod/locations/europe-west1/operations/op-1',
        },
      },
      both,
      both,
    );

    const answer = await adapter.deleteImageVersionsExcept(token, {
      projectId: 'shop-prod',
      region: 'europe-west1',
      repository: 'cloudgate-abc',
      image: 'service',
      keepTag: 'dep_live',
    });

    expect(answer).toEqual({
      ok: false,
      code: 'FAILED_PRECONDITION',
      message: '1 of 1 older versions were still listed after the deletes',
    });
    const base = 'https://artifactregistry.googleapis.com/v1';
    expect(sent.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
      ['DELETE', `${base}/${image}/versions/sha256:old?force=true`],
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
      ['GET', `${base}/${image}/versions?view=FULL&pageSize=500`],
    ]);
  });

  it('deletes nothing when the image has no version with the kept tag', async () => {
    replies.push({
      status: 200,
      body: {
        versions: [{ name: 'projects/p/x/versions/sha256:1', relatedTags: [] }],
      },
    });

    const answer = await adapter.deleteImageVersionsExcept(token, {
      projectId: 'p',
      region: 'europe-west1',
      repository: 'cloudgate-abc',
      image: 'service',
      keepTag: 'dep_live',
    });

    expect(answer).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message:
        'No version of service in cloudgate-abc carries the tag dep_live, so none was deleted',
    });
    expect(sent).toHaveLength(1);
  });

  it('makes an external-account configuration that reads its own token and impersonates the service account, its address encoded', () => {
    const { credentialConfiguration } = adapter.credentialConfiguration({
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
      serviceAccount: 'deploy@shop-prod.iam.gserviceaccount.com',
      subjectToken: 'run.token.here',
    });

    expect(JSON.parse(credentialConfiguration)).toEqual({
      type: 'external_account',
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/deploy%40shop-prod.iam.gserviceaccount.com:generateAccessToken',
      credential_source: {
        file: 'google-credential.json',
        format: { type: 'json', subject_token_field_name: 'subject_token' },
      },
      subject_token: 'run.token.here',
    });
    expect(sent).toEqual([]);
  });

  describe("a Worker's Cloud Run worker pool", () => {
    const at = 'projects/shop-prod/locations/europe-west1';
    const url = `https://run.googleapis.com/v2/${at}/workerPools/cloudgate-abc`;
    const pool = {
      projectId: 'shop-prod',
      region: 'europe-west1',
      name: 'cloudgate-abc',
    };
    const live = () => ({
      name: `${at}/workerPools/cloudgate-abc`,
      etag: '"etag-3"',
      scaling: { manualInstanceCount: 2 },
      template: {
        labels: { 'cloudgate-state': 'st_1' },
        containers: [{ name: 'service', image: 'repo/service:dep_1' }],
      },
    });

    it('reads its rollout: its revisions by last name, its Ready condition, its instance count and splits', async () => {
      replies.push({
        status: 200,
        body: {
          ...live(),
          reconciling: false,
          latestCreatedRevision: `${at}/workerPools/cloudgate-abc/revisions/cloudgate-abc-00002-new`,
          latestReadyRevision: `${at}/workerPools/cloudgate-abc/revisions/cloudgate-abc-00002-new`,
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          instanceSplitStatuses: [
            { type: 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST', percent: 100 },
          ],
        },
      });

      expect(await adapter.cloudRunWorkerPool(token, pool)).toEqual({
        ok: true,
        value: {
          reconciling: false,
          latestCreatedRevision: 'cloudgate-abc-00002-new',
          latestReadyRevision: 'cloudgate-abc-00002-new',
          terminalCondition: {
            state: 'CONDITION_SUCCEEDED',
            reason: null,
            message: null,
          },
          instanceCount: 2,
          instanceSplits: [{ revision: null, percent: 100 }],
        },
      });
      expect(sent[0].url).toBe(url);
    });

    it('reads a stopped one, whose zero count Google leaves out, as 0 instances', async () => {
      replies.push({ status: 200, body: { ...live(), scaling: {} } });

      const answer = await adapter.cloudRunWorkerPool(token, pool);

      expect(answer.ok && answer.value.instanceCount).toBe(0);
    });

    it('sets its manual instance count alone, written back whole', async () => {
      replies.push({ status: 200, body: live() });
      replies.push({ status: 200, body: { name: `${at}/operations/op-1` } });

      const answer = await adapter.setWorkerPoolInstances(token, pool, 0);

      expect(answer).toEqual({ ok: true, value: true });
      expect(sent.map((one) => [one.init.method, one.url])).toEqual([
        ['GET', url],
        ['PATCH', url],
      ]);
      expect(JSON.parse(sent[1].init.body as string)).toEqual({
        ...live(),
        scaling: { manualInstanceCount: 0 },
      });
    });

    it('sets one revision label, keeping the others', async () => {
      replies.push({ status: 200, body: live() });
      replies.push({ status: 200, body: { name: `${at}/operations/op-2` } });

      await adapter.setWorkerPoolRevisionLabel(token, pool, {
        key: 'cloudgate-reload',
        value: '1761000000',
      });

      expect(JSON.parse(sent[1].init.body as string)).toEqual({
        ...live(),
        template: {
          ...live().template,
          labels: {
            'cloudgate-state': 'st_1',
            'cloudgate-reload': '1761000000',
          },
        },
      });
    });
  });

  describe("a Cron service's Cloud Run job and its executions", () => {
    const at = 'projects/shop-prod/locations/europe-west1';
    const jobUrl = `https://run.googleapis.com/v2/${at}/jobs/cloudgate-abc`;
    const job = {
      projectId: 'shop-prod',
      region: 'europe-west1',
      name: 'cloudgate-abc',
    };
    const execution = {
      projectId: 'shop-prod',
      region: 'europe-west1',
      job: 'cloudgate-abc',
      execution: 'cloudgate-abc-7xk2p',
    };
    const executionUrl = `${jobUrl}/executions/cloudgate-abc-7xk2p`;
    const ended = (counts: Record<string, number>, message?: string) => ({
      completionTime: '2026-10-27T03:00:09Z',
      ...counts,
      conditions: [
        {
          type: 'Completed',
          state: message ? 'CONDITION_FAILED' : 'CONDITION_SUCCEEDED',
          ...(message ? { message } : {}),
        },
      ],
    });

    it("runs the job with no overrides and answers the execution's short name, read off the operation's metadata", async () => {
      replies.push({
        status: 200,
        body: {
          name: `${at}/operations/op-1`,
          metadata: {
            '@type': 'type.googleapis.com/google.cloud.run.v2.Execution',
            name: `${at}/jobs/cloudgate-abc/executions/cloudgate-abc-7xk2p`,
          },
        },
      });

      expect(await adapter.runCloudRunJob(token, job)).toEqual({
        ok: true,
        value: { execution: 'cloudgate-abc-7xk2p' },
      });
      expect(sent.map((one) => [one.init.method, one.url])).toEqual([
        ['POST', `${jobUrl}:run`],
      ]);
      expect(JSON.parse(sent[0].init.body as string)).toEqual({});
    });

    it("answers Google's refusal of a run as it is", async () => {
      replies.push({
        status: 404,
        body: {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message: "Resource 'cloudgate-abc' of kind 'JOB' does not exist.",
          },
        },
      });

      expect(await adapter.runCloudRunJob(token, job)).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
      });
    });

    it('reads one with no completion time as running, without asking for its task', async () => {
      replies.push({ status: 200, body: { runningCount: 1 } });

      expect(await adapter.cloudRunExecution(token, execution)).toEqual({
        ok: true,
        value: { state: 'running', exitCode: null, message: null },
      });
      expect(sent.map((one) => one.url)).toEqual([executionUrl]);
    });

    it("reads a succeeded one's exit code 0, which JSON leaves out of its task's last attempt", async () => {
      replies.push({ status: 200, body: ended({ succeededCount: 1 }) });
      replies.push({
        status: 200,
        body: { tasks: [{ index: 0, lastAttemptResult: {} }] },
      });

      expect(await adapter.cloudRunExecution(token, execution)).toEqual({
        ok: true,
        value: { state: 'succeeded', exitCode: 0, message: null },
      });
      expect(sent.map((one) => one.url)).toEqual([
        executionUrl,
        `${executionUrl}/tasks`,
      ]);
    });

    it("reads a failed one's exit code from its one task, in Google's words", async () => {
      const words = 'Task cloudgate-abc-7xk2p-task0 failed with exit code 3.';
      replies.push({ status: 200, body: ended({ failedCount: 1 }, words) });
      replies.push({
        status: 200,
        body: {
          tasks: [
            {
              index: 0,
              lastAttemptResult: {
                exitCode: 3,
                status: { code: 2, message: 'exit code 3' },
              },
            },
          ],
        },
      });

      expect(await adapter.cloudRunExecution(token, execution)).toEqual({
        ok: true,
        value: { state: 'failed', exitCode: 3, message: words },
      });
    });

    it("reads one whose container never ran with no exit code, in its condition's words", async () => {
      replies.push({
        status: 200,
        body: ended({ failedCount: 1 }, 'Image not found'),
      });
      replies.push({
        status: 200,
        body: {
          tasks: [
            {
              index: 0,
              lastAttemptResult: {
                status: { code: 5, message: 'Image not found' },
              },
            },
          ],
        },
      });

      expect(await adapter.cloudRunExecution(token, execution)).toEqual({
        ok: true,
        value: { state: 'failed', exitCode: null, message: 'Image not found' },
      });
    });

    it('reads a cancelled one as cancelled', async () => {
      replies.push({
        status: 200,
        body: ended({ cancelledCount: 1 }, 'Cancelled'),
      });
      replies.push({ status: 200, body: { tasks: [{ index: 0 }] } });

      expect(await adapter.cloudRunExecution(token, execution)).toEqual({
        ok: true,
        value: { state: 'cancelled', exitCode: null, message: 'Cancelled' },
      });
    });

    it('cancels one by its name', async () => {
      replies.push({ status: 200, body: { name: `${at}/operations/op-2` } });

      expect(await adapter.cancelCloudRunExecution(token, execution)).toEqual({
        ok: true,
        value: true,
      });
      expect(sent.map((one) => [one.init.method, one.url])).toEqual([
        ['POST', `${executionUrl}:cancel`],
      ]);
    });

    it("reads one execution's own output oldest first from a place, by its job and its execution's name, leaving out what the place holds", async () => {
      replies.push({
        status: 200,
        body: {
          entries: [
            {
              insertId: 'a1',
              timestamp: '2026-10-27T03:00:01Z',
              textPayload: 'copied already',
            },
            {
              insertId: 'a2',
              timestamp: '2026-10-27T03:00:01Z',
              textPayload: 'same instant, new',
            },
            {
              insertId: 'b1',
              timestamp: '2026-10-27T03:00:02Z',
              textPayload: 'later',
            },
          ],
        },
      });

      const answer = await adapter.executionLogEntries(token, {
        ...execution,
        from: { timestamp: '2026-10-27T03:00:01Z', insertIds: ['a1'] },
        limit: 1000,
      });

      expect(answer.ok && answer.value.map((one) => one.text)).toEqual([
        'same instant, new',
        'later',
      ]);
      expect(sent[0].url).toBe(
        'https://logging.googleapis.com/v2/entries:list',
      );
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        resourceNames: ['projects/shop-prod'],
        filter:
          'resource.type="cloud_run_job" AND resource.labels.job_name="cloudgate-abc" AND labels."run.googleapis.com/execution_name"="cloudgate-abc-7xk2p" AND (log_id("run.googleapis.com/stdout") OR log_id("run.googleapis.com/stderr")) AND timestamp>="2026-10-27T03:00:01Z"',
        orderBy: 'timestamp asc',
        pageSize: 1000,
      });
    });

    it('bounds a read with no place yet at a day and an hour back, the oldest an execution can be', async () => {
      // Oldest first with no lower bound, Cloud Logging answers empty pages
      // from the oldest entry it keeps: the live walk's run read nothing.
      const now = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse('2026-10-27T03:00:00Z'));
      replies.push({ status: 200, body: {} });

      await adapter.executionLogEntries(token, {
        ...execution,
        from: null,
        limit: 1000,
      });
      now.mockRestore();

      expect(
        (JSON.parse(sent[0].init.body as string) as { filter: string }).filter,
      ).toBe(
        'resource.type="cloud_run_job" AND resource.labels.job_name="cloudgate-abc" AND labels."run.googleapis.com/execution_name"="cloudgate-abc-7xk2p" AND (log_id("run.googleapis.com/stdout") OR log_id("run.googleapis.com/stderr")) AND timestamp>="2026-10-26T02:00:00.000Z"',
      );
    });
  });

  describe("a Cloud Run service's own settings, read and written back whole", () => {
    const at = 'projects/shop-prod/locations/europe-west1';
    const url = `https://run.googleapis.com/v2/${at}/services/cloudgate-abc`;
    const service = {
      projectId: 'shop-prod',
      region: 'europe-west1',
      name: 'cloudgate-abc',
    };
    /** The service as `services.get` answers it, trimmed. */
    const live = () => ({
      name: `${at}/services/cloudgate-abc`,
      etag: '"etag-7"',
      launchStage: 'GA',
      uri: 'https://cloudgate-abc-6qzq3k7vqa-ew.a.run.app',
      scaling: { scalingMode: 'AUTOMATIC' },
      template: {
        labels: { 'cloudgate-state': 'st_1' },
        scaling: { minInstanceCount: 0, maxInstanceCount: 10 },
        containers: [{ name: 'service', image: 'repo/service:dep_1' }],
      },
    });
    const patched = () => {
      expect(sent.map((one) => one.init.method)).toEqual(['GET', 'PATCH']);
      expect(sent[0].url).toBe(url);
      expect(sent[1].url).toBe(url);
      expect(sent[1].init.headers).toEqual({
        authorization: 'Bearer ya29.token',
        'content-type': 'application/json',
      });
      return JSON.parse(sent[1].init.body as string) as Record<string, unknown>;
    };

    it('stops it: manual scaling with no copies, at the launch stage Google asks for it, everything else as it was', async () => {
      replies.push({ status: 200, body: live() });
      replies.push({ status: 200, body: { name: `${at}/operations/op-1` } });

      const answer = await adapter.setCloudRunScaling(token, service, {
        mode: 'stopped',
      });

      expect(answer).toEqual({ ok: true, value: true });
      expect(patched()).toEqual({
        ...live(),
        launchStage: 'BETA',
        scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
      });
    });

    it('starts it: automatic scaling again, its revisions in the copy range', async () => {
      replies.push({
        status: 200,
        body: {
          ...live(),
          launchStage: 'BETA',
          scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
        },
      });

      const answer = await adapter.setCloudRunScaling(token, service, {
        mode: 'automatic',
        copies: { min: 1, max: 3 },
      });

      expect(answer).toEqual({ ok: true, value: true });
      expect(patched()).toEqual({
        ...live(),
        launchStage: 'BETA',
        scaling: { scalingMode: 'AUTOMATIC' },
        template: {
          ...live().template,
          scaling: { minInstanceCount: 1, maxInstanceCount: 3 },
        },
      });
    });

    it('sets the copy range on its revisions alone, leaving its scaling mode', async () => {
      replies.push({
        status: 200,
        body: {
          ...live(),
          scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
        },
      });

      await adapter.setCloudRunCopies(token, service, { min: 2, max: 5 });

      expect(patched()).toEqual({
        ...live(),
        scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
        template: {
          ...live().template,
          scaling: { minInstanceCount: 2, maxInstanceCount: 5 },
        },
      });
    });

    it('sets one revision label, keeping the others', async () => {
      replies.push({ status: 200, body: live() });

      await adapter.setRevisionLabel(token, service, {
        key: 'cloudgate-reload',
        value: '1767225600',
      });

      expect(patched()).toEqual({
        ...live(),
        template: {
          ...live().template,
          labels: {
            'cloudgate-state': 'st_1',
            'cloudgate-reload': '1767225600',
          },
        },
      });
    });

    it('writes nothing when the service already is as asked', async () => {
      replies.push({ status: 200, body: live() });

      const answer = await adapter.setCloudRunScaling(token, service, {
        mode: 'automatic',
        copies: { min: 0, max: 10 },
      });

      expect(answer).toEqual({ ok: true, value: true });
      expect(sent.map((one) => one.init.method)).toEqual(['GET']);
    });

    it("answers the read's refusal and writes nothing", async () => {
      replies.push({
        status: 404,
        body: {
          error: {
            status: 'NOT_FOUND',
            message: `Resource '${at}/services/cloudgate-abc' was not found`,
          },
        },
      });

      expect(
        await adapter.setCloudRunScaling(token, service, { mode: 'stopped' }),
      ).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: `Resource '${at}/services/cloudgate-abc' was not found`,
      });
      expect(sent).toHaveLength(1);
    });

    it("answers the write's refusal in Google's words", async () => {
      replies.push({ status: 200, body: live() });
      replies.push({
        status: 403,
        body: {
          error: {
            status: 'PERMISSION_DENIED',
            message: "Permission 'run.services.update' denied",
          },
        },
      });

      expect(
        await adapter.setRevisionLabel(token, service, {
          key: 'cloudgate-reload',
          value: '1',
        }),
      ).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: "Permission 'run.services.update' denied",
      });
    });
  });

  describe("a static site's cache clear by host on the network's URL map", () => {
    const request = {
      projectId: 'shop-prod',
      urlMap: 'cloudgate-abc-urls',
      host: 'docs.acme.dev',
    };

    it('invalidates every path of the one host, then waits for the operation to be done', async () => {
      replies.push(
        {
          status: 200,
          body: { name: 'operation-1', status: 'RUNNING' },
        },
        { status: 200, body: { name: 'operation-1', status: 'DONE' } },
      );

      expect(await adapter.invalidateCache(token, request)).toEqual({
        ok: true,
        value: true,
      });
      expect(sent[0].url).toBe(
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/global/urlMaps/cloudgate-abc-urls/invalidateCache',
      );
      expect(sent[0].init.method).toBe('POST');
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        host: 'docs.acme.dev',
        path: '/*',
      });
      expect(sent[1].url).toBe(
        'https://compute.googleapis.com/compute/v1/projects/shop-prod/global/operations/operation-1',
      );
      expect(sent).toHaveLength(2);
    });

    it("answers Google's refusal, and an operation's own error, in Google's words", async () => {
      replies.push({
        status: 403,
        body: {
          error: {
            status: 'PERMISSION_DENIED',
            message: "Required 'compute.urlMaps.invalidateCache' permission",
          },
        },
      });
      expect(await adapter.invalidateCache(token, request)).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: "Required 'compute.urlMaps.invalidateCache' permission",
      });

      replies.push({
        status: 200,
        body: {
          name: 'operation-2',
          status: 'DONE',
          error: {
            errors: [{ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many' }],
          },
        },
      });
      expect(await adapter.invalidateCache(token, request)).toEqual({
        ok: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many',
      });
    });
  });

  describe("an existing Valkey's Memorystore read", () => {
    const ref = {
      projectId: 'shop-prod',
      region: 'europe-west1',
      instance: 'orders-cache',
    };
    const base =
      'https://memorystore.googleapis.com/v1/projects/shop-prod/locations/europe-west1/instances/orders-cache';
    const notFound = {
      status: 404,
      body: { error: { status: 'NOT_FOUND', message: 'Resource not found.' } },
    };

    it('reads its mode, login, TLS, maintenance version, attachments, registered rules and CA', async () => {
      replies.push(
        {
          status: 200,
          body: {
            engineVersion: 'VALKEY_8_0',
            mode: 'CLUSTER_DISABLED',
            authorizationMode: 'AUTH_DISABLED',
            transitEncryptionMode: 'SERVER_AUTHENTICATION',
            maintenanceVersion: 'MEMORYSTORE_20251210_02_00',
            effectiveMaintenanceVersion: 'MEMORYSTORE_20261008_00_00',
            labels: { team: 'orders' },
            pscAttachmentDetails: [
              {
                serviceAttachment: 'sa-1',
                connectionType: 'CONNECTION_TYPE_PRIMARY',
              },
              {
                serviceAttachment: 'sa-2',
                connectionType: 'CONNECTION_TYPE_READER',
              },
            ],
            endpoints: [
              { connections: [{ pscAutoConnection: { forwardingRule: 'x' } }] },
              {
                connections: [
                  {
                    pscConnection: {
                      forwardingRule:
                        'projects/p/regions/r/forwardingRules/cloudgate-abc-psc-0',
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          status: 200,
          body: {
            managedServerCa: {
              caCerts: [{ certificates: ['CERT-A', 'CERT-B'] }],
            },
          },
        },
      );

      expect(await adapter.memorystoreInstance(token, ref)).toEqual({
        ok: true,
        value: {
          product: 'valkey',
          engineVersion: 'VALKEY_8_0',
          mode: 'CLUSTER_DISABLED',
          authorizationMode: 'AUTH_DISABLED',
          transitEncryptionMode: 'SERVER_AUTHENTICATION',
          maintenanceVersion: 'MEMORYSTORE_20261008_00_00',
          labels: { team: 'orders' },
          serviceAttachments: [
            {
              serviceAttachment: 'sa-1',
              connectionType: 'CONNECTION_TYPE_PRIMARY',
            },
            {
              serviceAttachment: 'sa-2',
              connectionType: 'CONNECTION_TYPE_READER',
            },
          ],
          registeredForwardingRules: [
            'projects/p/regions/r/forwardingRules/cloudgate-abc-psc-0',
          ],
          ca: 'CERT-A\nCERT-B',
        },
      });
      expect(sent.map((one) => one.url)).toEqual([
        base,
        `${base}/certificateAuthority`,
      ]);
    });

    it('names a Memorystore for Redis cluster under that name, so the plan can say "use Valkey"', async () => {
      replies.push(notFound, notFound, { status: 200, body: {} });

      const answer = await adapter.memorystoreInstance(token, ref);

      expect(answer.ok && answer.value.product).toBe('redis-cluster');
      expect(sent.map((one) => one.url)).toEqual([
        base,
        'https://redis.googleapis.com/v1/projects/shop-prod/locations/europe-west1/instances/orders-cache',
        'https://redis.googleapis.com/v1/projects/shop-prod/locations/europe-west1/clusters/orders-cache',
      ]);
    });

    it("answers Valkey's NOT_FOUND when no Memorystore product knows the name", async () => {
      replies.push(notFound, notFound, notFound);

      expect(await adapter.memorystoreInstance(token, ref)).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Resource not found.',
      });
    });
  });

  describe("a Cloud SQL instance's activation policy: Stop and Start", () => {
    const instance = { projectId: 'shop-prod', name: 'cloudgate-abc' };
    const url =
      'https://sqladmin.googleapis.com/v1/projects/shop-prod/instances/cloudgate-abc';

    it.each([
      ['stops', 'NEVER'],
      ['starts', 'ALWAYS'],
    ] as const)(
      'it %s by one patch of the activation policy alone, keeping every other setting',
      async (_verb, policy) => {
        replies.push({
          status: 200,
          body: { kind: 'sql#operation', name: 'op-1', status: 'PENDING' },
        });

        expect(
          await adapter.setCloudSqlActivationPolicy(token, instance, policy),
        ).toEqual({ ok: true, value: true });
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe(url);
        expect(sent[0].init.method).toBe('PATCH');
        expect(
          (sent[0].init.headers as Record<string, string>).authorization,
        ).toBe('Bearer ya29.token');
        expect(JSON.parse(sent[0].init.body as string)).toEqual({
          settings: { activationPolicy: policy },
        });
      },
    );

    it("answers Google's refusal in its words", async () => {
      replies.push({
        status: 404,
        body: {
          error: {
            status: 'NOT_FOUND',
            message: 'The Cloud SQL instance does not exist.',
          },
        },
      });

      expect(
        await adapter.setCloudSqlActivationPolicy(token, instance, 'NEVER'),
      ).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'The Cloud SQL instance does not exist.',
      });
    });
  });

  it("reads a Domain's certificate by its full name: its state and Google's reason", async () => {
    const name =
      'projects/shop-prod/locations/global/certificates/cloudgate-abc-2';
    replies.push({
      status: 200,
      body: {
        name,
        managed: {
          domains: ['acme.dev'],
          state: 'PROVISIONING',
          provisioningIssue: { reason: 'AUTHORIZATION_ISSUE' },
          authorizationAttemptInfo: [
            {
              domain: 'acme.dev',
              state: 'FAILED',
              failureReason: 'CONFIG',
              details: 'The CNAME record is missing',
            },
          ],
        },
      },
    });

    expect(
      await adapter.certificate(token, { projectId: 'shop-prod', name }),
    ).toEqual({
      ok: true,
      value: {
        state: 'PROVISIONING',
        reason: 'CONFIG: The CNAME record is missing',
      },
    });
    expect(sent[0].url).toBe(
      `https://certificatemanager.googleapis.com/v1/${name}`,
    );
    expect(sent[0].init.method).toBe('GET');
  });

  it('answers a certificate with no managed part as unspecified, and a refusal in Google’s words', async () => {
    replies.push({ status: 200, body: { name: 'x' } });
    replies.push({
      status: 404,
      body: { error: { status: 'NOT_FOUND', message: 'not found' } },
    });
    const ref = {
      projectId: 'p',
      name: 'projects/p/locations/global/certificates/x',
    };

    expect(await adapter.certificate(token, ref)).toEqual({
      ok: true,
      value: { state: 'STATE_UNSPECIFIED', reason: null },
    });
    expect(await adapter.certificate(token, ref)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'not found',
    });
  });
  describe("a Google database's Delete: protection, retained backups and its final backup", () => {
    const sql = 'https://sqladmin.googleapis.com/v1/projects/shop-prod';
    const instance = { projectId: 'shop-prod', name: 'cloudgate-abc' };

    it("patches only Google's deletion protection off, and waits for its operation", async () => {
      replies.push(
        { status: 200, body: { name: 'op-1', status: 'PENDING' } },
        { status: 200, body: { name: 'op-1', status: 'RUNNING' } },
        { status: 200, body: { name: 'op-1', status: 'DONE' } },
      );

      expect(
        await adapter.liftCloudSqlDeletionProtection(token, instance),
      ).toEqual({ ok: true, value: true });
      expect(sent.map((one) => [one.init.method, one.url])).toEqual([
        ['PATCH', `${sql}/instances/cloudgate-abc`],
        ['GET', `${sql}/operations/op-1`],
        ['GET', `${sql}/operations/op-1`],
      ]);
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        settings: { deletionProtectionEnabled: false },
      });
    });

    it('patches only retained-backups-on-delete off', async () => {
      replies.push({ status: 200, body: { name: 'op-2', status: 'DONE' } });

      expect(
        await adapter.stopRetainingCloudSqlBackups(token, instance),
      ).toEqual({ ok: true, value: true });
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        settings: { retainBackupsOnDelete: false },
      });
    });

    it("answers an operation's own error as Google's refusal", async () => {
      replies.push(
        { status: 200, body: { name: 'op-3', status: 'PENDING' } },
        {
          status: 200,
          body: {
            name: 'op-3',
            status: 'DONE',
            error: {
              errors: [
                {
                  code: 'OPERATION_IN_PROGRESS',
                  message: 'Another operation is in progress',
                },
              ],
            },
          },
        },
      );

      expect(
        await adapter.liftCloudSqlDeletionProtection(token, instance),
      ).toEqual({
        ok: false,
        code: 'OPERATION_IN_PROGRESS',
        message: 'Another operation is in progress',
      });
    });

    it('takes an on-demand Cloud SQL backup with its description, and answers where it is kept and its size', async () => {
      replies.push(
        {
          status: 200,
          body: {
            name: 'op-4',
            status: 'DONE',
            backupContext: { backupId: '1761471234567' },
          },
        },
        {
          status: 200,
          body: { location: 'us', maxChargeableBytes: '1433856' },
        },
      );

      expect(
        await adapter.takeCloudSqlBackup(
          token,
          instance,
          'shop-production-pg-1-final-2026-10-26',
        ),
      ).toEqual({ ok: true, value: { location: 'us', sizeBytes: 1433856 } });
      expect(sent[0]).toMatchObject({
        url: `${sql}/instances/cloudgate-abc/backupRuns`,
        init: { method: 'POST' },
      });
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        description: 'shop-production-pg-1-final-2026-10-26',
      });
      expect(sent[1].url).toBe(
        `${sql}/instances/cloudgate-abc/backupRuns/1761471234567`,
      );
    });

    it('takes an on-demand Valkey backup with its id and no TTL, waits, and reads its size from the backup collection', async () => {
      const at = 'projects/shop-prod/locations/europe-west1';
      const url = `https://memorystore.googleapis.com/v1/${at}/instances/cloudgate-abc`;
      replies.push(
        { status: 200, body: { name: `${at}/operations/op-5`, done: false } },
        { status: 200, body: { name: `${at}/operations/op-5`, done: true } },
        {
          status: 200,
          body: { backupCollection: `${at}/backupCollections/5f5b` },
        },
        { status: 200, body: { totalSizeBytes: '141' } },
      );

      expect(
        await adapter.takeMemorystoreBackup(
          token,
          { ...instance, region: 'europe-west1' },
          'shop-production-redis-final-2026-10-26',
        ),
      ).toEqual({
        ok: true,
        value: { location: 'europe-west1', sizeBytes: 141 },
      });
      expect(sent.map((one) => [one.init.method, one.url])).toEqual([
        ['POST', `${url}:backup`],
        ['GET', `https://memorystore.googleapis.com/v1/${at}/operations/op-5`],
        ['GET', url],
        [
          'GET',
          `https://memorystore.googleapis.com/v1/${at}/backupCollections/5f5b/backups/shop-production-redis-final-2026-10-26`,
        ],
      ]);
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        backupId: 'shop-production-redis-final-2026-10-26',
      });
    });

    it("answers a failed Valkey backup's error by its status name", async () => {
      replies.push({
        status: 200,
        body: {
          name: 'projects/p/locations/r/operations/op-6',
          done: true,
          error: { code: 6, message: 'Backup already exists' },
        },
      });

      expect(
        await adapter.takeMemorystoreBackup(
          token,
          { ...instance, region: 'r' },
          'b',
        ),
      ).toEqual({
        ok: false,
        code: 'ALREADY_EXISTS',
        message: 'Backup already exists',
      });
    });

    it("answers a refused backup call with Google's own status and words", async () => {
      replies.push({
        status: 404,
        body: {
          error: {
            status: 'NOT_FOUND',
            message: 'The instance does not exist.',
          },
        },
      });

      expect(await adapter.takeCloudSqlBackup(token, instance, 'b')).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'The instance does not exist.',
      });
    });
  });
  describe("a Google bucket's Delete: whether it holds files", () => {
    it('lists at most the names asked for, old versions included', async () => {
      replies.push({
        status: 200,
        body: { items: [{ name: 'a.jpg', size: '3' }], nextPageToken: 'more' },
      });

      expect(
        await adapter.listObjects(token, {
          bucket: 'cloudgate-abc-12345678',
          maxResults: 1,
          versions: true,
        }),
      ).toEqual({
        ok: true,
        value: [{ name: 'a.jpg', md5Hash: null, size: 3 }],
      });
      // One page only: the next is never asked for.
      expect(sent).toHaveLength(1);
      const url = new URL(sent[0].url);
      expect(url.origin + url.pathname).toBe(
        'https://storage.googleapis.com/storage/v1/b/cloudgate-abc-12345678/o',
      );
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        maxResults: '1',
        versions: 'true',
      });
      expect(sent[0].init.method).toBe('GET');
    });

    it('answers an empty bucket as no names', async () => {
      replies.push({ status: 200, body: {} });

      expect(
        await adapter.listObjects(token, { bucket: 'b', maxResults: 1 }),
      ).toEqual({ ok: true, value: [] });
    });

    it('answers a bucket Cloud Storage does not have as NOT_FOUND, though its refusal names only the HTTP code', async () => {
      replies.push({
        status: 404,
        body: {
          error: { code: 404, message: 'The specified bucket does not exist.' },
        },
      });

      expect(
        await adapter.listObjects(token, { bucket: 'b', maxResults: 1 }),
      ).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'The specified bucket does not exist.',
      });
    });
  });

  describe("a Google static site's Delete: emptying its bucket", () => {
    const GONE = {
      status: 404,
      body: { error: { code: 404, message: 'No such object: site/a.js' } },
    };

    it('answers an object already gone as NOT_FOUND, though Cloud Storage names only the HTTP code', async () => {
      replies.push(GONE);

      expect(
        await adapter.deleteObject(token, { bucket: 'site', name: 'a.js' }),
      ).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'No such object: site/a.js',
      });
    });

    it('lists every page, then deletes each object, one already gone counting as emptied', async () => {
      replies.push(
        {
          status: 200,
          body: { items: [{ name: 'live/' }], nextPageToken: 'more' },
        },
        { status: 200, body: { items: [{ name: 'a.js' }, { name: 'b.js' }] } },
        { status: 200, body: null },
        GONE,
        { status: 200, body: null },
      );

      expect(await adapter.emptyBucket(token, 'site')).toEqual({
        ok: true,
        value: { deleted: 2 },
      });
      expect(sent.slice(2).map((one) => [one.init.method, one.url])).toEqual([
        [
          'DELETE',
          'https://storage.googleapis.com/storage/v1/b/site/o/live%2F',
        ],
        ['DELETE', 'https://storage.googleapis.com/storage/v1/b/site/o/a.js'],
        ['DELETE', 'https://storage.googleapis.com/storage/v1/b/site/o/b.js'],
      ]);
    });

    it('answers a bucket Cloud Storage does not have as already empty', async () => {
      replies.push({
        status: 404,
        body: {
          error: { code: 404, message: 'The specified bucket does not exist.' },
        },
      });

      expect(await adapter.emptyBucket(token, 'site')).toEqual({
        ok: true,
        value: { deleted: 0 },
      });
    });

    it('stops at the first refusal and answers it: an emptying that stopped partway', async () => {
      replies.push(
        { status: 200, body: { items: [{ name: 'a.js' }, { name: 'b.js' }] } },
        { status: 200, body: null },
        {
          status: 403,
          body: {
            error: { code: 403, message: 'storage.objects.delete denied' },
          },
        },
      );

      expect(await adapter.emptyBucket(token, 'site')).toEqual({
        ok: false,
        code: '403',
        message: 'storage.objects.delete denied',
      });
      expect(sent).toHaveLength(3);
    });
  });

  describe("an existing bucket's lookup", () => {
    it('reads its location, requester pays, labels and project, asking only for those', async () => {
      replies.push({
        status: 200,
        body: {
          location: 'EU',
          locationType: 'dual-region',
          customPlacementConfig: {
            dataLocations: ['EUROPE-WEST1', 'EUROPE-WEST4'],
          },
          billing: { requesterPays: true },
          labels: { team: 'shop' },
          projectNumber: '999999999999',
        },
      });

      expect(await adapter.storageBucket(token, 'acme-prod-uploads')).toEqual({
        ok: true,
        value: {
          location: 'EU',
          locationType: 'dual-region',
          dataLocations: ['EUROPE-WEST1', 'EUROPE-WEST4'],
          requesterPays: true,
          labels: { team: 'shop' },
          projectNumber: '999999999999',
        },
      });
      const url = new URL(sent[0].url);
      expect(url.origin + url.pathname).toBe(
        'https://storage.googleapis.com/storage/v1/b/acme-prod-uploads',
      );
      expect(url.searchParams.get('fields')).toBe(
        'location,locationType,customPlacementConfig,billing,labels,projectNumber',
      );
      expect(sent[0].init.method).toBe('GET');
    });

    it('reads a bucket with no billing, labels or placement as none', async () => {
      replies.push({
        status: 200,
        body: {
          location: 'EUROPE-WEST1',
          locationType: 'region',
          projectNumber: '1',
        },
      });

      expect(await adapter.storageBucket(token, 'b')).toEqual({
        ok: true,
        value: {
          location: 'EUROPE-WEST1',
          locationType: 'region',
          dataLocations: [],
          requesterPays: false,
          labels: {},
          projectNumber: '1',
        },
      });
    });

    it("answers Cloud Storage's 404 as NOT_FOUND and its 403 as PERMISSION_DENIED", async () => {
      replies.push(
        {
          status: 404,
          body: {
            error: {
              code: 404,
              message: 'The specified bucket does not exist.',
            },
          },
        },
        {
          status: 403,
          body: {
            error: {
              code: 403,
              message: 'caller does not have storage.buckets.get access',
            },
          },
        },
      );

      expect(await adapter.storageBucket(token, 'b')).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: 'The specified bucket does not exist.',
      });
      expect(await adapter.storageBucket(token, 'b')).toEqual({
        ok: false,
        code: 'PERMISSION_DENIED',
        message: 'caller does not have storage.buckets.get access',
      });
    });
  });

  describe("a Stack VM's data-disk snapshots (#1367)", () => {
    const COMPUTE = 'https://compute.googleapis.com/compute/v1/projects/acme';
    const disk = {
      projectId: 'acme',
      zone: 'europe-west1-b',
      disk: 'cg-st1-data',
    };

    it('takes the final snapshot in the disk’s region, waits on its zone’s operation, and reads its size', async () => {
      replies.push(
        { status: 200, body: { name: 'op-1', status: 'RUNNING' } },
        { status: 200, body: { name: 'op-1', status: 'DONE' } },
        { status: 200, body: { diskSizeGb: '20' } },
      );

      const answer = await adapter.takeDiskSnapshot(token, {
        ...disk,
        name: 'shop-production-analytics-final-2026-11-10',
        region: 'europe-west1',
        description: 'the final snapshot',
        labels: { 'cloudgate-final-snapshot-of': 'analytics' },
      });

      expect(answer).toEqual({
        ok: true,
        value: {
          name: 'shop-production-analytics-final-2026-11-10',
          sizeGb: 20,
        },
      });
      expect(sent.map((one) => one.url)).toEqual([
        `${COMPUTE}/zones/europe-west1-b/disks/cg-st1-data/createSnapshot`,
        `${COMPUTE}/zones/europe-west1-b/operations/op-1`,
        `${COMPUTE}/global/snapshots/shop-production-analytics-final-2026-11-10`,
      ]);
      expect(JSON.parse(sent[0].init.body as string)).toEqual({
        name: 'shop-production-analytics-final-2026-11-10',
        description: 'the final snapshot',
        labels: { 'cloudgate-final-snapshot-of': 'analytics' },
        storageLocations: ['europe-west1'],
      });
    });

    it("lists only the schedule's snapshots of the disk, through every page", async () => {
      replies.push(
        {
          status: 200,
          body: {
            items: [
              { name: 'cg-st1-data-daily-1', autoCreated: true },
              { name: 'before-the-upgrade' },
            ],
            nextPageToken: 'p2',
          },
        },
        {
          status: 200,
          body: { items: [{ name: 'cg-st1-data-daily-2', autoCreated: true }] },
        },
      );

      expect(await adapter.scheduledDiskSnapshots(token, disk)).toEqual({
        ok: true,
        value: ['cg-st1-data-daily-1', 'cg-st1-data-daily-2'],
      });
      const first = new URL(sent[0].url);
      expect(first.origin + first.pathname).toBe(`${COMPUTE}/global/snapshots`);
      expect(first.searchParams.get('filter')).toBe(
        `sourceDisk = "${COMPUTE}/zones/europe-west1-b/disks/cg-st1-data"`,
      );
      expect(new URL(sent[1].url).searchParams.get('pageToken')).toBe('p2');
    });

    it('deletes a snapshot and waits on it; one already gone is gone', async () => {
      replies.push(
        { status: 200, body: { name: 'op-2', status: 'DONE' } },
        {
          status: 404,
          body: { error: { status: 'NOT_FOUND', message: 'not found' } },
        },
      );

      expect(
        await adapter.deleteDiskSnapshot(token, {
          projectId: 'acme',
          name: 'cg-st1-data-daily-1',
        }),
      ).toEqual({ ok: true, value: true });
      expect(
        await adapter.deleteDiskSnapshot(token, {
          projectId: 'acme',
          name: 'cg-st1-data-daily-1',
        }),
      ).toEqual({ ok: true, value: true });
      expect(sent[0].init.method).toBe('DELETE');
    });
  });
});
