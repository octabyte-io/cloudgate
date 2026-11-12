import type { DeploymentLog } from './deployment-watch.js';

/**
 * The part of a WebSocket the CLI uses, so a whole run can be driven with a
 * double (the unit lane) and with Node's own `WebSocket` (the process).
 */
export interface SocketLike {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: () => void): void;
  close(): void;
}

/** Opens a socket to `url` sending `headers` on the upgrade request. */
export type SocketOpener = (
  url: string,
  headers: Record<string, string>,
) => SocketLike;

/**
 * Node's own `WebSocket` (undici, global from Node 22), which — unlike a
 * browser's — takes upgrade headers, so the key travels as `x-api-key` the
 * way every REST request sends it, never in the URL.
 */
export const openWebSocket: SocketOpener = (url, headers) => {
  const socket = new WebSocket(url, { headers });
  socket.binaryType = 'arraybuffer';
  return socket;
};

/**
 * Follows a Deployment log over `/listen-deployment` on the API's own origin
 * (`endpoints.websocket`, `instanceEndpoints`): every frame is a chunk of the
 * log file as `tail -f` printed it. The stream never ends by itself when the
 * Deployment does; `watchDeployment` decides when to stop. Also what
 * `logs --deployment -f` follows.
 */
export function deploymentLogFollower(input: {
  open: SocketOpener;
  /** `ws(s)://` origin of the API. */
  websocket: string;
  deploymentId: string;
  headers: Record<string, string>;
}): (onText: (text: string) => void) => DeploymentLog {
  return (onText) => {
    const url = `${input.websocket}/listen-deployment?deploymentId=${encodeURIComponent(input.deploymentId)}`;
    const socket = input.open(url, input.headers);
    const decoder = new TextDecoder();
    let ended!: () => void;
    const closed = new Promise<void>((resolve) => (ended = resolve));
    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') onText(data);
      else if (data instanceof ArrayBuffer) onText(decoder.decode(data));
    });
    socket.addEventListener('close', () => ended());
    // An error is followed by a close; nothing to print, the status decides.
    socket.addEventListener('error', () => ended());
    return {
      closed,
      close: () => {
        socket.close();
        ended();
      },
    };
  };
}
