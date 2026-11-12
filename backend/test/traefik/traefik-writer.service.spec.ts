import * as fs from 'node:fs';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

// The filesystem and SSH are system boundaries — both are mocked; tests
// assert which side the writer picks based on serverId.
jest.mock('node:fs');

const mockedFs = jest.mocked(fs);

// `withArgvExec` because an earlier change moved this writer's three single
// commands to argv: the fake words them exactly as `execRemote` does and forwards them to
// `execAsyncRemote`, so every assertion below still reads the one command the
// transport carried — which is the writer's contract — rather than a second seam
// saying the same thing. The two `base64 -d >` writes are shell programs and
// were never argv, so they arrive here unchanged.
const execAsyncRemote = jest.fn();
const remoteExec = withArgvExec({
  execAsyncRemote,
}) as unknown as RemoteExecService;

/**
 * The directory Traefik's file provider watches, on each of the two machines
 * the writer can be asked about. The platform host's is under this
 * process's own root, so it is taken from the machine rather than spelled:
 * with `CLOUDGATE_DIRECTORY` unset both roots are `/etc/cloudgate`, and a
 * spelled literal passed only for as long as the lane left it unset. A
 * Server's is the tree `serverSetupCommand` created there, whatever this
 * instance's root has been moved to.
 */
const LOCAL_DYNAMIC_PATH = `${cloudgateDirectoryOn(null)}/traefik/dynamic`;
const REMOTE_DYNAMIC_PATH = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic`;

const YAML_FIXTURE = `http:
  routers:
    api-router-1:
      rule: Host(\`api.example.com\`)
      service: api-service-1
`;

const CONFIG_FIXTURE = {
  http: {
    routers: {
      'api-router-1': {
        rule: 'Host(`api.example.com`)',
        service: 'api-service-1',
      },
    },
  },
};

describe('TraefikWriterService', () => {
  let writer: TraefikWriterService;

  beforeEach(() => {
    jest.clearAllMocks();
    writer = new TraefikWriterService(remoteExec);
  });

  describe('loadOrCreateConfig', () => {
    it('parses the local file when no serverId is given', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(YAML_FIXTURE);

      const config = await writer.loadOrCreateConfig('api');

      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        `${LOCAL_DYNAMIC_PATH}/api.yml`,
        'utf8',
      );
      expect(execAsyncRemote).not.toHaveBeenCalled();
      expect(config).toEqual(CONFIG_FIXTURE);
    });

    it('returns an empty skeleton when the local file is missing', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      await expect(writer.loadOrCreateConfig('api')).resolves.toEqual({
        http: { routers: {}, services: {} },
      });
    });

    it('cats the remote file when a serverId is given', async () => {
      execAsyncRemote.mockResolvedValue({
        stdout: YAML_FIXTURE,
        stderr: '',
        exitCode: 0,
      });

      const config = await writer.loadOrCreateConfig('api', 'server-1');

      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        `cat ${REMOTE_DYNAMIC_PATH}/api.yml`,
      );
      expect(config).toEqual(CONFIG_FIXTURE);
    });

    it('returns an empty skeleton when the remote read fails', async () => {
      execAsyncRemote.mockRejectedValue(new Error('No such file'));

      await expect(
        writer.loadOrCreateConfig('api', 'server-1'),
      ).resolves.toEqual({ http: { routers: {}, services: {} } });
    });
  });

  describe('writeConfig', () => {
    it('writes YAML under the dynamic directory when local', async () => {
      await writer.writeConfig('api', CONFIG_FIXTURE);

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(LOCAL_DYNAMIC_PATH, {
        recursive: true,
      });
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        `${LOCAL_DYNAMIC_PATH}/api.yml`,
        YAML_FIXTURE,
        'utf8',
      );
      expect(execAsyncRemote).not.toHaveBeenCalled();
    });

    it('pipes base64 YAML over SSH when a serverId is given', async () => {
      execAsyncRemote.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await writer.writeConfig('api', CONFIG_FIXTURE, 'server-1');

      const encoded = Buffer.from(YAML_FIXTURE).toString('base64');
      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        `echo "${encoded}" | base64 -d > ${REMOTE_DYNAMIC_PATH}/api.yml`,
      );
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('removeConfig', () => {
    it('deletes the local file when no serverId is given', async () => {
      await writer.removeConfig('api');

      expect(mockedFs.rmSync).toHaveBeenCalledWith(
        `${LOCAL_DYNAMIC_PATH}/api.yml`,
        { force: true },
      );
      expect(execAsyncRemote).not.toHaveBeenCalled();
    });

    it('removes the remote file over SSH when a serverId is given', async () => {
      execAsyncRemote.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await writer.removeConfig('api', 'server-1');

      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        `rm -f ${REMOTE_DYNAMIC_PATH}/api.yml`,
      );
      expect(mockedFs.rmSync).not.toHaveBeenCalled();
    });
  });
});

describe('TraefikWriterService shell safety', () => {
  let writer: TraefikWriterService;

  beforeEach(() => {
    jest.clearAllMocks();
    execAsyncRemote.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    writer = new TraefikWriterService(remoteExec);
  });

  /** The command the one remote call was given. */
  const remoteCommand = (): string => {
    const [call] = execAsyncRemote.mock.calls as [string, string][];
    return call[1];
  };

  // The remote branches are shell, and the verbs the two values reach are
  // `cat`, `rm -f`, `rm -rf` and a `>` redirect. The local branches hand the
  // same paths to `fs`, which is not a shell.
  it('quotes the config path it reads, writes and removes over SSH', async () => {
    await writer.loadOrCreateConfig(SHELL_PAYLOAD, 'server-1');
    expectQuotedInCommand(remoteCommand());

    execAsyncRemote.mockClear();
    await writer.writeConfig(SHELL_PAYLOAD, CONFIG_FIXTURE, 'server-1');
    expectQuotedInCommand(remoteCommand());

    execAsyncRemote.mockClear();
    await writer.removeConfig(SHELL_PAYLOAD, 'server-1');
    expectQuotedInCommand(remoteCommand());
    expect(remoteCommand()).toContain('rm -f');
  });

  it("quotes a certificate's own directory when writing and removing it", async () => {
    await writer.writeCertificate({
      certificatePath: SHELL_PAYLOAD,
      certificateData: 'CERT',
      privateKey: 'KEY',
      serverId: 'server-1',
    });
    // One substitution, the contract: the fragment is renamed into place from
    // `tmp=$(mktemp …)` (`replaceOwnerOnlyFileCommand`).
    expectQuotedInCommand(remoteCommand(), SHELL_PAYLOAD, 1);

    execAsyncRemote.mockClear();
    await writer.removeCertificate(SHELL_PAYLOAD, 'server-1');
    // One substitution again: the `mktemp` a legacy fragment's removal creates
    // and removes at the top of dynamic/ so Traefik reloads.
    expectQuotedInCommand(remoteCommand(), SHELL_PAYLOAD, 1);
    expect(remoteCommand()).toContain('rm -rf');
  });
});
