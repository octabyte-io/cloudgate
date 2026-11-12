import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asRootProgram,
  mergeDaemonConfig,
  swarmResourceAtTopLevel,
  writeGpuConfigScript,
} from '../../src/settings/gpu-setup-script';
import type { DaemonConfig } from '../../src/settings/gpu-setup-script';

/**
 * The stock `config.toml` of NVIDIA Container Toolkit 1.20.1, which ends
 * in the `[nvidia-ctk]` table: appending `swarm-resource` put it there, where
 * the runtime ignores it.
 */
const TOOLKIT_1_20_1 = `#accept-nvidia-visible-devices-as-volume-mounts = false
#accept-nvidia-visible-devices-envvar-when-unprivileged = true
disable-require = false
supported-driver-capabilities = "compat32,compute,display,graphics,ngx,utility,video"
#swarm-resource = "DOCKER_RESOURCE_GPU"

[nvidia-container-cli]
#debug = "/var/log/nvidia-container-toolkit.log"
environment = []
ldconfig = "@/sbin/ldconfig.real"
load-kmods = true

[nvidia-container-runtime]
log-level = "info"
mode = "auto"
runtimes = ["runc", "crun"]

[nvidia-container-runtime.modes.cdi]
annotation-prefixes = ["cdi.k8s.io/"]
default-kind = "nvidia.com/gpu"
spec-dirs = ["/etc/cdi", "/var/run/cdi"]

[nvidia-container-runtime-hook]
path = "nvidia-container-runtime-hook"
skip-mode-detection = false

[nvidia-ctk]
path = "nvidia-ctk"
`;

/** What setup before the fix left: the key appended inside `[nvidia-ctk]`. */
const SET_UP_THE_OLD_WAY = `${TOOLKIT_1_20_1.replace(
  '#swarm-resource = "DOCKER_RESOURCE_GPU"\n',
  '',
)}swarm-resource = "DOCKER_RESOURCE_GPU"\n`;

const CARD = 'GPU-3ca0e410-1a08-8719-b995-43fac161147f';

describe('swarmResourceAtTopLevel', () => {
  it('reads the key before the first table as set', () => {
    expect(
      swarmResourceAtTopLevel(
        'disable-require = false\nswarm-resource = "DOCKER_RESOURCE_GPU"\n\n[nvidia-ctk]\npath = "nvidia-ctk"\n',
      ),
    ).toBe(true);
    expect(
      swarmResourceAtTopLevel("swarm-resource = 'DOCKER_RESOURCE_GPU' # ok\n"),
    ).toBe(true);
  });

  it('reads the key appended inside [nvidia-ctk] as not set', () => {
    expect(swarmResourceAtTopLevel(SET_UP_THE_OLD_WAY)).toBe(false);
  });

  it('reads the stock file, commented out, and an empty file as not set', () => {
    expect(swarmResourceAtTopLevel(TOOLKIT_1_20_1)).toBe(false);
    expect(swarmResourceAtTopLevel('')).toBe(false);
    expect(swarmResourceAtTopLevel('swarm-resource = "OTHER"\n')).toBe(false);
  });
});

describe('mergeDaemonConfig', () => {
  it("keeps the operator's keys and sets the runtime and the cards", () => {
    const merged = mergeDaemonConfig(
      JSON.stringify({
        'default-shm-size': '1G',
        'default-ulimits': { memlock: { Name: 'memlock', Hard: -1, Soft: -1 } },
        'node-generic-resources': ['GPU=1'],
        'default-runtime': 'runc',
      }),
      [CARD],
    );
    expect(merged).toEqual({
      'default-shm-size': '1G',
      'default-ulimits': { memlock: { Name: 'memlock', Hard: -1, Soft: -1 } },
      runtimes: {
        nvidia: { path: 'nvidia-container-runtime', runtimeArgs: [] },
      },
      'default-runtime': 'nvidia',
      'node-generic-resources': [`GPU=${CARD}`],
    });
  });

  it('keeps every declared runtime, the nvidia one included', () => {
    const merged = mergeDaemonConfig(
      JSON.stringify({
        runtimes: {
          nvidia: { args: [], path: '/usr/bin/nvidia-container-runtime' },
          crun: { path: '/usr/bin/crun' },
        },
      }),
      [CARD],
    );
    expect(merged.runtimes).toEqual({
      nvidia: { args: [], path: '/usr/bin/nvidia-container-runtime' },
      crun: { path: '/usr/bin/crun' },
    });
  });

  it('starts from nothing when there is no daemon.json', () => {
    expect(mergeDaemonConfig('', [CARD])).toEqual({
      runtimes: {
        nvidia: { path: 'nvidia-container-runtime', runtimeArgs: [] },
      },
      'default-runtime': 'nvidia',
      'node-generic-resources': [`GPU=${CARD}`],
    });
  });

  it('refuses a daemon.json that is not a JSON object rather than overwrite it', () => {
    for (const broken of ['{"debug": true,', '[]', 'null']) {
      expect(() => mergeDaemonConfig(broken, [CARD])).toThrow(
        '/etc/docker/daemon.json is not a JSON object, so GPU setup cannot keep what it holds; fix or remove it and run setup again',
      );
    }
  });
});

