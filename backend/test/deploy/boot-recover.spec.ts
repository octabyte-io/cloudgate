import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `deploy/boot-recover.sh` (#105): after Docker starts, it starts the
 * containers Docker tried and failed to start because the swarm's network was
 * not there yet, and nothing else.
 *
 * `docker` is stubbed on PATH by a Node script that answers from
 * `docker inspect`-shaped JSON, one object per container: `ps` lists the
 * exited and created ones that are not running, `inspect` renders the one
 * format the script asks for from that JSON (and refuses any other, so the
 * format is pinned too), `network inspect` answers from the networks given,
 * and `start` marks the container running. Every call is recorded.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/boot-recover.sh');

/** The format the script renders a container's facts with. */
const INSPECT_FORMAT =
  '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}|{{.State.Error}}';

const DOCKER_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FIXTURES;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls'), 'docker ' + args.join(' ') + '\\n');
const containers = JSON.parse(fs.readFileSync(path.join(dir, 'containers.json'), 'utf8'));
const networks = JSON.parse(fs.readFileSync(path.join(dir, 'networks.json'), 'utf8'));
const runningFile = path.join(dir, 'running');
const running = fs.existsSync(runningFile) ? fs.readFileSync(runningFile, 'utf8').split('\\n') : [];
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
const [verb, ...rest] = args;
if (verb === 'network' && rest[0] === 'inspect') {
  const name = rest[rest.length - 1];
  // NETWORK_AFTER: the network answers from that many-th inspect of it on.
  const countFile = path.join(dir, 'network-inspects');
  const count = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
  if (rest.length === 2) fs.writeFileSync(countFile, String(count));
  const after = Number(process.env.NETWORK_AFTER || '1');
  if (!(name in networks) || (rest.length === 2 && count < after)) fail('Error response from daemon: network ' + name + ' not found');
  if (rest.length === 2) { process.stdout.write('[{}]\\n'); process.exit(0); }
  if (rest[1] === '--format' && rest[2] === '{{.Scope}}') { process.stdout.write(networks[name] + '\\n'); process.exit(0); }
  fail('unexpected network inspect: ' + rest.join(' '));
}
if (verb === 'ps') {
  if (rest.join(' ') !== '-aq --filter status=exited --filter status=created') fail('unexpected ps: ' + rest.join(' '));
  for (const c of containers) {
    if (['exited', 'created'].includes(c.State.Status) && !running.includes(c.Id)) process.stdout.write(c.Id + '\\n');
  }
  process.exit(0);
}
if (verb === 'inspect') {
  if (rest[0] !== '--format' || rest[1] !== ${JSON.stringify(INSPECT_FORMAT)}) fail('unexpected inspect format: ' + rest[1]);
  const c = containers.find((x) => x.Id === rest[2]);
  if (!c) fail('Error: No such object: ' + rest[2]);
  const nets = Object.keys(c.NetworkSettings.Networks).sort().map((n) => n + ' ').join('');
  process.stdout.write([c.Name, c.HostConfig.RestartPolicy.Name, nets, c.State.Error].join('|') + '\\n');
  process.exit(0);
}
if (verb === 'start') {
  const c = containers.find((x) => x.Id === rest[0]);
  if (!c || c.StartFails) fail('Error response from daemon: ' + (c ? c.StartFails : 'No such container'));
  fs.appendFileSync(runningFile, c.Id + '\\n');
  process.stdout.write(c.Id + '\\n');
  process.exit(0);
}
fail('unexpected docker ' + args.join(' '));
`;

/** Docker's own words at boot on staging (#105) and in a local reproduction. */
const NOT_FOUND =
  'failed to set up container networking: could not find a network matching network mode cloudgate-network: network cloudgate-network not found';
const INVALID_NODE =
  'failed to set up container networking: invalid cluster node while attaching to network';

interface Container {
  Id: string;
  Name: string;
  HostConfig: { RestartPolicy: { Name: string } };
  NetworkSettings: { Networks: Record<string, object> };
  State: { Status: string; Error: string };
  StartFails?: string;
}

function container(
  name: string,
  {
    policy = 'always',
    status = 'exited',
    error = NOT_FOUND,
    networks = ['cloudgate-network'],
    startFails,
  }: {
    policy?: string;
    status?: string;
    error?: string;
    networks?: string[];
    startFails?: string;
  } = {},
): Container {
  return {
    Id: `id-${name}`,
    Name: `/${name}`,
    HostConfig: { RestartPolicy: { Name: policy } },
    NetworkSettings: {
      Networks: Object.fromEntries(networks.map((n) => [n, {}])),
    },
    State: { Status: status, Error: error },
    ...(startFails ? { StartFails: startFails } : {}),
  };
}

/** The networks Docker finds once the swarm answers, by scope. */
const NETWORKS = {
  'cloudgate-network': 'swarm',
  'cloudgate-ai': 'swarm',
  bridge: 'local',
  'compose-om6jws-ackee_default': 'local',
};

let scratch: string;
let fixtures: string;
let bin: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-recover-'));
  fixtures = path.join(scratch, 'fixtures');
  bin = path.join(scratch, 'bin');
  fs.mkdirSync(fixtures);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  fs.writeFileSync(
    path.join(fixtures, 'networks.json'),
    JSON.stringify(NETWORKS),
  );
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function recover(
  containers: Container[],
  {
    env = {},
    networks = NETWORKS,
  }: { env?: Record<string, string>; networks?: Record<string, string> } = {},
) {
  fs.writeFileSync(
    path.join(fixtures, 'containers.json'),
    JSON.stringify(containers),
  );
  fs.writeFileSync(
    path.join(fixtures, 'networks.json'),
    JSON.stringify(networks),
  );
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      FIXTURES: fixtures,
      CLOUDGATE_BOOT_RECOVER_INTERVAL: '0',
      ...env,
    },
  });
}

function calls(): string[] {
  const file = path.join(fixtures, 'calls');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n')
    : [];
}

const started = () =>
  calls()
    .filter((line) => line.startsWith('docker start '))
    .map((line) => line.slice('docker start '.length));

describe('deploy/boot-recover.sh', () => {
  it('starts a restart-always container whose start failed because cloudgate-network was not found', () => {
    const run = recover([container('cloudgate-traefik')]);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(started()).toEqual(['id-cloudgate-traefik']);
    expect(run.stdout).toContain(
      `Started cloudgate-traefik, on cloudgate-network: Docker could not start it when it started (${NOT_FOUND}).`,
    );
  });

  it('starts unless-stopped, on-failure and created containers whose start failed on the swarm network, whatever Docker’s words for it', () => {
    const run = recover([
      container('compose-1mwoqz-memos-1', { policy: 'unless-stopped' }),
      container('job', { policy: 'on-failure', error: INVALID_NODE }),
      container('compose-om6jws-ackee-1', {
        policy: 'unless-stopped',
        status: 'created',
        networks: ['cloudgate-network', 'compose-om6jws-ackee_default'],
      }),
      container('ai-runtime', { networks: ['cloudgate-ai'] }),
    ]);

    expect(run.status).toBe(0);
    expect(started()).toEqual([
      'id-compose-1mwoqz-memos-1',
      'id-job',
      'id-compose-om6jws-ackee-1',
      'id-ai-runtime',
    ]);
  });

  it('leaves a container someone stopped alone: a stop sets no error', () => {
    const run = recover([
      container('compose-stopped-app-1', {
        policy: 'unless-stopped',
        error: '',
      }),
      container('cloudgate-traefik', { error: '' }),
    ]);

    expect(run.status).toBe(0);
    expect(started()).toEqual([]);
    expect(run.stdout).toBe(
      'Nothing to start: no container is stopped for want of a swarm network.\n',
    );
  });

  it('leaves a container whose restart policy is no alone, though its start failed on the network', () => {
    const run = recover([container('one-off', { policy: 'no' })]);

    expect(run.status).toBe(0);
    expect(started()).toEqual([]);
  });

  it('leaves a container whose start failed for a reason that is not a network alone', () => {
    const run = recover([
      container('broken', {
        error:
          'error while creating mount source path /srv/missing: mkdir /srv/missing: read-only file system',
      }),
    ]);

    expect(run.status).toBe(0);
    expect(started()).toEqual([]);
  });

  it('leaves a container on no swarm network alone, saying so', () => {
    const run = recover([
      container('local-only', {
        networks: ['bridge'],
        error:
          'failed to set up container networking: network gone-network not found',
      }),
    ]);

    expect(run.status).toBe(0);
    expect(started()).toEqual([]);
    expect(run.stdout).toContain('Left local-only stopped');
  });

  it('starts exactly the ones Docker failed on, in the mix a rebooted host holds', () => {
    const run = recover([
      container('cloudgate-traefik'),
      container('compose-1mwoqz-memos-1', { policy: 'unless-stopped' }),
      // Running already: it was only on its own Compose bridge.
      container('compose-om6jws-ackee-mongo-1', {
        policy: 'unless-stopped',
        status: 'running',
        error: '',
        networks: ['compose-om6jws-ackee_default'],
      }),
      container('compose-stopped-app-1', {
        policy: 'unless-stopped',
        error: '',
      }),
    ]);

    expect(run.status).toBe(0);
    expect(started()).toEqual([
      'id-cloudgate-traefik',
      'id-compose-1mwoqz-memos-1',
    ]);
  });

  it('waits for cloudgate-network to be found before it looks at a container', () => {
    const run = recover([container('cloudgate-traefik')], {
      env: { NETWORK_AFTER: '3' },
    });

    expect(run.status).toBe(0);
    const order = calls();
    expect(order.slice(0, 3)).toEqual([
      'docker network inspect cloudgate-network',
      'docker network inspect cloudgate-network',
      'docker network inspect cloudgate-network',
    ]);
    expect(order[3]).toMatch(/^docker ps /);
    expect(started()).toEqual(['id-cloudgate-traefik']);
  });

  it('gives up after its bound with a line that says so, starting nothing', () => {
    const run = recover([container('cloudgate-traefik')], {
      env: { CLOUDGATE_BOOT_RECOVER_TIMEOUT: '0' },
      networks: {},
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      'Gave up after 0s: Docker still does not find cloudgate-network, so no container was started.',
    );
    expect(calls()).toEqual(['docker network inspect cloudgate-network']);
  });

  it('starts the rest when one start fails, and exits 1 naming it', () => {
    const run = recover([
      container('cloudgate-traefik', {
        startFails: 'driver failed programming external connectivity',
      }),
      container('compose-1mwoqz-memos-1', { policy: 'unless-stopped' }),
    ]);

    expect(run.status).toBe(1);
    expect(started()).toEqual([
      'id-cloudgate-traefik',
      'id-compose-1mwoqz-memos-1',
    ]);
    expect(run.stdout).toContain(
      'Could not start cloudgate-traefik: Error response from daemon: driver failed programming external connectivity',
    );
    expect(run.stdout).toContain('Started compose-1mwoqz-memos-1');
  });

  it('starts nothing on a second run: what the first started is running', () => {
    const containers = [
      container('cloudgate-traefik'),
      container('compose-1mwoqz-memos-1', { policy: 'unless-stopped' }),
    ];
    expect(recover(containers).status).toBe(0);
    expect(started()).toHaveLength(2);

    const again = recover(containers);

    expect(again.status).toBe(0);
    expect(started()).toHaveLength(2);
    expect(again.stdout).toBe(
      'Nothing to start: no container is stopped for want of a swarm network.\n',
    );
  });
});
