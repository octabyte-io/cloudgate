import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { gcpStaticDefinition } from '../../../../src/cloud-accounts/gcp/definitions/static-definition';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const INPUT = {
  serviceId: 'Svc_Docs',
  bucketName: `cloudgate-${idKey('Svc_Docs')}-p4x8m2rt`,
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  projectNumber: '829219986263',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Docs-1',
};

/**
 * Spec "Static site on Cloud Storage and Cloud CDN": each
 * setting asserted here is itself the decision, read live on a real
 * project, so a later edit cannot drop one silently.
 */
describe('gcpStaticDefinition', () => {
  const definition = gcpStaticDefinition(INPUT);
  const bucket = resource(definition, 'google_storage_bucket.site');
  const backend = resource(definition, 'google_compute_backend_bucket.site');
  const grant = resource(
    definition,
    'google_storage_bucket_iam_member.load_balancer',
  );

  it('holds the bucket, its Cloud CDN backend bucket and the load balancer’s grant, and nothing else', () => {
    expect(addresses(definition)).toEqual([
      'google_compute_backend_bucket.site',
      'google_storage_bucket.site',
      'google_storage_bucket_iam_member.load_balancer',
    ]);
  });

  it('makes the bucket under the name the plan minted, in the region', () => {
    expect(bucket.name).toBe(INPUT.bucketName);
    expect(bucket.location).toBe('EUROPE-WEST1');
    expect(bucket.force_destroy).toBe(false);
  });

  it('turns soft delete off', () => {
    expect(bucket.soft_delete_policy).toEqual([
      { retention_duration_seconds: 0 },
    ]);
  });

  it('keeps the bucket private: uniform access and public access prevention enforced', () => {
    expect(bucket.uniform_bucket_level_access).toBe(true);
    expect(bucket.public_access_prevention).toBe('enforced');
  });

  it('has no hierarchical namespace, so an object named `live/about/` is allowed', () => {
    expect(bucket.hierarchical_namespace).toEqual([{ enabled: false }]);
  });

  it('has no website configuration, so no MainPageSuffix and no NotFoundPage', () => {
    expect(bucket).not.toHaveProperty('website');
    expect(renderDefinition(definition)).not.toContain('main_page_suffix');
  });

  it('labels the bucket with the state’s mark', () => {
    expect(bucket.labels).toEqual({
      'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
      'cloudgate-environment': idKey('Env_Prod'),
      'cloudgate-state': idKey('State_Docs-1'),
    });
  });

  it('serves the bucket through a Cloud CDN backend bucket named by the Service’s key', () => {
    expect(backend.name).toBe(`cloudgate-${idKey('Svc_Docs')}`);
    expect(backend.bucket_name).toBe('${google_storage_bucket.site.name}');
    expect(backend.enable_cdn).toBe(true);
    expect(backend.description).toBe(
      'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Docs-1',
    );
  });

  it('caches everything at the edge for a long while and tells browsers to check back every time', () => {
    const [policy] = backend.cdn_policy as Record<string, unknown>[];
    expect(policy.cache_mode).toBe('FORCE_CACHE_ALL');
    expect(policy.client_ttl).toBe(0);
    expect(policy.default_ttl).toBeGreaterThanOrEqual(86_400);
  });

  it('sets no max_ttl, which Google refuses with FORCE_CACHE_ALL', () => {
    const [policy] = backend.cdn_policy as Record<string, unknown>[];
    expect(policy).not.toHaveProperty('max_ttl');
  });

  it('turns negative caching off, so a 404 never outlives the deploy that fixes it', () => {
    const [policy] = backend.cdn_policy as Record<string, unknown>[];
    expect(policy.negative_caching).toBe(false);
  });

  it('lets only the load balancer’s service agent read the bucket', () => {
    expect(grant).toEqual({
      bucket: '${google_storage_bucket.site.name}',
      role: 'roles/storage.objectViewer',
      member:
        'serviceAccount:service-829219986263@https-lb.iam.gserviceaccount.com',
    });
  });
});
