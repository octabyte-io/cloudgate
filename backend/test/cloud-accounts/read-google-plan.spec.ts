import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type {
  FoundByName,
  GooglePlanReadContext,
} from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type {
  TofuResourceChange,
  TofuShowJson,
} from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * Stored Google plans (S20): `tofu show -json` as the pinned hashicorp/google
 * prints it. The create, image-only, drift, variable add, Domain add and
 * destroy plans are the live walk's, rewritten to the sample ids: the
 * `web` Service (here read as `api`), created with no variable and given
 * `WALK_GREETING` by its next deploy, and its Environment network, created
 * with no Domain and given `api.example.com` later. `drift-field.json`: in
 * the console, the image changed to `:hand-fix` and a `DEBUG` variable added,
 * then Stop, Reload and a copy range edit, with `resource_drift` as the real
 * refresh saw it. The variable change and removal plans are still planned
 * offline and marked (`google-plan-fixtures.spec.ts`).
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const REGISTRY =
  'europe-west1-docker.pkg.dev/example-project-123/cloudgate-plb3nv2t74e6/service';
const CLOUD_RUN = 'google_cloud_run_v2_service.service';

const WEB: GooglePlanReadContext = {
  serviceName: 'api',
  sizeName: 'small',
  variableNames: ['API_KEY', 'SESSION_SECRET'],
};
const DEPLOY: GooglePlanReadContext = {
  ...WEB,
  imageRef: `${REGISTRY}:dep_2`,
};

/** Every value a fixture carries in clear, as `tofu show -json` prints them. */
const SECRET_VALUES = [
  'hunter2-very-secret',
  'another-secret-value',
  'rotated-very-secret-2',
  'PLACEHOLDER-SECRET-KEY',
];

function read(
  show: TofuShowJson,
  context: GooglePlanReadContext = WEB,
  nameSearch: FoundByName[] = [],
) {
  return readGooglePlan({ show, nameSearch, context });
}

/** One resource change of a stored plan, by address. */
function changeAt(show: TofuShowJson, address: string): TofuResourceChange {
  const found = show.resource_changes?.find((c) => c.address === address);
  if (!found) throw new Error(`no ${address}`);
  return found;
}

/** The parts of a `google_cloud_run_v2_service`'s values these tests edit. */
interface CloudRunValues {
  client?: string | null;
  client_version?: string | null;
  terraform_labels?: Record<string, string> | null;
  effective_labels?: Record<string, string>;
  effective_annotations?: Record<string, string>;
  scaling: Record<string, unknown>[];
  template: {
    labels?: Record<string, string> | null;
    scaling: Record<string, unknown>[];
    vpc_access: { network_interfaces: { subnetwork: string }[] }[];
    containers: {
      image: string;
      env: { value_source: { secret_key_ref: { version: string }[] }[] }[];
      resources: { limits: Record<string, string>; cpu_idle: boolean }[];
    }[];
  }[];
}

/** A stored plan with its Cloud Run service's values edited, as another plan would print them. */
function withPlanned(
  show: TofuShowJson,
  address: string,
  edit: (before: CloudRunValues, after: CloudRunValues) => void,
): TofuShowJson {
  const copy = JSON.parse(JSON.stringify(show)) as TofuShowJson;
  const change = changeAt(copy, address);
  edit(
    change.change.before as CloudRunValues,
    change.change.after as CloudRunValues,
  );
  return copy;
}

