import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The cloud port is the only seam that reaches AWS (spec "The cloud
 * port"): `AwsCloudAdapter` is the one file in `src` that imports the AWS SDK,
 * so everything else reaches AWS through `AWS_CLOUD_PORT` — which every e2e
 * replaces with `test/utils/fake-cloud-port.ts`. A second importer would be a
 * call no e2e can fake and no fake records.
 *
 * The one other is the object-storage port's adapter: it
 * speaks the S3 protocol to Garage as well as to AWS, so it is a port of its
 * own, `OBJECT_STORAGE`, which every e2e replaces with
 * `test/utils/fake-object-storage.ts`.
 */

const backendRoot = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('AWS_CLOUD_PORT', () => {
  it('is, with the object-storage port, the only way src reaches the AWS SDK', () => {
    const importers = walk(join(backendRoot, 'src'))
      .filter((file) =>
        /from '@aws-sdk\/|require\('@aws-sdk\//.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(backendRoot, file));

    expect(importers.sort()).toEqual([
      'src/cloud-accounts/aws/aws-cloud.adapter.ts',
      'src/object-storage/s3-object-storage.adapter.ts',
    ]);
  });
});

describe('GOOGLE_CLOUD_PORT', () => {
  // The Google half of the seam (spec S12): `GoogleCloudAdapter` is
  // the one file that reaches Google Cloud, so everything else goes through
  // `GOOGLE_CLOUD_PORT`, which every e2e replaces with
  // `test/utils/fake-google-cloud-port.ts`. It speaks Google's REST APIs
  // over `fetch`, so the gate is twofold: no file imports a Google client
  // library, and only the adapter names a Google Cloud API's address.
  const ADAPTER = 'src/cloud-accounts/gcp/google-cloud.adapter.ts';

  it('is reached through no Google client library', () => {
    const importers = walk(join(backendRoot, 'src'))
      .filter((file) =>
        /from '(googleapis|google-auth-library|@google-cloud\/|@googleapis\/)|require\('(googleapis|google-auth-library|@google-cloud\/|@googleapis\/)/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(backendRoot, file));

    expect(importers).toEqual([]);
  });

  it('is the only file that names a Google Cloud API address', () => {
    const callers = walk(join(backendRoot, 'src'))
      .filter((file) =>
        // Gemini's endpoint is an AI model's (`ai/select-ai-provider.ts`),
        // not Google Cloud's. Cloud Storage's bare S3 endpoint, with no API
        // path (`gcp/cloud-storage-s3.ts`), is spoken to in the S3
        // protocol by the object-storage port and by linked Services, never
        // as a Google API.
        /https:\/\/(?!generativelanguage\.)(?!storage\.googleapis\.com['"`])[a-z0-9-]+\.googleapis\.com/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(backendRoot, file));

    expect(callers).toEqual([ADAPTER]);
  });
});

describe('HETZNER_MACHINES and HETZNER_PRICES', () => {
  // The provider of Bought Servers (ADR-0071): `HetznerCloudAdapter` is the
  // one file that reaches it, so everything else goes through the port, which
  // every e2e replaces with `test/utils/fake-hetzner-cloud.ts` (two of them,
  // one per account). It speaks the REST API over `fetch`, never through the
  // `hcloud` CLI or a client library, so the gate is threefold: no file
  // imports a client, no file runs the CLI, and only the adapter names the
  // API's address.
  const ADAPTER = 'src/bought-servers/hetzner/hetzner-cloud.adapter.ts';

  it('is reached through no client library', () => {
    const importers = walk(join(backendRoot, 'src'))
      .filter((file) =>
        /from '(hcloud[^']*|@hetzner[^']*)'|require\('(hcloud|@hetzner)/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(backendRoot, file));

    expect(importers).toEqual([]);
  });

  it('is reached through no hcloud CLI', () => {
    const runners = walk(join(backendRoot, 'src'))
      .filter((file) =>
        // The binary as a program name: a quoted `hcloud`, or a command
        // string that starts with it, in code rather than in a docblock
        // that says it is not used.
        /['"`]hcloud(['"`]|\s)/.test(
          readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n'),
        ),
      )
      .map((file) => relative(backendRoot, file));

    expect(runners).toEqual([]);
  });

  it("is the only file that names the provider's API address", () => {
    const callers = walk(join(backendRoot, 'src'))
      .filter((file) =>
        /api\.hetzner\.(cloud|com)/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(backendRoot, file));

    expect(callers).toEqual([ADAPTER]);
  });
});

describe('TofuRunner', () => {
  // The other half of the seam: `tofu` is spawned by the runner alone,
  // and the runner is reached only through a cloud's adapter. It is shared by
  // both clouds (ADR-0030), so it lives beside neither adapter.
  const SHARED_RUNNER = 'src/cloud-accounts/tofu/tofu-runner.ts';

  it('lives in the shared cloud-accounts/tofu/', () => {
    const runners = walk(join(backendRoot, 'src'))
      .filter((file) => file.endsWith('/tofu-runner.ts'))
      .map((file) => relative(backendRoot, file));

    expect(runners).toEqual([SHARED_RUNNER]);
  });

  it('is reached only through a cloud adapter', () => {
    const importers = walk(join(backendRoot, 'src'))
      .filter((file) => /\/tofu-runner'/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(backendRoot, file));

    expect(importers).toContain('src/cloud-accounts/aws/aws-cloud.adapter.ts');
    for (const importer of importers) {
      expect(importer).toMatch(
        /^src\/cloud-accounts\/[a-z]+\/[a-z]+-cloud\.adapter\.ts$/,
      );
    }
  });
});
