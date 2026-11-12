import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

/**
 * `native.gcp` through the planner. It is checked on every plan,
 * whatever the Deploy target, by the checker `native.aws` uses, so a typo
 * shows on a Docker or AWS plan rather than on the first deploy to Google
 * Cloud (ADR-0044 rules 2, 4, 5, 7–9), and nothing is laid yet: a valid
 * block plans exactly what the entry plans without it.
 */

const DOCKER: DeployTarget = { kind: 'platform-host' };
const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'europe-west1',
};

/** The provider version Cloudgate runs, as `deploy/opentofu/` pins it. */
const GOOGLE = 'hashicorp/google 8.8.0';

type Entry = Record<string, unknown>;

/** A config text of these entries (JSON is YAML). */
function config(services: Record<string, Entry>): string {
  return JSON.stringify({ version: 1, services });
}

function plan(
  services: Record<string, Entry>,
  where: Partial<PlanInput>,
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(config(services));
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget: DOCKER,
    context: { previous: null },
    ...where,
    ...more,
  });
}

function refusals(...args: Parameters<typeof plan>): string[] {
  const outcome = plan(...args);
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals.map((refusal) => refusal.message);
}

const web = (gcp: Entry, more: Entry = {}): Entry => ({
  kind: 'web',
  ...more,
  native: { gcp },
});
const postgres = (gcp: Entry): Entry => ({ kind: 'postgres', native: { gcp } });
const redis = (gcp: Entry): Entry => ({ kind: 'redis', native: { gcp } });
const internal = (gcp: Entry): Entry => ({
  kind: 'web-private',
  port: 8080,
  native: { gcp },
});

const RUN = '"google_cloud_run_v2_service.service"';
const SQL = '"google_sql_database_instance.database"';
const CACHE = '"google_memorystore_instance.cache"';

const EVERY_TARGET = [
  ['a Docker Environment', { deployTarget: DOCKER }],
  ['an AWS Environment', { deployTarget: CLOUD, cloud: 'aws' }],
  ['a Google Cloud Environment', { deployTarget: CLOUD, cloud: 'gcp' }],
] as const satisfies readonly (readonly [string, Partial<PlanInput>])[];

