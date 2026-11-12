import { parseDocument } from 'yaml';
import { buildIdentityNames } from '../../../src/cloud-accounts/gcp/cloud-build-names';
import { idKey } from '../../../src/cloud-accounts/gcp/definitions/names';
import {
  GOOGLE_ROLE_VERSION,
  SELF_HOSTED_GOOGLE_ROLE_VERSION,
  SHIPPED_GOOGLE_ROLE,
  instanceGoogleRole,
  requiredPermissions,
} from '../../../src/cloud-accounts/gcp/deploy-role';
import { makeSigningKey } from '../../../src/cloud-accounts/gcp/id-token';
import {
  BUILD_ROLE_PERMISSIONS,
  buildRoleDefinition,
  googleSetupTemplate,
} from '../../../src/cloud-accounts/gcp/setup-script';

const INPUT = {
  projectId: 'shop-prod',
  cloudAccountId: 'Cloud_Acct-1',
  issuer: 'https://cloudgate.example.com/x',
  publicKeys: [makeSigningKey().publicJwk],
};

const at = (version: number) =>
  googleSetupTemplate(INPUT, { ...SHIPPED_GOOGLE_ROLE, version });

/**
 * The setup script's build identity (ADR-0047): from role version 6
 * on, the customer's own setup makes the service account a hosted cloud
 * build runs as, with a custom role of exactly the listed permissions held
 * under one condition, and log writing, which only this script can grant.
 * Cloudgate never makes it.
 */
describe('googleSetupTemplate: the build identity', () => {
  const KEY = idKey('Cloud_Acct-1');
  const v6 = at(6);
  const names = buildIdentityNames(INPUT);

  it('reads its source, pushes images, and nothing else', () => {
    expect([...BUILD_ROLE_PERMISSIONS].sort()).toEqual([
      'artifactregistry.repositories.downloadArtifacts',
      'artifactregistry.repositories.uploadArtifacts',
      'artifactregistry.tags.create',
      'artifactregistry.tags.update',
      'storage.objects.get',
    ]);
    expect(v6.buildRoleDefinition).toBe(buildRoleDefinition());
    expect(buildRoleDefinition()).toContain('includedPermissions:');
  });

  it("names it for the Cloud account, inside Google's limits", () => {
    expect(v6.names.build).toEqual({
      serviceAccount: `cloudgate-build-${KEY}`,
      serviceAccountEmail: `cloudgate-build-${KEY}@shop-prod.iam.gserviceaccount.com`,
      role: `cloudgate_build_${KEY}`,
    });
    // A service account id is 6-30 characters.
    expect(v6.names.build!.serviceAccount.length).toBeLessThanOrEqual(30);
  });

  it('makes the service account and its role, binds the role under its condition, and grants log writing', () => {
    const { script } = v6;
    expect(script).toContain(`BUILD_SERVICE_ACCOUNT='cloudgate-build-${KEY}'`);
    expect(script).toContain(`BUILD_ROLE='cloudgate_build_${KEY}'`);
    expect(script).toContain(
      'gcloud iam service-accounts create "$BUILD_SERVICE_ACCOUNT" --display-name="Cloudgate build"',
    );
    expect(script).toContain(buildRoleDefinition().trimEnd());
    expect(script).toContain(
      'gcloud iam roles create "$BUILD_ROLE" --project="$PROJECT_ID" --file=cloudgate-build-role.yaml',
    );
    expect(script).toContain(`expression: '${names.condition.expression}'`);
    expect(script).toContain(
      '--condition-from-file=cloudgate-build-condition.yaml',
    );
    expect(script).toContain('--role=roles/logging.logWriter --condition=None');
  });

  it("scopes the condition's Cloud Storage reads to this Cloud account's source buckets, and tests no other resource's name", () => {
    expect(names.condition.expression).toBe(
      'resource.service != "storage.googleapis.com" || ' +
        `resource.name.startsWith("projects/_/buckets/cloudgate-build-${KEY}-")`,
    );
    // Artifact Registry gives a condition no resource name, so any test of
    // one there is false and refuses the push: on staging, a condition
    // naming `.../repositories/cloudgate-` refused every hosted build's
    // push, and a live probe pushed under this form and was refused under
    // that one.
    expect(names.condition.expression).not.toContain('artifactregistry');
    expect(names.condition.expression).not.toContain('repositories');
    // gcloud reads it from YAML in single quotes.
    expect(names.condition.expression).not.toContain("'");
  });

  it('turns on the Cloud Build API in step 1', () => {
    expect(v6.script).toMatch(
      /gcloud services enable [^\n]* cloudbuild\.googleapis\.com\n/,
    );
  });

  it.each([5, 7])(
    'is not in a version %i script, which a Self-hosted instance hands out',
    (version) => {
      const v5 = at(version);
      expect(v5.names.build).toBeUndefined();
      expect(v5.buildRoleDefinition).toBeUndefined();
      expect(v5.script).not.toContain('BUILD_SERVICE_ACCOUNT');
      expect(v5.script).not.toContain('cloudbuild');
      expect(v5.script).not.toContain('logging.logWriter');
    },
  );
});