/** The generated script, run by `sh` against fixture files in a temp dir. */
describe('writeGpuConfigScript', () => {
  let dir: string;
  let files: { daemonJson: string; runtimeToml: string };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gpu-setup-'));
    files = {
      daemonJson: join(dir, 'daemon.json'),
      // A directory setup has to create, and a quote in the path.
      runtimeToml: join(dir, "nvidia container's", 'config.toml'),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (daemonConfig: DaemonConfig = mergeDaemonConfig('', [CARD])) =>
    execFileSync('sh', ['-c', writeGpuConfigScript(daemonConfig, files)]);
  const toml = () => readFileSync(files.runtimeToml, 'utf8');
  const seed = (content: string) => {
    execFileSync('mkdir', ['-p', join(dir, "nvidia container's")]);
    writeFileSync(files.runtimeToml, content);
  };

  it('moves the key from [nvidia-ctk] to the top level of a toolkit 1.20.1 file', () => {
    seed(SET_UP_THE_OLD_WAY);
    run();

    expect(swarmResourceAtTopLevel(toml())).toBe(true);
    const lines = toml().split('\n');
    expect(lines.filter((l) => l.includes('swarm-resource'))).toEqual([
      'swarm-resource = "DOCKER_RESOURCE_GPU"',
    ]);
    expect(lines.indexOf('swarm-resource = "DOCKER_RESOURCE_GPU"')).toBe(
      lines.indexOf('[nvidia-container-cli]') - 1,
    );
    expect(toml().endsWith('[nvidia-ctk]\npath = "nvidia-ctk"\n')).toBe(true);
  });

  it('keeps the stock file as it is apart from the one line', () => {
    seed(TOOLKIT_1_20_1);
    run();
    expect(toml()).toBe(
      TOOLKIT_1_20_1.replace(
        '\n[nvidia-container-cli]',
        '\nswarm-resource = "DOCKER_RESOURCE_GPU"\n[nvidia-container-cli]',
      ),
    );
  });

  it('leaves the same files when run twice', () => {
    seed(SET_UP_THE_OLD_WAY);
    const config = mergeDaemonConfig('', [CARD]);
    run(config);
    const once = [toml(), readFileSync(files.daemonJson, 'utf8')];
    run(config);
    expect([toml(), readFileSync(files.daemonJson, 'utf8')]).toEqual(once);
  });

  it('writes a config.toml where there is none', () => {
    run();
    expect(toml()).toBe('swarm-resource = "DOCKER_RESOURCE_GPU"\n');
  });

  it("writes the merged daemon.json verbatim, a quote or a '$' in a value included", () => {
    writeFileSync(
      files.daemonJson,
      JSON.stringify({ 'default-shm-size': '1G', label: "it's $HOME `x`" }),
    );
    const merged = mergeDaemonConfig(readFileSync(files.daemonJson, 'utf8'), [
      CARD,
    ]);
    run(merged);
    expect(JSON.parse(readFileSync(files.daemonJson, 'utf8'))).toEqual(merged);
    expect(merged).toMatchObject({
      'default-shm-size': '1G',
      label: "it's $HOME `x`",
    });
  });
});

/**
 * The script as GPU setup actually sends it: `asRootProgram`'s `sudo sh -s`
 * heredoc, run by `sh -c` as `execAsync` would, with a `sudo` on PATH that
 * only runs its arguments.
 */
describe('asRootProgram', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gpu-root-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'sudo'), '#!/bin/sh\nexec "$@"\n');
    chmodSync(join(dir, 'bin', 'sudo'), 0o755);
    env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a daemon.json holding both ' and ! through, and the awk program's !done", () => {
    const files = {
      daemonJson: join(dir, 'daemon.json'),
      runtimeToml: join(dir, 'nvidia', 'config.toml'),
    };
    const merged = mergeDaemonConfig(
      JSON.stringify({ label: "it's done! $HOME `x` \\n" }),
      [CARD],
    );
    mkdirSync(join(dir, 'nvidia'));
    writeFileSync(files.runtimeToml, '[nvidia-ctk]\npath = "nvidia-ctk"\n');
    execFileSync(
      'sh',
      ['-c', asRootProgram(writeGpuConfigScript(merged, files))],
      { env },
    );
    expect(JSON.parse(readFileSync(files.daemonJson, 'utf8'))).toEqual(merged);
    expect(merged.label).toBe("it's done! $HOME `x` \\n");
    // `!done` reached awk intact: the key went in before the table.
    expect(readFileSync(files.runtimeToml, 'utf8')).toBe(
      'swarm-resource = "DOCKER_RESOURCE_GPU"\n[nvidia-ctk]\npath = "nvidia-ctk"\n',
    );
  });

  it('refuses a script holding its own end-of-program line', () => {
    expect(() => asRootProgram('echo\nCLOUDGATE_GPU_SETUP\nrm -rf /')).toThrow(
      'A GPU setup script cannot hold a line CLOUDGATE_GPU_SETUP',
    );
  });
});
