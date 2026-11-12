import { Duplex } from 'node:stream';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import WebSocket from 'ws';

import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { describeError } from '../common/describe-error';
import type { StackVmEndpointOn } from '../remote/stack-vm-remote';

/**
 * IAP's TCP-forwarding relay, version 4 of its protocol: the one Google's
 * own IAP tunnel client (`gcloud compute start-iap-tunnel`) speaks. Pinned
 * here, with the `ws` client it is spoken over pinned in `package.json`, so
 * the platform host carries no gcloud and nothing to install for it.
 */
export const IAP_RELAY = 'wss://tunnel.cloudproxy.app';
const RELAY_CONNECT_PATH = '/v4/connect';
const RELAY_SUBPROTOCOL = 'relay.tunnel.cloudproxy.app';
/** The origin IAP's relay expects of a tunnel client that is not a browser. */
const RELAY_ORIGIN = 'bot:iap-tunneler';

/** Frame tags of the relay protocol: a 2-byte tag, big-endian, leads every frame. */
const TAG_CONNECT_SUCCESS_SID = 0x0001;
const TAG_RECONNECT_SUCCESS_ACK = 0x0002;
const TAG_DATA = 0x0004;
const TAG_ACK = 0x0007;
/** The most bytes one data frame carries. */
const MAX_DATA_FRAME = 16_384;

/** How long IAP has to open the tunnel and say so. */
const CONNECT_TIMEOUT_MS = 60_000;

/** The relay's own token for a test's stand-in, in place of {@link IAP_RELAY}. */
export const IAP_RELAY_URL = Symbol('IAP_RELAY_URL');

/**
 * **A Stack VM's tunnel on Google Cloud** (ADR-0070): IAP's TCP forwarding to
 * port 22 of the Stack VM, which has no external address. Cloudgate speaks
 * IAP's WebSocket relay itself, as the deploy service account, with the
 * access token of the Cloud account's run session (the Google client
 * Cloudgate already uses for every Google call), so the tunnel is in the
 * project's own audit log and Cloudgate holds no Google key.
 *
 * The only way in is IAP's range on SSH (`stack-vm-definition.ts`), so
 * nothing reaches the Stack VM but through here. Ending the stream closes
 * the relay connection, which ends the tunnel.
 */
@Injectable()
export class IapTunnel {
  private readonly logger = new Logger(IapTunnel.name);

  constructor(
    private readonly cloudAccounts: CloudAccountsService,
    @Optional()
    @Inject(IAP_RELAY_URL)
    private readonly relay: string = IAP_RELAY,
  ) {}

  async open(endpoint: StackVmEndpointOn<'gcp'>): Promise<Duplex> {
    const { account, zone, instanceName } = endpoint;
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) throw new Error(session.refusal);
    const url = new URL(RELAY_CONNECT_PATH, this.relay);
    url.search = new URLSearchParams({
      project: account.cloudId,
      zone,
      instance: instanceName,
      interface: 'nic0',
      port: '22',
      newWebsocket: 'True',
    }).toString();
    return this.connect(
      url,
      session.token.accessToken,
      `the Stack VM ${instanceName} in ${zone}`,
    );
  }

  private connect(url: URL, token: string, named: string): Promise<Duplex> {
    const socket = new WebSocket(url, RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${token}` },
      origin: RELAY_ORIGIN,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    let received = 0n;
    const stream = new Duplex({
      read() {
        // Bytes are pushed as the relay sends them; SSH's own windows
        // bound how many are in flight.
      },
      write(chunk: Buffer, _encoding, done) {
        if (socket.readyState !== WebSocket.OPEN) {
          done(new Error(`The IAP tunnel to ${named} is closed`));
          return;
        }
        let pending = Math.ceil(chunk.length / MAX_DATA_FRAME);
        let failed = false;
        for (let at = 0; at < chunk.length; at += MAX_DATA_FRAME) {
          socket.send(
            dataFrame(chunk.subarray(at, at + MAX_DATA_FRAME)),
            (error) => {
              if (failed) return;
              if (error) {
                failed = true;
                done(error);
              } else if (--pending === 0) done();
            },
          );
        }
      },
      final(done) {
        socket.close(1000);
        done();
      },
      destroy(error, done) {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000);
        else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        done(error);
      },
    });

    return new Promise<Duplex>((resolve, reject) => {
      let settled = false;
      const refuse = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.terminate();
        reject(new Error(`IAP refused a tunnel to ${named}: ${reason}`));
      };
      const timer = setTimeout(
        () => refuse(`it did not open within ${CONNECT_TIMEOUT_MS / 1000}s`),
        CONNECT_TIMEOUT_MS,
      );

      socket.on('unexpected-response', (request, response) => {
        request.destroy();
        refuse(
          `HTTP ${response.statusCode} ${response.statusMessage ?? ''}`.trim(),
        );
      });
      socket.on('error', (error) => {
        if (!settled) refuse(error.message);
        else
          this.logger.debug(`IAP tunnel to ${named}: ${describeError(error)}`);
      });
      socket.on('close', (code, why) => {
        const reason = `${why.toString() || 'closed'} (${code})`;
        if (!settled) {
          refuse(reason);
          return;
        }
        // The tunnel is over; SSH above says how its connection ended.
        this.logger.debug(`IAP tunnel to ${named} ended: ${reason}`);
        stream.push(null);
        stream.destroy();
      });
      socket.on('message', (message: Buffer) => {
        try {
          for (const frame of framesOf(message)) {
            if (frame.tag === TAG_CONNECT_SUCCESS_SID) {
              if (settled) continue;
              settled = true;
              clearTimeout(timer);
              resolve(stream);
            } else if (frame.tag === TAG_DATA) {
              received += BigInt(frame.bytes.length);
              stream.push(frame.bytes);
              socket.send(ackFrame(received));
            }
          }
        } catch (error) {
          if (!settled) refuse(describeError(error));
          else stream.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
  }
}

/** One frame the relay sent, as its tag and what it carries. */
interface RelayFrame {
  readonly tag: number;
  readonly bytes: Buffer;
}

/** Every frame in one relay message, in order. */
function framesOf(message: Buffer): RelayFrame[] {
  const frames: RelayFrame[] = [];
  let at = 0;
  while (at < message.length) {
    const tag = message.readUInt16BE(at);
    at += 2;
    switch (tag) {
      case TAG_CONNECT_SUCCESS_SID:
      case TAG_DATA: {
        const length = message.readUInt32BE(at);
        at += 4;
        frames.push({ tag, bytes: message.subarray(at, at + length) });
        at += length;
        break;
      }
      case TAG_RECONNECT_SUCCESS_ACK:
      case TAG_ACK:
        // How much of what Cloudgate sent IAP has taken: Cloudgate never
        // reconnects a tunnel, so it keeps no copy to send again.
        frames.push({ tag, bytes: message.subarray(at, at + 8) });
        at += 8;
        break;
      default:
        throw new Error(`IAP sent a frame Cloudgate does not know (${tag})`);
    }
  }
  return frames;
}

function dataFrame(bytes: Buffer): Buffer {
  const frame = Buffer.alloc(6 + bytes.length);
  frame.writeUInt16BE(TAG_DATA, 0);
  frame.writeUInt32BE(bytes.length, 2);
  bytes.copy(frame, 6);
  return frame;
}

/** Acknowledges every byte received so far, so IAP keeps sending. */
function ackFrame(received: bigint): Buffer {
  const frame = Buffer.alloc(10);
  frame.writeUInt16BE(TAG_ACK, 0);
  frame.writeBigUInt64BE(received, 2);
  return frame;
}