describe('planEnvironment native.gcp', () => {
  describe.each(EVERY_TARGET)('on %s', (_where, target) => {
    it('refuses a misspelt argument, naming its path and the provider Cloudgate runs', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                template: { max_instance_request_concurency: 40 },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.template.max_instance_request_concurency: refused - this block of google_cloud_run_v2_service has no argument max_instance_request_concurency in ${GOOGLE}, the version Cloudgate runs`,
      ]);
    });

    it('checks Memorystore against the google schema its definition names', () => {
      expect(
        refusals(
          {
            cache: redis({
              'google_memorystore_instance.cache': { replica_cuont: 1 },
            }),
          },
          target,
        ),
      ).toEqual([
        `cache.native.gcp.${CACHE}.replica_cuont: refused - google_memorystore_instance has no argument replica_cuont in ${GOOGLE}, the version Cloudgate runs`,
      ]);
    });

    it('checks Cloud SQL against the google schema, which lacks a beta-only block', () => {
      expect(
        refusals(
          {
            pg: postgres({
              'google_sql_database_instance.database': {
                settings: { performance_capture_config: { enabled: true } },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `pg.native.gcp.${SQL}.settings.performance_capture_config: refused - this block of google_sql_database_instance has no argument performance_capture_config in ${GOOGLE}, the version Cloudgate runs`,
      ]);
    });

    it('refuses a value of the wrong type', () => {
      expect(
        refusals(
          {
            api: web({
              'google_compute_backend_service.service': { timeout_sec: 'long' },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.gcp."google_compute_backend_service.service".timeout_sec: refused - must be a number',
      ]);
    });

    it('refuses an address the kind does not make, naming what it makes', () => {
      expect(
        refusals(
          {
            api: web({
              'google_sql_database_instance.database': {
                settings: { tier: 'db-custom-4-16384' },
              },
            }),
            cache: redis({ 'google_cloud_run_v2_service.service': {} }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${SQL}: refused - a web on Google Cloud makes google_artifact_registry_repository.service, google_service_account.service, google_cloud_run_v2_service.service, google_compute_region_network_endpoint_group.service, google_compute_backend_service.service, not google_sql_database_instance.database`,
        `cache.native.gcp.${RUN}: refused - a redis on Google Cloud makes google_memorystore_instance.cache, not google_cloud_run_v2_service.service`,
      ]);
    });

    // A mysql is made on Cloud SQL by a postgres's definition, the
    // last kind Google Cloud makes, so its block names a postgres's
    // addresses and none other.
    it("checks a mysql's block against Cloud SQL's addresses, as a postgres's", () => {
      const shop = (gcp: Record<string, Record<string, unknown>>) => ({
        shop: { kind: 'mysql', native: { gcp } },
      });
      expect(
        plan(
          shop({
            'google_sql_database_instance.database': {
              settings: { tier: 'db-custom-2-7680' },
            },
          }),
          target,
        ).ok,
      ).toBe(true);
      expect(
        refusals(shop({ 'google_cloud_run_v2_service.service': {} }), target),
      ).toEqual([
        `shop.native.gcp.${RUN}: refused - a mysql on Google Cloud makes google_sql_database_instance.database, google_sql_database.database, google_sql_user.user, not google_cloud_run_v2_service.service`,
      ]);
    });

    // A cron is made on Google Cloud as a Cloud Run job, which lays
    // no native.gcp yet.
    it('refuses every address of a kind whose Google definition lays no native.gcp yet', () => {
      expect(
        refusals(
          {
            nightly: {
              kind: 'cron',
              schedule: '0 3 * * *',
              command: 'node report.js',
              native: {
                gcp: { 'google_cloud_run_v2_job.service': { task_count: 2 } },
              },
            },
          },
          target,
        ),
      ).toContain(
        'nightly.native.gcp."google_cloud_run_v2_job.service": refused - not laid yet: a cron’s Cloud Run job does not lay native.gcp yet, so nothing set here would reach it',
      );
    });

    // The census classes what the spec had no entry for, or did not
    // spell out, by ADR-0044's five categories.
    it('locks what the census classed by the five categories: a Cloud Run service’s tags and Cloud SQL’s data API', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                tags: { 'tagKeys/123': 'tagValues/456' },
              },
            }),
            pg: postgres({
              'google_sql_database_instance.database': {
                settings: { data_api_access: 'ALLOW_DATA_API' },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.tags: refused - locked: Resource Manager tags are read by IAM conditions and organization policies, so a tag can widen who reaches what Cloudgate made`,
        `pg.native.gcp.${SQL}.settings.data_api_access: refused - locked: the data API reaches the database from outside the Environment network, through Google's API`,
      ]);
    });

    // A kind Google Cloud makes whose definition lays nothing of native.gcp
    // yet: refused by name, an open setting too, never accepted and dropped.
    it('refuses a worker’s, a bucket’s and a static site’s native.gcp as not laid yet, naming each address', () => {
      expect(
        refusals(
          {
            jobs: {
              kind: 'worker',
              native: {
                gcp: {
                  'google_cloud_run_v2_worker_pool.service': {
                    template: { containers: { working_dir: '/srv' } },
                  },
                },
              },
            },
            files: {
              kind: 'bucket',
              native: {
                gcp: {
                  'google_storage_bucket.bucket': { storage_class: 'NEARLINE' },
                },
              },
            },
            site: {
              kind: 'static',
              native: {
                gcp: {
                  'google_storage_bucket.site': { storage_class: 'NEARLINE' },
                  'google_compute_backend_bucket.site': { enable_cdn: true },
                },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'jobs.native.gcp."google_cloud_run_v2_worker_pool.service": refused - not laid yet: a worker’s Cloud Run worker pool does not lay native.gcp yet, so nothing set here would reach it',
        'files.native.gcp."google_storage_bucket.bucket": refused - not laid yet: a bucket’s Cloud Storage definition does not lay native.gcp yet, so nothing set here would reach it',
        'site.native.gcp."google_storage_bucket.site": refused - not laid yet: a static site’s Cloud Storage and Cloud CDN definition does not lay native.gcp yet, so nothing set here would reach it',
        'site.native.gcp."google_compute_backend_bucket.site": refused - not laid yet: a static site’s Cloud Storage and Cloud CDN definition does not lay native.gcp yet, so nothing set here would reach it',
      ]);
    });

    it('refuses an Environment network address whole, naming why', () => {
      expect(
        refusals(
          { api: web({ 'google_compute_url_map.network': {} }) },
          target,
        ),
      ).toEqual([
        'api.native.gcp."google_compute_url_map.network": refused - the Environment network has no native block: no config entry describes it, and every Service in the Environment shares it',
      ]);
    });

    it.each([
      [
        'google_secret_manager_secret.variable',
        "made once per variable; a variable's value is set through the Service's variables",
      ],
      [
        'google_secret_manager_secret_version.variable',
        "made once per variable; a variable's value is set through the Service's variables",
      ],
      [
        'google_secret_manager_secret_iam_member.variable',
        "made once per variable; who reads a variable is the Service's own account, Cloudgate's",
      ],
      [
        'google_certificate_manager_certificate.domain',
        "made once per Domain; a Domain's certificate is set through the Service's Domains",
      ],
    ])('refuses the per-variable or per-Domain %s whole', (address, reason) => {
      expect(
        refusals({ api: web({ [address]: { labels: { a: 'b' } } }) }, target),
      ).toEqual([`api.native.gcp."${address}": refused - ${reason}`]);
    });

    it.each([
      'lifecycle',
      'depends_on',
      'count',
      'for_each',
      'provider',
      'provisioner',
      'connection',
    ])('refuses the meta-argument %s', (meta) => {
      const [refusal] = refusals(
        { api: web({ 'google_cloud_run_v2_service.service': { [meta]: {} } }) },
        target,
      );
      expect(refusal).toMatch(
        new RegExp(
          `^api\\.native\\.gcp\\.${RUN.replace(/\./g, '\\.')}\\.${meta}: refused - ${meta} (is an instruction to OpenTofu|would make)`,
        ),
      );
    });

    it('refuses the location, the project, the labels and the mark on every address', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                location: 'us-central1',
                labels: { team: 'payments' },
                description: 'mine',
              },
              'google_artifact_registry_repository.service': {
                project: 'other-project',
              },
            }),
            pg: postgres({
              'google_sql_database_instance.database': {
                region: 'us-central1',
                settings: { user_labels: { team: 'payments' } },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.location: refused - locked: the region is the Environment's, the same for every resource it makes`,
        `api.native.gcp.${RUN}.labels: refused - locked: labels are how Cloudgate finds, marks and deletes what it made`,
        `api.native.gcp.${RUN}.description: refused - locked: the description carries Cloudgate's mark, which it finds what it made by`,
        `api.native.gcp."google_artifact_registry_repository.service".project: refused - locked: the project is the Cloud account's, where Cloudgate finds what it made`,
        `pg.native.gcp.${SQL}.region: refused - locked: the region is the Environment's, the same for every resource it makes`,
        `pg.native.gcp.${SQL}.settings.user_labels: refused - locked: labels are how Cloudgate finds, marks and deletes what it made`,
      ]);
    });

    it('refuses deletion protection on every address that has it', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                deletion_protection: true,
              },
            }),
            pg: postgres({
              'google_sql_database_instance.database': {
                deletion_protection: false,
                settings: { deletion_protection_enabled: false },
              },
            }),
            cache: redis({
              'google_memorystore_instance.cache': {
                deletion_protection_enabled: true,
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.deletion_protection: refused - locked: Delete is Cloudgate's, and asks before it deletes`,
        `pg.native.gcp.${SQL}.deletion_protection: refused - locked: Delete lifts deletion protection itself, as its first step`,
        `pg.native.gcp.${SQL}.settings.deletion_protection_enabled: refused - locked: Delete lifts deletion protection itself, as its first step`,
        `cache.native.gcp.${CACHE}.deletion_protection_enabled: refused - locked: Delete is Cloudgate's, and reclaims the cache (ADR-0018)`,
      ]);
    });

    it('refuses what Cloudgate keeps in its own ignore_changes or sets outside the plan', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                launch_stage: 'GA',
                scaling: { min_instance_count: 1 },
                template: { scaling: { max_instance_count: 3 } },
              },
              'google_artifact_registry_repository.service': {
                docker_config: { immutable_tags: true },
              },
            }),
            pg: postgres({
              'google_sql_database_instance.database': {
                settings: { activation_policy: 'NEVER' },
              },
            }),
            cache: redis({
              'google_memorystore_instance.cache': {
                authorization_mode: 'IAM_AUTH',
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.launch_stage: refused - locked: Cloudgate sets this itself: Stop moves it to BETA by a direct call`,
        `api.native.gcp.${RUN}.scaling: refused - locked: Cloudgate sets this itself: the copy count is Stop’s and Start’s, set outside the plan`,
        `api.native.gcp.${RUN}.template.scaling: refused - locked: Cloudgate sets this itself: the copy count is Stop’s and Start’s, set outside the plan`,
        'api.native.gcp."google_artifact_registry_repository.service".docker_config: refused - locked: Cloudgate sets this itself: tags stay mutable so a deploy’s clean-up can remove old images',
        `pg.native.gcp.${SQL}.settings.activation_policy: refused - locked: Cloudgate sets this itself: Stop and Start set it by a direct call`,
        `cache.native.gcp.${CACHE}.authorization_mode: refused - locked: Cloudgate sets this itself: every linked Service is wired with no password (ADR-0042)`,
      ]);
    });

    it('refuses invoker_iam_disabled and default_uri_disabled', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                invoker_iam_disabled: false,
                default_uri_disabled: true,
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.invoker_iam_disabled: refused - locked: who may call the Service is Cloudgate's; its load balancer and Environment reach it`,
        `api.native.gcp.${RUN}.default_uri_disabled: refused - locked: the run.app address is closed by ingress, which keeps the Environment's own calls working`,
      ]);
    });

    it('refuses enable_cdn and cdn_policy until slice 7', () => {
      expect(
        refusals(
          {
            api: web({
              'google_compute_backend_service.service': {
                enable_cdn: true,
                cdn_policy: { cache_mode: 'CACHE_ALL_STATIC' },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.gcp."google_compute_backend_service.service".enable_cdn: refused - locked: Cloud CDN waits for slice 7, which decides how a Service is cached',
        'api.native.gcp."google_compute_backend_service.service".cdn_policy: refused - locked: Cloud CDN waits for slice 7, which decides how a Service is cached',
      ]);
    });

    it('takes a web’s ingress closing its run.app address, and refuses any other', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
              },
            }),
            site: web({
              'google_cloud_run_v2_service.service': {
                ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
              },
            }),
            front: web({
              'google_cloud_run_v2_service.service': {
                ingress: 'INGRESS_TRAFFIC_ALL',
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.ingress: refused - locked: a web's ingress is Cloudgate's INGRESS_TRAFFIC_ALL, or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER to close its run.app address while its Domains still answer; reach may be narrowed, never widened`,
      ]);
    });

    // A Private web service's settings are slice 8's, as a
    // Worker's and a Cron service's are: its block is refused whole, its
    // ingress among it, rather than laid.
    it('refuses a Private web service’s native.gcp as not laid yet, naming the address, an open setting and its ingress alike', () => {
      expect(
        refusals(
          {
            internal: internal({
              'google_cloud_run_v2_service.service': {
                ingress: 'INGRESS_TRAFFIC_ALL',
              },
            }),
            quiet: internal({
              'google_cloud_run_v2_service.service': {
                template: { timeout: '120s' },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `internal.native.gcp.${RUN}: refused - not laid yet: a Private web service’s Cloud Run service does not lay native.gcp yet, so nothing set here would reach it`,
        `quiet.native.gcp.${RUN}: refused - not laid yet: a Private web service’s Cloud Run service does not lay native.gcp yet, so nothing set here would reach it`,
      ]);
    });

    it('refuses a Private web service a backend service it does not have', () => {
      expect(
        refusals(
          {
            internal: internal({
              'google_compute_backend_service.service': { timeout_sec: 30 },
            }),
          },
          target,
        ),
      ).toEqual([
        'internal.native.gcp."google_compute_backend_service.service": refused - a web-private on Google Cloud makes google_artifact_registry_repository.service, google_service_account.service, google_cloud_run_v2_service.service, not google_compute_backend_service.service',
      ]);
    });

    it('refuses an argument locked inside a block, by its full path, all of Cloud SQL’s ip_configuration among them', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                template: {
                  service_account: 'x@y.iam.gserviceaccount.com',
                  vpc_access: { egress: 'ALL_TRAFFIC' },
                  timeout: '30s',
                },
              },
            }),
            pg: postgres({
              'google_sql_database_instance.database': {
                settings: {
                  tier: 'db-custom-4-16384',
                  ip_configuration: { ipv4_enabled: true },
                },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.template.service_account: refused - locked: who the Service runs as is Cloudgate’s`,
        `api.native.gcp.${RUN}.template.vpc_access: refused - locked: the Environment network's, shared with every other Service in it`,
        `pg.native.gcp.${SQL}.settings.ip_configuration: refused - locked: the host and ca Outputs, and who may reach the database, depend on it; only the Environment network reaches it`,
      ]);
    });

    it('refuses an address locked whole', () => {
      expect(
        refusals(
          {
            api: web({
              'google_service_account.service': { display_name: 'x' },
              'google_compute_region_network_endpoint_group.service': {},
            }),
            pg: postgres({
              'google_sql_database.database': { charset: 'UTF8' },
              'google_sql_user.user': { password: 'hunter2' },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.gcp."google_service_account.service": refused - locked whole: who the Service runs as is Cloudgate’s',
        "api.native.gcp.\"google_compute_region_network_endpoint_group.service\": refused - locked whole: the Service's routing from the Environment's load balancer is Cloudgate's",
        'pg.native.gcp."google_sql_database.database": refused - locked whole: the config\'s database sets it, and every linked Service is wired with it',
        'pg.native.gcp."google_sql_user.user": refused - locked whole: the login is Cloudgate’s, which every linked Service is wired with',
      ]);
    });

    it('refuses a locked key and an unknown one in the container object, which is merged rather than asked for its image', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                template: {
                  containers: {
                    image: 'nginx',
                    env: [{ name: 'A', value: 'b' }],
                    working_dir: '/app',
                    workdir: '/app',
                    resources: { cpu_idle: false },
                  },
                },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.template.containers.image: refused - locked: the image is the Deployment's, which Cloudgate built`,
        `api.native.gcp.${RUN}.template.containers.env: refused - locked: the config's env sets it`,
        `api.native.gcp.${RUN}.template.containers.workdir: refused - this block of google_cloud_run_v2_service has no argument workdir in ${GOOGLE}, the version Cloudgate runs`,
      ]);
    });

    it('refuses the container written as anything but one object', () => {
      expect(
        refusals(
          {
            api: web({
              'google_cloud_run_v2_service.service': {
                template: { containers: [{ working_dir: '/app' }] },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.gcp.${RUN}.template.containers: refused - write the container as one object in the provider's spelling; it is merged into Cloudgate's one container`,
      ]);
    });

    it('names every refusal of all three native blocks in one plan', () => {
      expect(
        refusals(
          {
            api: {
              kind: 'web',
              native: {
                docker: { Privileged: true },
                aws: { 'aws_ecs_service.service': { desired_count: 3 } },
                gcp: { 'google_cloud_run_v2_service.service': { name: 'x' } },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'api.native.docker.Privileged: refused - a privileged container reaches past its Service to the Server and every tenant on it',
        'api.native.aws."aws_ecs_service.service".desired_count: refused - locked: the running count is Stop’s and Start’s, set outside the plan',
        `api.native.gcp.${RUN}.name: refused - locked: Cloudgate's name for it, which it finds and deletes it by`,
      ]);
    });
  });

  // On Google Cloud a web's block is laid and planned
  // (`plan-environment-cloud-run-native.spec.ts`); elsewhere it is checked only.
  describe('a valid block plans nothing off Google Cloud', () => {
    const valid = {
      'google_cloud_run_v2_service.service': {
        ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
        template: {
          max_instance_request_concurrency: 40,
          timeout: '30s',
          containers: {
            resources: { cpu_idle: false },
            startup_probe: { http_get: { path: '/up' } },
          },
        },
      },
      'google_compute_backend_service.service': {
        timeout_sec: 60,
        log_config: { enable: true },
      },
      'google_artifact_registry_repository.service': {
        cleanup_policy_dry_run: true,
      },
    };

    it.each(EVERY_TARGET.slice(0, 2))('on %s', (_where, target) => {
      const networks = [{ cloudAccountId: 'ca-1', region: 'europe-west1' }];
      const source = { source: { image: 'nginx' } };
      expect(plan({ api: web(valid, source) }, target, { networks })).toEqual(
        plan({ api: { kind: 'web', ...source } }, target, { networks }),
      );
    });

    it('opens Cloud SQL’s and Memorystore’s own settings', () => {
      const outcome = plan(
        {
          pg: postgres({
            'google_sql_database_instance.database': {
              settings: {
                tier: 'db-custom-4-16384',
                edition: 'ENTERPRISE_PLUS',
                database_flags: [{ name: 'max_connections', value: '200' }],
                backup_configuration: { point_in_time_recovery_enabled: true },
                maintenance_window: { day: 7, hour: 3 },
                insights_config: { query_insights_enabled: true },
              },
            },
          }),
          cache: redis({
            'google_memorystore_instance.cache': {
              node_type: 'HIGHMEM_MEDIUM',
              replica_count: 1,
              engine_configs: { 'maxmemory-policy': 'allkeys-lru' },
            },
          }),
        },
        { deployTarget: DOCKER },
      );
      expect(outcome.ok).toBe(true);
    });
  });

  describe('what the Service makes right now', () => {
    /** `pg` as an Existing database on Google Cloud. */
    const existing: SavedService = {
      serviceType: 'postgres',
      serviceId: 'pg-id',
      name: 'pg',
      configName: 'pg',
      existing: {
        cloudAccountId: 'ca-1',
        region: 'europe-west1',
        identifier: 'shop-prod:europe-west1:acme-prod',
        madeReachable: false,
      },
      settings: {
        description: null,
        cpuLimit: null,
        memoryLimit: null,
        dockerImage: 'postgres:17',
        databaseName: 'shop',
        databaseUser: 'shop_app',
      },
      variables: { env: [] },
    };

    it('refuses every address of an Existing database on Google Cloud, which Cloudgate makes nothing of', () => {
      expect(
        refusals(
          {
            pg: postgres({
              'google_sql_database_instance.database': {
                settings: { tier: 'db-custom-4-16384' },
              },
            }),
          },
          { deployTarget: CLOUD, cloud: 'gcp' },
          { saved: [existing] },
        ),
      ).toEqual([
        `pg.native.gcp.${SQL}: refused - an Existing database is used as given; Cloudgate makes nothing of it native.gcp can set`,
      ]);
    });

    it('refuses an Existing database’s endpoint whole, and names it as one only an Existing database makes', () => {
      const endpoint = {
        'google_compute_address.endpoint': { address: '10.0.0.9' },
      };
      expect(
        refusals(
          { pg: postgres(endpoint) },
          { deployTarget: CLOUD, cloud: 'gcp' },
          { saved: [existing] },
        ),
      ).toEqual([
        'pg.native.gcp."google_compute_address.endpoint": refused - locked whole: an Existing database\'s endpoint in the Environment network is how every linked Service reaches it, Cloudgate\'s',
      ]);
      expect(
        refusals(
          { pg: postgres(endpoint) },
          { deployTarget: CLOUD, cloud: 'gcp' },
        ),
      ).toEqual([
        'pg.native.gcp."google_compute_address.endpoint": refused - it is made only for an Existing database, as its endpoint',
      ]);
    });

    it('checks an Existing database’s native.gcp on AWS as Cloudgate-made, a fact only Google Cloud knows', () => {
      const outcome = plan(
        {
          pg: postgres({
            'google_sql_database_instance.database': {
              settings: { tier: 'db-custom-4-16384' },
            },
          }),
        },
        { deployTarget: CLOUD, cloud: 'aws' },
        { saved: [existing] },
      );
      if (!outcome.ok) {
        expect(outcome.refusals.map((one) => one.at)).not.toContain(
          `pg.native.gcp.${SQL}`,
        );
      }
    });
  });
});
