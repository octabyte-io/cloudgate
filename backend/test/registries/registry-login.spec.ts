import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { ExecError } from '../../src/remote/exec-error';
import {
  REGISTRY_LOGIN_PASSWORD_HOLDER,
  registryLoginFailure,
  registryLoginProbeCommand,
} from '../../src/registries/registry-login';
import { SHELL_PAYLOAD } from '../utils/shell-safety';
import {
  dockerLoginRefusal,
  installDockerLoginStub,
} from './docker-login-stub';
import type { DockerLoginStub } from './docker-login-stub';

/** Runs the probe under a real `/bin/sh`, the password in its environment only. */
const runProbe = (stub: DockerLoginStub, command: string, password: string) =>
  spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: {
      PATH: `${stub.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: process.env.HOME,
      [REGISTRY_LOGIN_PASSWORD_HOLDER]: password,
    },
  });

describe('registryLoginProbeCommand', () => {
  let stub: DockerLoginStub;

  beforeEach(() => {
    stub = installDockerLoginStub({ user: 'cgui', password: 'right-pass' });
  });

  afterEach(() => {
    stub.remove();
  });

  it('exits 0 for a login the registry accepts', () => {
    const ran = runProbe(
      stub,
      registryLoginProbeCommand('127.0.0.1:5000', 'cgui'),
      'right-pass',
    );

    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('Login Succeeded');
  });

  it("exits non-zero with the registry's own refusal on stderr for a wrong password", () => {
    const ran = runProbe(
      stub,
      registryLoginProbeCommand('127.0.0.1:5000', 'cgui'),
      'wrong-pass',
    );

    expect(ran.status).not.toBe(0);
    expect(ran.stderr.trim()).toBe(dockerLoginRefusal('127.0.0.1:5000'));
  });

  /**
   * The stdin-login rule, stated as what the program did rather than what the string
   * looks like: `docker` read the password off stdin, and neither its argv nor
   * the command handed to the shell ever held it.
   */
  it('hands docker the password on stdin and never in a command line', () => {
    const command = registryLoginProbeCommand('127.0.0.1:5000', 'cgui');
    runProbe(stub, command, 'right-pass');

    const [call] = stub.calls();
    expect(call.stdin).toBe('right-pass');
    expect(call.argv).toBe('login 127.0.0.1:5000 -u cgui --password-stdin');
    expect(command).not.toContain('right-pass');
    expect(command).toContain(`"$${REGISTRY_LOGIN_PASSWORD_HOLDER}"`);
  });

  /**
   * A test is a question, not a login: a passing one must not replace whatever
   * credential the host's own `~/.docker/config.json` holds for that registry,
   * and must not leave the tested one behind in a file on the host.
   */
  it('logs in to a throwaway docker config and removes it afterwards', () => {
    runProbe(
      stub,
      registryLoginProbeCommand('127.0.0.1:5000', 'cgui'),
      'right-pass',
    );

    const [call] = stub.calls();
    expect(call.dockerConfig).not.toBe('');
    expect(call.dockerConfig).not.toContain('.docker');
    expect(fs.existsSync(call.dockerConfig)).toBe(false);
  });

  it('removes the throwaway config after a refused login too', () => {
    runProbe(
      stub,
      registryLoginProbeCommand('127.0.0.1:5000', 'cgui'),
      'wrong-pass',
    );

    const [call] = stub.calls();
    expect(call.dockerConfig).not.toBe('');
    expect(fs.existsSync(call.dockerConfig)).toBe(false);
  });

  it('asks Docker Hub when no hostname is given', () => {
    const ran = runProbe(
      stub,
      registryLoginProbeCommand('', 'cgui'),
      'right-pass',
    );

    expect(ran.status).toBe(0);
    expect(stub.calls()[0].argv).toBe('login  -u cgui --password-stdin');
  });

  it('keeps a hostile hostname and username inert', () => {
    const ran = runProbe(
      stub,
      registryLoginProbeCommand(
        `ghcr.io${SHELL_PAYLOAD}`,
        `acme${SHELL_PAYLOAD}`,
      ),
      'right-pass',
    );

    // One docker invocation, handed both words literally — `$(id)` unexpanded.
    expect(ran.status).not.toBe(0);
    expect(stub.calls()).toHaveLength(1);
    expect(stub.calls()[0].argv).toBe(
      `login ghcr.io${SHELL_PAYLOAD} -u acme${SHELL_PAYLOAD} --password-stdin`,
    );
  });
});

describe('registryLoginFailure', () => {
  const refused = (
    details: Partial<ConstructorParameters<typeof ExecError>[1]>,
  ) =>
    new ExecError('Command execution failed: Command failed: printf …', {
      command: 'printf …',
      ...details,
    });

  it("says a refused password in plain words, with the registry's own answer as output", () => {
    expect(
      registryLoginFailure(
        refused({ stderr: `${dockerLoginRefusal('127.0.0.1:5000')}\n` }),
        'wrong-pass',
        '127.0.0.1:5000',
      ),
    ).toEqual({
      message:
        '127.0.0.1:5000 refused the username or password (401 Unauthorized).',
      output: dockerLoginRefusal('127.0.0.1:5000'),
    });
  });

  /**
   * What the console showed for an unreachable host — docker's logrus
   * line, a Go memory address, and the same error twice.
   */
  it("says an unreachable registry in one sentence, keeping docker's log lines for output", () => {
    const stderr = [
      'time="2026-11-03T17:47:03Z" level=info msg="Error logging in to endpoint, trying next endpoint" endpoint="{https://registry.example.com 0x643c66b0960}" error="Get \\"https://registry.example.com/v2/\\": Bad Gateway"',
      'Get "https://registry.example.com/v2/": Bad Gateway',
    ].join('\n');

    const said = registryLoginFailure(
      refused({ stderr }),
      'wrong-pass',
      'registry.example.com',
    );

    expect(said.message).toBe(
      'Could not reach registry.example.com (Bad Gateway).',
    );
    expect(said.message).not.toMatch(/0x[0-9a-f]+|level=|time=/);
    expect(said.output).toBe(stderr);
  });

  it('names the last clause of a network failure, and Docker Hub when no host was given', () => {
    expect(
      registryLoginFailure(
        refused({
          stderr:
            'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 127.0.0.11:53: no such host',
        }),
        'wrong-pass',
        '',
      ).message,
    ).toBe('Could not reach Docker Hub (no such host).');
  });

  it('falls back to the message when nothing reached stderr, as over a refused SSH session', () => {
    expect(
      registryLoginFailure(
        new ExecError('Authentication failed: the SSH key was not accepted', {
          command: 'printf …',
        }),
        'wrong-pass',
      ),
    ).toEqual({
      message: 'Authentication failed: the SSH key was not accepted',
    });
  });

  it('never repeats the password, whatever the tool said', () => {
    const said = registryLoginFailure(
      refused({
        stderr: 'unexpected answer for s3cr3t-pass from the registry',
      }),
      's3cr3t-pass',
    );

    expect(JSON.stringify(said)).not.toContain('s3cr3t-pass');
    expect(said.message).toContain('unexpected answer for');
  });

  it('answers a fixed sentence for something that is not an exec failure', () => {
    expect(registryLoginFailure(undefined, 'x')).toEqual({
      message: 'The registry refused the login',
    });
  });
});
