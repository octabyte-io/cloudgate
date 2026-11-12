import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import type { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import type { AwsCloudAccount } from '../../src/cloud-accounts/cloud-provider';
import { SessionManagerTunnel } from '../../src/stack-vm/session-manager-tunnel';
import { FakeCloudPort } from '../utils/fake-cloud-port';

/**
 * A Stack VM's tunnel on AWS (ADR-0070): a Session Manager session with the
 * SSH document, its bytes carried by the Session Manager plugin's stdin and
 * stdout. The plugin here is a stand-in that says how it was started and
 * then echoes what it is sent, as the real one relays bytes to port 22.
 */
describe('SessionManagerTunnel', () => {
  const folder = mkdtempSync(join(tmpdir(), 'session-manager-plugin-'));
  const plugin = join(folder, 'session-manager-plugin');
  writeFileSync(
    plugin,
    [
      `#!${process.execPath}`,
      'const name = process.argv[2];',
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), response: process.env[name] }) + "\\n");',
      'process.stdin.pipe(process.stdout);',
    ].join('\n'),
  );
  chmodSync(plugin, 0o755);

  const session = {
    accessKeyId: 'ASIA-ROLE',
    secretAccessKey: 'role-secret',
    sessionToken: 'role-token',
  };
  const account = { cloudAccountId: 'acct-1' } as AwsCloudAccount;
  let aws: FakeCloudPort;
  let tunnel: SessionManagerTunnel;
  const original = process.env.SESSION_MANAGER_PLUGIN;

  beforeEach(() => {
    process.env.SESSION_MANAGER_PLUGIN = plugin;
    aws = new FakeCloudPort();
    const cloudAccounts = {
      deployRoleSession: jest.fn().mockResolvedValue({ ok: true, session }),
    } as unknown as CloudAccountsService;
    tunnel = new SessionManagerTunnel(cloudAccounts, aws);
  });

  afterAll(() => {
    if (original === undefined) delete process.env.SESSION_MANAGER_PLUGIN;
    else process.env.SESSION_MANAGER_PLUGIN = original;
  });

  /** The first line the stand-in plugin printed; the stream stays open. */
  function firstLine(stream: Duplex): Promise<string> {
    return new Promise((resolve) => {
      let seen = '';
      const take = (chunk: Buffer) => {
        seen += chunk.toString();
        if (!seen.includes('\n')) return;
        stream.off('data', take);
        stream.pause();
        resolve(seen.split('\n')[0]);
      };
      stream.on('data', take);
    });
  }

  it("starts a Session Manager session with the SSH document to the Stack VM's instance", async () => {
    const opened = await tunnel.open({
      cloud: 'aws',
      account,
      region: 'eu-central-1',
      instanceId: 'i-0stackvm',
    });
    const started = JSON.parse(await firstLine(opened)) as {
      argv: string[];
      response: string;
    };
    opened.destroy();

    expect(aws.calls).toContainEqual({
      method: 'startSshSession',
      region: 'eu-central-1',
      instanceId: 'i-0stackvm',
    });
    expect(started.argv.slice(1, 3)).toEqual(['eu-central-1', 'StartSession']);
    expect(JSON.parse(started.argv[4])).toEqual({
      Target: 'i-0stackvm',
      DocumentName: 'AWS-StartSSHSession',
      Parameters: { portNumber: ['22'] },
    });
    expect(started.argv[5]).toBe('https://ssm.eu-central-1.amazonaws.com');
    expect(JSON.parse(started.response)).toMatchObject({
      TokenValue: 'fake-session-token',
    });
  });

  it("hands the session's token to the plugin in its environment, never on its command line", async () => {
    const opened = await tunnel.open({
      cloud: 'aws',
      account,
      region: 'eu-central-1',
      instanceId: 'i-0stackvm',
    });
    const line = await firstLine(opened);
    opened.destroy();

    const { argv } = JSON.parse(line) as { argv: string[] };
    expect(argv.join(' ')).not.toContain('fake-session-token');
  });

  it('carries bytes both ways through the plugin', async () => {
    const opened = await tunnel.open({
      cloud: 'aws',
      account,
      region: 'eu-central-1',
      instanceId: 'i-0stackvm',
    });
    await firstLine(opened);
    const echoed = new Promise<string>((resolve) => {
      opened.once('data', (chunk: Buffer) => resolve(chunk.toString()));
      opened.resume();
    });
    opened.write('SSH-2.0-cloudgate\r\n');

    expect(await echoed).toBe('SSH-2.0-cloudgate\r\n');
    opened.destroy();
  });

  it('ends the session when the stream ends', async () => {
    const opened = await tunnel.open({
      cloud: 'aws',
      account,
      region: 'eu-central-1',
      instanceId: 'i-0stackvm',
    });
    await firstLine(opened);
    opened.destroy();

    await new Promise((resolve) => setImmediate(resolve));
    expect(aws.calls).toContainEqual(
      expect.objectContaining({
        method: 'terminateSession',
        region: 'eu-central-1',
      }),
    );
  });

  it('refuses when AWS refuses the session, starting no plugin', async () => {
    jest.spyOn(aws, 'startSshSession').mockResolvedValue({
      ok: false,
      code: 'TargetNotConnected',
      message: 'i-0stackvm is not connected.',
    });

    await expect(
      tunnel.open({
        cloud: 'aws',
        account,
        region: 'eu-central-1',
        instanceId: 'i-0stackvm',
      }),
    ).rejects.toThrow(
      'AWS refused a Session Manager session to the Stack VM: i-0stackvm is not connected.',
    );
  });
});
