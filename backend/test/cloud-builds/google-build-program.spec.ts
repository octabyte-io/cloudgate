import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { CLOUD_BUILDER_IMAGE } from '../../src/builders/cloud-builder-image';
import { cloudBuildLogFilter } from '../../src/cloud-accounts/gcp/cloud-build-log';
import {
  googleBuildConfig,
  googleBuildScript,
} from '../../src/cloud-builds/google-build-program';

/**
 * What a hosted Cloud Build build runs. The script is run for real
 * here, against a `docker`, `curl` and metadata server stand-in, so its
 * order — the image's CPU before any push, the build's own token for the
 * login — is what bash does, not what the text looks like.
 */
describe('googleBuildConfig', () => {
  it('runs the build script from the pinned builder image, as the build identity, logging to Cloud Logging only', () => {
    expect(
      googleBuildConfig({
        projectId: 'shop-prod',
        bucket: 'cloudgate-build-a-b',
        object: 'builds/dep_1-x/source.zip',
        serviceAccountEmail:
          'cloudgate-build-a@shop-prod.iam.gserviceaccount.com',
        deploymentId: 'dep_1-x',
      }),
    ).toEqual({
      source: {
        storageSource: {
          bucket: 'cloudgate-build-a-b',
          object: 'builds/dep_1-x/source.zip',
        },
      },
      steps: [
        {
          name: CLOUD_BUILDER_IMAGE,
          entrypoint: 'bash',
          args: ['cloudgate/build.sh'],
        },
      ],
      serviceAccount:
        'projects/shop-prod/serviceAccounts/cloudgate-build-a@shop-prod.iam.gserviceaccount.com',
      options: { logging: 'CLOUD_LOGGING_ONLY' },
      tags: ['cloudgate', 'cloudgate-deployment-dep_1-x'],
    });
  });
});

describe('googleBuildScript', () => {
  const remote =
    'europe-west1-docker.pkg.dev/shop-prod/cloudgate-abc/service:dep1';

  /** Runs the script in a fake workspace; what docker was asked, and the output. */
  function run(arch: string) {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gbuild-'));
    const bin = nodePath.join(root, 'bin');
    const workspace = nodePath.join(root, 'workspace');
    const outputs = nodePath.join(root, 'outputs');
    fs.mkdirSync(bin);
    fs.mkdirSync(nodePath.join(workspace, 'code'), { recursive: true });
    fs.mkdirSync(nodePath.join(workspace, 'cloudgate', 'env'), {
      recursive: true,
    });
    fs.writeFileSync(
      nodePath.join(workspace, 'cloudgate', 'env', 'CG_BUILD_ENV_0'),
      'secret value\n',
    );
    const calls = nodePath.join(root, 'calls');
    // The script links the checkout to /cloudgate/code, which the build's
    // step can make because the builder image runs as root. This machine
    // need not be root — the CI runner is not, and the `mkdir` then failed
    // before anything ran — so `mkdir` and `ln` are stand-ins that put
    // /cloudgate under `root` and hand the rest to the real tool.
    for (const tool of ['mkdir', 'ln'])
      fs.writeFileSync(
        nodePath.join(bin, tool),
        `#!/bin/bash\nargs=()\nfor a in "$@"; do case "$a" in /cloudgate|/cloudgate/*) a='${root}'"$a" ;; esac; args+=("$a"); done\nPATH="\${PATH#*:}" exec ${tool} "\${args[@]}"\n`,
        { mode: 0o755 },
      );
    fs.writeFileSync(
      nodePath.join(bin, 'docker'),
      `#!/bin/bash\necho "docker $*" >> '${calls}'\n[ "$1" = login ] && echo "stdin=$(cat)" >> '${calls}'\n[ "$1" = image ] && echo '${arch} null'\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      nodePath.join(bin, 'curl'),
      `#!/bin/bash\necho "curl $*" >> '${calls}'\necho '{"access_token":"ya29.build-token","expires_in":3599,"token_type":"Bearer"}'\n`,
      { mode: 0o755 },
    );
    const script = googleBuildScript({
      program: `echo "built with $CG_BUILD_ENV_0" >> '${calls}'`,
      local: 'web:latest',
      remote,
      registry: 'europe-west1-docker.pkg.dev',
    });
    fs.writeFileSync(nodePath.join(workspace, 'cloudgate', 'build.sh'), script);
    let failed = false;
    try {
      execFileSync('bash', ['cloudgate/build.sh'], {
        cwd: workspace,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          BUILDER_OUTPUT: outputs,
        },
        stdio: 'pipe',
      });
    } catch {
      failed = true;
    }
    const result = {
      failed,
      calls: fs.readFileSync(calls, 'utf8'),
      output: fs.existsSync(nodePath.join(outputs, 'output'))
        ? fs.readFileSync(nodePath.join(outputs, 'output'), 'utf8')
        : null,
      envLeft: fs.existsSync(nodePath.join(workspace, 'cloudgate', 'env')),
      linked: fs.existsSync(nodePath.join(root, 'cloudgate', 'code'))
        ? fs.readlinkSync(nodePath.join(root, 'cloudgate', 'code')) ===
          nodePath.join(workspace, 'code')
        : false,
    };
    fs.rmSync(root, { recursive: true, force: true });
    return result;
  }

  it('builds, writes the image facts to $BUILDER_OUTPUT, logs in with the build’s own token and pushes', () => {
    const result = run('amd64');
    expect(result.failed).toBe(false);
    expect(result.output).toBe('amd64 null');
    expect(result.envLeft).toBe(false);
    expect(result.linked).toBe(true);
    const lines = result.calls.trim().split('\n');
    expect(lines).toEqual([
      // The value exactly as it was, its trailing newline kept.
      'built with secret value',
      '',
      expect.stringMatching(/^docker image inspect --format /),
      expect.stringMatching(
        /^curl -fsS -H Metadata-Flavor: Google http:\/\/metadata\.google\.internal\//,
      ),
      'docker login -u oauth2accesstoken --password-stdin europe-west1-docker.pkg.dev',
      'stdin=ya29.build-token',
      `docker tag web:latest ${remote}`,
      `docker push ${remote}`,
    ]);
  });

  it('fails an image of another CPU before anything is pushed', () => {
    const result = run('arm64');
    expect(result.failed).toBe(true);
    expect(result.output).toBe('arm64 null');
    expect(result.calls).not.toContain('docker push');
    expect(result.calls).not.toContain('curl');
  });
});

describe('cloudBuildLogFilter', () => {
  it('reads the build’s own cloudbuild entries, from the place on', () => {
    expect(
      cloudBuildLogFilter(
        { projectId: 'shop-prod', buildId: 'b-1' },
        { timestamp: '2026-11-04T12:00:00.000Z', insertIds: ['x'] },
        0,
      ),
    ).toBe(
      'logName="projects/shop-prod/logs/cloudbuild" AND resource.type="build" AND resource.labels.build_id="b-1" AND timestamp>="2026-11-04T12:00:00.000Z"',
    );
  });

  it('looks back three hours with no place yet', () => {
    const now = Date.parse('2026-11-04T12:00:00.000Z');
    expect(
      cloudBuildLogFilter({ projectId: 'p', buildId: 'b' }, null, now),
    ).toContain('timestamp>="2026-11-04T09:00:00.000Z"');
  });
});