describe('readGooglePlan', () => {
  describe('creates', () => {
    it('shows a new web Service on Cloud Run with its pair, CPU billing and copy range', () => {
      const reading = read(plan('web-create'));

      expect(reading.summary).toContain(
        'Cloud Run service `api`: create, `small` → 1 CPU / 1 GB, CPU only during requests, 0–10 copies',
      );
    });

    it("names the Service's repository, service account and load balancer pieces once", () => {
      // The walk's web was created with no variable; a deploy's
      // first variables are `variables-add`'s.
      const reading = read(plan('web-create'));

      expect(reading.summary).toEqual([
        'Artifact Registry repository `cloudgate-plb3nv2t74e6`: create',
        'Cloud Run service `api`: create, `small` → 1 CPU / 1 GB, CPU only during requests, 0–10 copies',
        'Backend service `cloudgate-plb3nv2t74e6`: create',
        'Serverless network endpoint group `cloudgate-plb3nv2t74e6`: create',
        'Service account `cloudgate-plb3nv2t74e6`: create',
      ]);
      expect(reading.counts).toMatchObject({ create: 5, change: 0 });
    });

    it('lists every Google resource of a web create as a raw line', () => {
      const reading = read(plan('web-create'));

      expect(
        reading.raw.map((line) => `${line.action} ${line.address}`),
      ).toEqual([
        'create google_artifact_registry_repository.service',
        `create ${CLOUD_RUN}`,
        'create google_compute_backend_service.service',
        'create google_compute_region_network_endpoint_group.service',
        'create google_service_account.service',
      ]);
    });

    it("shows a new Environment network as one line with the load balancer's idle cost", () => {
      const reading = read(plan('network-create'), {});

      expect(reading.summary).toEqual([
        'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
      ]);
      expect(reading.raw).toHaveLength(12);
      expect(reading.counts.create).toBe(12);
    });

    it("shows each new Domain's pieces on the made network", () => {
      const reading = read(plan('domain-add'), {});

      expect(reading.summary).toEqual([
        'Domain `api.example.com` certificate: create, Google-managed, live once its DNS records are made',
        'Domain `api.example.com` certificate map entry: create',
        'Domain `api.example.com` DNS authorization: create',
        'URL map `cloudgate-w33lemwkholw-urls`: change, host rules for `api.example.com`',
      ]);
      expect(reading.counts).toMatchObject({ create: 3, change: 1 });
    });

    it("shows the Environment network's stand-in names as made by this plan", () => {
      const standIn = 'cloudgate-stand-in-subnet';
      const show = withPlanned(plan('web-create'), CLOUD_RUN, (_b, after) => {
        after.template[0].vpc_access[0].network_interfaces[0].subnetwork =
          standIn;
      });

      const reading = read(show, { ...WEB, standIns: [standIn] });

      expect(reading.summary).toContain(
        'Environment network names (`subnetwork`): made by this plan (Environment network)',
      );
    });
  });

  describe('changes', () => {
    it("shows a deploy's new image on the Cloud Run service", () => {
      const reading = read(plan('image-only'), DEPLOY);

      expect(reading.summary).toEqual([
        'Cloud Run service `api`: change, new image, built by this deploy',
      ]);
      expect(reading.raw).toEqual([
        {
          address: CLOUD_RUN,
          resourceType: 'google_cloud_run_v2_service',
          action: 'change',
          fields: ['template'],
          briefDowntime: false,
          drift: false,
        },
      ]);
    });

    it('shows a new pair and CPU billing only when they change', () => {
      const show = withPlanned(plan('image-only'), CLOUD_RUN, (_b, after) => {
        after.template[0].containers[0].resources[0].limits = {
          cpu: '2',
          memory: '4Gi',
        };
        after.template[0].containers[0].resources[0].cpu_idle = false;
      });

      const reading = read(show, { ...DEPLOY, sizeName: 'large' });

      expect(reading.summary).toEqual([
        'Cloud Run service `api`: change, `large` → 2 CPU / 4 GB, CPU always on, new image, built by this deploy',
      ]);
    });

    it('shows a destroy of every piece of a web Service', () => {
      const reading = read(plan('web-destroy'));

      expect(reading.summary).toEqual([
        'Artifact Registry repository `cloudgate-plb3nv2t74e6`: destroy',
        'Cloud Run service `api`: destroy',
        'Backend service `cloudgate-plb3nv2t74e6`: destroy',
        'Serverless network endpoint group `cloudgate-plb3nv2t74e6`: destroy',
        'Variable `DATABASE_URL`: removed',
        'Variable `PG_CA`: removed',
        'Variable `REDIS_CA_B64`: removed',
        'Variable `REDIS_URL`: removed',
        'Variable `WALK_GREETING`: removed',
        'Service account `cloudgate-plb3nv2t74e6`: destroy',
      ]);
      expect(reading.counts.destroy).toBe(20);
    });
  });

  describe('variables (S1)', () => {
    it("shows a deploy's new variables as secrets added, the revision rolling to read them", () => {
      const reading = read(plan('variables-add'), DEPLOY);

      expect(reading.summary).toEqual([
        'Cloud Run service `api`: change, new image, built by this deploy, variables changed, a new revision rolls out',
        'Variable `WALK_GREETING`: added',
      ]);
      expect(reading.counts.create).toBe(3);
      expect(reading.imageOnly).toBe(false);
    });

    it('shows a changed value as a new version, with no downtime, and the revision rolling to it', () => {
      const reading = read(plan('variable-change'), DEPLOY);

      expect(reading.summary).toEqual([
        'Cloud Run service `api`: change, new image, built by this deploy, variables changed, a new revision rolls out',
        'Variable `API_KEY`: value changed',
      ]);
      expect(reading.raw).toContainEqual({
        address: 'google_secret_manager_secret_version.variable["API_KEY"]',
        resourceType: 'google_secret_manager_secret_version',
        action: 'replace',
        fields: ['secret_data'],
        briefDowntime: false,
        drift: false,
      });
      expect(reading.counts.briefDowntime).toBe(0);
    });

    it("shows a removed variable's secret removed, and the revision no longer reading it", () => {
      const reading = read(plan('variable-remove'), {
        ...DEPLOY,
        variableNames: ['API_KEY'],
      });

      expect(reading.summary).toEqual([
        'Cloud Run service `api`: change, new image, built by this deploy, variables changed, a new revision rolls out',
        'Variable `SESSION_SECRET`: removed',
      ]);
      expect(reading.counts.destroy).toBe(3);
    });
  });

  describe('noise', () => {
    it("never shows Google's label echoes or the console's client fields", () => {
      const show = withPlanned(
        plan('image-only'),
        CLOUD_RUN,
        (before, after) => {
          before.client = 'cloud-console';
          before.client_version = '';
          before.terraform_labels = null;
          after.effective_labels = {
            ...after.effective_labels,
            'goog-terraform-provisioned': 'true',
          };
          after.effective_annotations = { 'run.googleapis.com/client': 'x' };
        },
      );

      const reading = read(show, DEPLOY);

      expect(reading.raw.map((line) => line.fields)).toEqual([['template']]);
    });

    it('drops a Cloud Run update that moves nothing but noise and never-drift fields', () => {
      const show = withPlanned(
        plan('image-only'),
        CLOUD_RUN,
        (before, after) => {
          after.template[0].containers[0].image = `${REGISTRY}:dep_1`;
          before.client = 'cloud-console';
          before.terraform_labels = null;
          before.scaling = [{ ...after.scaling[0], scaling_mode: 'MANUAL' }];
          before.template[0].labels = { 'cloudgate-reload': '1767225600' };
          before.template[0].scaling = [
            { ...after.template[0].scaling[0], max_instance_count: 3 },
          ];
        },
      );

      const reading = read(show, DEPLOY);

      expect(reading.raw).toEqual([]);
      expect(reading.summary).toEqual([]);
      expect(reading.counts.change).toBe(0);
    });

    it('never prints a variable value or the default certificate key', () => {
      for (const name of [
        'web-create',
        'image-only',
        'drift-field',
        'web-destroy',
        'network-create',
        'variables-add',
        'variable-change',
        'variable-remove',
      ]) {
        const text = JSON.stringify(read(plan(name)));
        for (const value of SECRET_VALUES) expect(text).not.toContain(value);
      }
    });

    it('masks a variable value a hand change moved', () => {
      const show = plan('drift-field');
      const version =
        'google_secret_manager_secret_version.variable["WALK_GREETING"]';
      const stored = changeAt(plan('variables-add'), version);
      const drifted: TofuResourceChange = {
        ...stored,
        change: {
          ...stored.change,
          actions: ['delete', 'create'],
          before: {
            ...(stored.change.after as object),
            secret_data: 'changed-by-hand',
          },
          after: stored.change.after,
          before_sensitive: { secret_data: true },
          replace_paths: [['secret_data']],
        },
      };
      const seen: TofuResourceChange = {
        ...stored,
        change: {
          actions: ['update'],
          before: stored.change.after,
          after: {
            ...(stored.change.after as object),
            secret_data: 'changed-by-hand',
          },
        },
      };

      const reading = read({
        ...show,
        resource_changes: [...(show.resource_changes ?? []), drifted],
        resource_drift: [...(show.resource_drift ?? []), seen],
      });

      const entry = reading.drift.find((d) => d.address === version);
      expect(entry?.fields).toEqual([
        { field: 'secret_data', hand: '(sensitive)', cloudgate: '(sensitive)' },
      ]);
      expect(JSON.stringify(reading)).not.toContain('changed-by-hand');
    });
  });

  describe('drift', () => {
    it("is a console change to a Cloud Run service's image or variables, put back", () => {
      const reading = read(plan('drift-field'));

      expect(reading.drift).toEqual([
        {
          address: CLOUD_RUN,
          resourceType: 'google_cloud_run_v2_service',
          line: 'Cloud Run service `api`: changed outside Cloudgate, will be put back',
          deleted: false,
          replaceForcing: false,
          fields: [
            expect.objectContaining({ field: 'template.0.containers.0.env' }),
            {
              field: 'template.0.containers.0.image',
              hand: `${REGISTRY}:hand-fix`,
              cloudgate: `${REGISTRY}:dep_1`,
            },
          ],
        },
      ]);
      expect(reading.drift[0].fields[0].hand).toContain('"DEBUG"');
      expect(reading.drift[0].fields[0].cloudgate).not.toContain('"DEBUG"');
      expect(reading.counts).toMatchObject({ drift: 1, change: 0 });
      expect(reading.raw.map((line) => line.drift)).toEqual([true]);
    });

    it("is never Stop's scaling, Reload's label, the copy range, the client fields or a label echo", () => {
      // A definition that did not ignore them would plan them back.
      const show = plan('drift-field');
      const seen = show.resource_drift?.find((d) => d.address === CLOUD_RUN);
      const applied = seen?.change.before as CloudRunValues;
      const putBack = withPlanned(show, CLOUD_RUN, (_before, after) => {
        after.client = applied.client;
        after.client_version = applied.client_version;
        after.scaling = applied.scaling;
        after.template[0].labels = applied.template[0].labels;
        after.template[0].scaling = applied.template[0].scaling;
      });

      const reading = read(putBack);

      expect(reading.drift.map((d) => d.fields.map((f) => f.field))).toEqual([
        ['template.0.containers.0.env', 'template.0.containers.0.image'],
      ]);
      expect(reading.drift.map((d) => d.address)).not.toContain(
        'google_artifact_registry_repository.service',
      );
    });

    it('reads a resource deleted by hand as made again', () => {
      const show = plan('web-create');
      const repository = changeAt(
        show,
        'google_artifact_registry_repository.service',
      );

      const reading = read({
        ...show,
        resource_drift: [
          {
            ...repository,
            change: { actions: ['delete'], before: {}, after: null },
          },
        ],
      });

      expect(reading.drift).toEqual([
        expect.objectContaining({
          line: 'Artifact Registry repository `cloudgate-plb3nv2t74e6`: will be made again',
          deleted: true,
        }),
      ]);
    });
  });

  describe('image-only', () => {
    it('is true for a Cloud Run update changing only its image', () => {
      expect(read(plan('image-only'), DEPLOY).imageOnly).toBe(true);
    });

    it('is false when the update changes anything else, or anything else changes', () => {
      const env = withPlanned(plan('image-only'), CLOUD_RUN, (_b, after) => {
        after.template[0].containers[0].env[0].value_source[0].secret_key_ref[0].version =
          '2';
      });
      const secret = plan('image-only');
      const version = changeAt(
        plan('variables-add'),
        'google_secret_manager_secret_version.variable["WALK_GREETING"]',
      );
      const withSecret = {
        ...secret,
        resource_changes: [
          ...(secret.resource_changes ?? []),
          {
            ...version,
            change: {
              ...version.change,
              actions: ['delete', 'create'] as const,
            },
          },
        ],
      } as TofuShowJson;

      expect(read(env, DEPLOY).imageOnly).toBe(false);
      expect(read(withSecret, DEPLOY).imageOnly).toBe(false);
      expect(read(plan('web-create'), DEPLOY).imageOnly).toBe(false);
      expect(read(plan('drift-field'), DEPLOY).imageOnly).toBe(false);
      expect(read(plan('web-destroy'), DEPLOY).imageOnly).toBe(false);
    });

    it("is still true beside Stop's scaling, Reload's label and the client fields", () => {
      const show = withPlanned(plan('image-only'), CLOUD_RUN, (before) => {
        before.client = 'cloud-console';
        before.scaling = [{ ...before.scaling[0], scaling_mode: 'MANUAL' }];
        before.template[0].labels = { 'cloudgate-reload': '1767225600' };
      });

      expect(read(show, DEPLOY).imageOnly).toBe(true);
    });

    it('reads a plan after Stop, a copy range edit and Reload as the new image alone, with no drift', () => {
      // `stopped-reloaded.json`: the refresh saw manual scaling at no
      // copies, the range 1–3 and Reload's label move; the definition
      // ignores them, so the plan keeps them (S9). Google keeps the launch
      // stage GA although Stop's call sends BETA (the second walk).
      const reading = read(plan('stopped-reloaded'), DEPLOY);

      expect(reading).toMatchObject({
        summary: [
          'Cloud Run service `api`: change, new image, built by this deploy',
        ],
        drift: [],
        imageOnly: true,
      });
      expect(reading.raw).toEqual(read(plan('image-only'), DEPLOY).raw);
    });
  });

  describe('found by name', () => {
    const description = (
      changeAt(plan('web-create'), CLOUD_RUN).change.after as {
        description: string;
      }
    ).description;
    const runFind = (mark: string | undefined): FoundByName => ({
      resourceType: 'google_cloud_run_v2_service',
      name: 'cloudgate-plb3nv2t74e6',
      id: 'projects/example-project-123/locations/europe-west1/services/cloudgate-plb3nv2t74e6',
      description: mark,
    });

    it('adopts a thing with the fixed name of a create and the same description', () => {
      const reading = read(plan('web-create'), WEB, [runFind(description)]);

      expect(reading.adopt).toEqual([
        {
          address: CLOUD_RUN,
          resourceType: 'google_cloud_run_v2_service',
          arn: runFind(description).id,
          line: "Cloud Run service `api`: found in Google Cloud, taken back into Cloudgate's record",
        },
      ]);
      expect(
        reading.raw.find((line) => line.address === CLOUD_RUN)?.action,
      ).toBe('adopt');
      expect(reading.counts).toMatchObject({ adopt: 1, create: 4 });
      expect(reading.noState).toEqual([]);
    });

    it("never adopts a thing with the name and another description: it is found, not Cloudgate's", () => {
      const other = description.replace('env_1', 'env_2');

      const reading = read(plan('web-create'), WEB, [runFind(other)]);

      expect(reading.adopt).toEqual([]);
      expect(reading.noState).toEqual([
        {
          arn: runFind(other).id,
          address: CLOUD_RUN,
          line: "Cloud Run service `api`: found in Google Cloud, not Cloudgate's: `cloudgate-plb3nv2t74e6` carries another mark, so it is not adopted; remove it by hand",
        },
      ]);
      expect(reading.counts.create).toBe(5);
    });

    it('adopts a secret, which has no description, by its Cloudgate labels', () => {
      const labels = (
        changeAt(
          plan('variables-add'),
          'google_secret_manager_secret.variable["WALK_GREETING"]',
        ).change.after as { labels: Record<string, string> }
      ).labels;
      const secret = (marks: Record<string, string>): FoundByName => ({
        resourceType: 'google_secret_manager_secret',
        name: 'cloudgate-plb3nv2t74e6-WALK_GREETING',
        id: 'projects/example-project-123/secrets/cloudgate-plb3nv2t74e6-WALK_GREETING',
        labels: marks,
      });

      expect(read(plan('variables-add'), WEB, [secret(labels)]).adopt).toEqual([
        expect.objectContaining({
          address: 'google_secret_manager_secret.variable["WALK_GREETING"]',
          line: "Variable `WALK_GREETING`: found in Google Cloud, taken back into Cloudgate's record",
        }),
      ]);
      expect(
        read(plan('variables-add'), WEB, [
          secret({ ...labels, 'cloudgate-state': 'aaaaaaaaaaaa' }),
        ]).adopt,
      ).toEqual([]);
    });

    it('passes over a thing the state holds, and notes one no plan names as in no state', () => {
      const held: FoundByName = {
        ...runFind(description),
        id: 'projects/example-project-123/locations/europe-west1/services/cloudgate-plb3nv2t74e6',
      };
      const stray: FoundByName = {
        resourceType: 'google_compute_backend_service',
        name: 'cloudgate-aaaaaaaaaaaa',
        id: 'projects/example-project-123/global/backendServices/cloudgate-aaaaaaaaaaaa',
        description: 'Made by Cloudgate',
      };

      const reading = read(plan('image-only'), DEPLOY, [held, stray]);

      expect(reading.adopt).toEqual([]);
      expect(reading.noState).toEqual([
        {
          arn: stray.id,
          address: null,
          line: `found in Google Cloud, in no state: ${stray.id}`,
        },
      ]);
    });
  });
});
