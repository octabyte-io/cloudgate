import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { codeBuildCopyScript } from '../../src/cloud-builds/codebuild-program';
import { googleBuildConfig } from '../../src/cloud-builds/google-build-program';
import {
  copySignsIn,
  REGISTRY_PASSWORD_VARIABLE,
} from '../../src/cloud-builds/image-copy-program';

/**
 * The build that copies a ready-made image. The CodeBuild script is
 * run for real against a `docker` stand-in, so what it pulls, how it signs
 * in and what it refuses is what bash does, not what the text looks like.
 */
describe('codeBuildCopyScript', () => {
  const remote = '123456789012.dkr.ecr.eu-central-1.amazonaws.com/cg-web:dep1';
  const registry = '123456789012.dkr.ecr.eu-central-1.amazonaws.com';

  /** Runs the script in a fake source folder; what docker was asked, and how it ended. */
  function run(signsIn: boolean, env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'copy-'));
    const bin = nodePath.join(root, 'bin');
    const src = nodePath.join(root, 'src');
    fs.mkdirSync(bin);
    fs.mkdirSync(nodePath.join(src, 'cloudgate'), { recursive: true });
    const calls = nodePath.join(root, 'calls');
    // Each call's words, and for a login what it read on stdin and whether
    // it signed in against a throwaway config.
    fs.writeFileSync(
      nodePath.join(bin, 'docker'),
      [
        '#!/bin/bash',
        `if [ "$1" = login ]; then echo "login $* stdin=$(cat) config=\${DOCKER_CONFIG:-none}" >> ${calls}; exit 0; fi`,
        `echo "$* password=\${${REGISTRY_PASSWORD_VARIABLE}:-unset} config=\${DOCKER_CONFIG:-none}" >> ${calls}`,
        '[ "$1" = image ] && echo "amd64 null"',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    const script = nodePath.join(src, 'cloudgate', 'build.sh');
    fs.writeFileSync(
      script,
      codeBuildCopyScript({
        source: {
          image: 'registry.example.com/acme/shop:1.4',
          registryUrl: 'registry.example.com',
          username: 'deployer',
          signsIn,
        },
        remote,
        registry,
      }),
    );
    const ran = spawnSync('bash', [script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        CODEBUILD_SRC_DIR: src,
        ...env,
      },
      encoding: 'utf8',
    });
    const said = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
    const image = fs.existsSync(nodePath.join(src, 'cloudgate', 'image'))
      ? fs.readFileSync(nodePath.join(src, 'cloudgate', 'image'), 'utf8')
      : null;
    fs.rmSync(root, { recursive: true, force: true });
    return { status: ran.status, stderr: ran.stderr, calls: said, image };
  }

  it('pulls a public image, then tags and pushes it to the Service’s repository, and says what it is', () => {
    const { status, calls, image } = run(false);
    expect(status).toBe(0);
    const lines = calls.trim().split('\n');
    expect(lines.map((line) => line.split(' ')[0])).toEqual([
      'pull',
      'tag',
      'push',
      'image',
    ]);
    expect(lines[0]).toContain('pull registry.example.com/acme/shop:1.4');
    expect(lines[1]).toContain(
      `tag registry.example.com/acme/shop:1.4 ${remote}`,
    );
    expect(lines[2]).toContain(`push ${remote}`);
    expect(calls).not.toContain('login');
    expect(image).toBe('amd64 null\n');
  });

  it('signs in from the variable CodeBuild read from the parameter, through stdin, then forgets it before the push', () => {
    const { status, calls } = run(true, {
      [REGISTRY_PASSWORD_VARIABLE]: 'pa$$ word',
    });
    expect(status).toBe(0);
    const lines = calls.trim().split('\n');
    expect(lines[0]).toMatch(
      /^login login registry\.example\.com -u deployer --password-stdin stdin=pa\$\$ word config=\/\S+$/,
    );
    // The pull uses the throwaway config; the push no longer has either.
    expect(lines[1]).toMatch(/^pull .* password=unset config=\/\S+$/);
    expect(lines[1]).not.toContain('config=none');
    expect(lines.find((line) => line.startsWith('push'))).toContain(
      'password=unset config=none',
    );
  });

  it('stops before any pull when the password was not handed to it', () => {
    const { status, stderr, calls } = run(true);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      "The registry password was not handed to this build by the cloud's secret store",
    );
    expect(calls).toBe('');
  });
});

describe('copySignsIn', () => {
  it('signs in with a username and a password, as the platform host does, and not with either alone', () => {
    expect(copySignsIn({ username: 'u', password: 'p' })).toBe(true);
    expect(copySignsIn({ username: 'u', password: null })).toBe(false);
    expect(copySignsIn({ username: null, password: 'p' })).toBe(false);
  });
});

describe('googleBuildConfig of a copy with a private registry', () => {
  it('names the Secret Manager version for the one step, and carries no value', () => {
    const config = googleBuildConfig({
      projectId: 'shop-prod',
      bucket: 'cloudgate-build-a-b',
      object: 'builds/dep1/source.zip',
      serviceAccountEmail:
        'cloudgate-build-a@shop-prod.iam.gserviceaccount.com',
      deploymentId: 'dep1',
      registryPassword: {
        versionName: 'projects/123/secrets/cloudgate-build-a-dep1/versions/1',
      },
    });
    expect(config.availableSecrets).toEqual({
      secretManager: [
        {
          versionName: 'projects/123/secrets/cloudgate-build-a-dep1/versions/1',
          env: REGISTRY_PASSWORD_VARIABLE,
        },
      ],
    });
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0].secretEnv).toEqual([REGISTRY_PASSWORD_VARIABLE]);
  });
});