/** Every `cat > <file> <<'X' … X` heredoc in a script, by file name. */
function heredocs(script: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const [, file, , body] of script.matchAll(
    /^cat > (\S+) <<'(\w+)'\n([\s\S]*?)\n\2$/gm,
  )) {
    expect(files.has(file)).toBe(false);
    files.set(file, body);
  }
  return files;
}

/** A heredoc's YAML, refusing what gcloud's parser would refuse. */
function yamlOf(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  expect(doc.errors.map((error) => error.message)).toEqual([]);
  expect(doc.warnings.map((warning) => warning.message)).toEqual([]);
  return doc.toJS();
}

/**
 * The files the script writes are read by gcloud, not by a test, so each is
 * parsed here as gcloud parses it: an unquoted `: ` in the build role's
 * description made every Hosted Google connect fail with "mapping values are
 * not allowed here", and no string assertion noticed.
 */
describe('googleSetupTemplate: every file the script writes parses', () => {
  const VERSIONS = Array.from({ length: GOOGLE_ROLE_VERSION }, (_, i) => i + 1);

  it.each(VERSIONS)('at role version %i', (version) => {
    const template = at(version);
    const files = heredocs(template.script);
    const withBuild = version === 6 || version === 8;
    expect([...files.keys()].sort()).toEqual(
      [
        'cloudgate-jwks.json',
        'cloudgate-role.yaml',
        ...(withBuild
          ? ['cloudgate-build-condition.yaml', 'cloudgate-build-role.yaml']
          : []),
      ].sort(),
    );

    expect(JSON.parse(files.get('cloudgate-jwks.json')!)).toEqual(
      JSON.parse(template.jwks),
    );

    expect(yamlOf(files.get('cloudgate-role.yaml')!)).toEqual({
      title: 'Cloudgate deploy',
      description: `Cloudgate deploy role, version ${version}`,
      stage: 'GA',
      includedPermissions: requiredPermissions(version),
    });

    if (!withBuild) return;
    expect(yamlOf(files.get('cloudgate-build-role.yaml')!)).toEqual({
      title: 'Cloudgate build',
      description:
        'Cloudgate build identity, reads its source and pushes to its repositories',
      stage: 'GA',
      includedPermissions: [...BUILD_ROLE_PERMISSIONS],
    });
    const { condition } = buildIdentityNames(INPUT);
    expect(yamlOf(files.get('cloudgate-build-condition.yaml')!)).toEqual({
      title: condition.title,
      expression: condition.expression,
    });
  });

  it.each([
    ['Self-hosted', false, SELF_HOSTED_GOOGLE_ROLE_VERSION],
    ['Hosted', true, GOOGLE_ROLE_VERSION],
  ])("in a %s instance's script", (_, isHosted, version) => {
    const template = googleSetupTemplate(
      INPUT,
      instanceGoogleRole({ isHosted }),
    );
    expect(template.policyVersion).toBe(version);
    for (const [file, body] of heredocs(template.script)) {
      if (file.endsWith('.json')) JSON.parse(body);
      else expect(yamlOf(body)).toEqual(expect.any(Object));
    }
    expect(yamlOf(template.roleDefinition)).toEqual(
      yamlOf(heredocs(template.script).get('cloudgate-role.yaml')!),
    );
    if (template.buildRoleDefinition !== undefined) {
      expect(yamlOf(template.buildRoleDefinition)).toEqual(
        yamlOf(heredocs(template.script).get('cloudgate-build-role.yaml')!),
      );
    }
  });
});
