import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import type { GcpCloudAccount } from '../../src/cloud-accounts/cloud-provider';
import { IapTunnel } from '../../src/stack-vm/iap-tunnel';

/** The relay protocol's frame tags, as Google's own IAP client writes them. */
const CONNECT_SUCCESS_SID = 0x0001;
const DATA = 0x0004;
const ACK = 0x0007;

const sidFrame = (sid: string) => {
  const frame = Buffer.alloc(6 + sid.length);
  frame.writeUInt16BE(CONNECT_SUCCESS_SID, 0);
  frame.writeUInt32BE(sid.length, 2);
  frame.write(sid, 6);
  return frame;
};
const dataFrame = (bytes: Buffer) => {
  const frame = Buffer.alloc(6 + bytes.length);
  frame.writeUInt16BE(DATA, 0);
  frame.writeUInt32BE(bytes.length, 2);
  bytes.copy(frame, 6);
  return frame;
};

/** What the stand-in relay was sent on one connection, frame by frame. */
interface Relayed {
  readonly request: IncomingMessage;
  readonly protocol: string;
  readonly data: Buffer[];
  readonly acks: bigint[];
  closed: boolean;
}

/**
 * A Stack VM's tunnel on Google Cloud (ADR-0070): IAP's TCP forwarding to
 * port 22, spoken by Cloudgate itself over IAP's WebSocket relay with the
 * deploy service account's access token, so the platform host needs no
 * gcloud. The relay here is a stand-in that speaks the same frames and
 * echoes what it is sent, as IAP relays bytes to port 22.
 */
describe('IapTunnel', () => {
  let relay: WebSocketServer;
  let url: string;
  const relayed: Relayed[] = [];
  /** How the stand-in answers a new connection. */
  let answer: (socket: WebSocket, seen: Relayed) => void;

  const echo = (socket: WebSocket, seen: Relayed) => {
    socket.send(sidFrame('session-1'));
    socket.on('message', (message: Buffer) => {
      let at = 0;
      while (at < message.length) {
        const tag = message.readUInt16BE(at);
        if (tag === ACK) {
          seen.acks.push(message.readBigUInt64BE(at + 2));
          at += 10;
          continue;
        }
        const length = message.readUInt32BE(at + 2);
        const bytes = message.subarray(at + 6, at + 6 + length);
        seen.data.push(Buffer.from(bytes));
        socket.send(dataFrame(bytes));
        at += 6 + length;
      }
    });
  };

  const session = jest.fn();
  const account = {
    cloudAccountId: 'acct-g',
    name: 'Production Google',
    cloudId: 'shop-prod-4821',
  } as GcpCloudAccount;
  const endpoint = {
    cloud: 'gcp' as const,
    account,
    zone: 'europe-west1-b',
    instanceName: 'cg-analytics-vm',
  };
  let tunnel: IapTunnel;

  beforeAll(async () => {
    relay = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has('relay.tunnel.cloudproxy.app')
          ? 'relay.tunnel.cloudproxy.app'
          : false,
    });
    await new Promise((resolve) => relay.once('listening', resolve));
    url = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    relay.on('connection', (socket, request) => {
      const seen: Relayed = {
        request,
        protocol: socket.protocol,
        data: [],
        acks: [],
        closed: false,
      };
      relayed.push(seen);
      socket.on('close', () => {
        seen.closed = true;
      });
      answer(socket, seen);
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => relay.close(resolve));
  });

  beforeEach(() => {
    relayed.length = 0;
    answer = echo;
    session.mockReset();
    session.mockResolvedValue({
      ok: true,
      token: { accessToken: 'ya29.deploy-token' },
      credential: { credentialConfiguration: '{}' },
    });
    const cloudAccounts = {
      googleRunSession: session,
    } as unknown as CloudAccountsService;
    tunnel = new IapTunnel(cloudAccounts, url);
  });

  /** Everything `stream` reads until it holds `length` bytes. */
  const read = (stream: Duplex, length: number) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      let held = 0;
      const take = (chunk: Buffer) => {
        chunks.push(chunk);
        held += chunk.length;
        if (held < length) return;
        stream.off('data', take);
        resolve(Buffer.concat(chunks));
      };
      stream.on('data', take);
    });

  const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("opens IAP's TCP forwarding to port 22 of the Stack VM, in its project and zone, as the deploy service account", async () => {
    const opened = await tunnel.open(endpoint);
    opened.destroy();

    expect(session).toHaveBeenCalledWith(account);
    const [{ request, protocol }] = relayed;
    const asked = new URL(request.url ?? '', 'wss://relay');
    expect(asked.pathname).toBe('/v4/connect');
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      project: 'shop-prod-4821',
      zone: 'europe-west1-b',
      instance: 'cg-analytics-vm',
      interface: 'nic0',
      port: '22',
      newWebsocket: 'True',
    });
    expect(request.headers.authorization).toBe('Bearer ya29.deploy-token');
    expect(request.headers.origin).toBe('bot:iap-tunneler');
    expect(protocol).toBe('relay.tunnel.cloudproxy.app');
  });

  it("carries bytes both ways in the relay's data frames, and acknowledges what it reads", async () => {
    const opened = await tunnel.open(endpoint);
    const echoed = read(opened, 19);
    opened.write('SSH-2.0-cloudgate\r\n');

    expect((await echoed).toString()).toBe('SSH-2.0-cloudgate\r\n');
    await settled();
    expect(relayed[0].data.map(String)).toEqual(['SSH-2.0-cloudgate\r\n']);
    expect(relayed[0].acks).toEqual([19n]);
    opened.destroy();
  });

  it('splits a long write into frames no larger than the relay takes', async () => {
    const opened = await tunnel.open(endpoint);
    const long = Buffer.alloc(40_000, 7);
    const echoed = read(opened, long.length);
    opened.write(long);

    expect((await echoed).equals(long)).toBe(true);
    expect(relayed[0].data.map(({ length }) => length)).toEqual([
      16_384, 16_384, 7_232,
    ]);
    opened.destroy();
  });

  it('ends the relay connection when the stream ends', async () => {
    const opened = await tunnel.open(endpoint);
    opened.destroy();
    await settled();

    expect(relayed[0].closed).toBe(true);
  });

  it("refuses in IAP's own words when IAP closes before connecting", async () => {
    answer = (socket) => socket.close(4033, 'not authorized');

    await expect(tunnel.open(endpoint)).rejects.toThrow(
      'IAP refused a tunnel to the Stack VM cg-analytics-vm in europe-west1-b: not authorized (4033)',
    );
  });

  it("refuses when the Cloud account's session is refused, opening no relay connection", async () => {
    session.mockResolvedValue({
      ok: false,
      refusal: 'Cloud account Production Google could not sign in',
    });

    await expect(tunnel.open(endpoint)).rejects.toThrow(
      'Cloud account Production Google could not sign in',
    );
    expect(relayed).toEqual([]);
  });
});
