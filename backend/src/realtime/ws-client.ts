/**
 * The slice of a `ws` WebSocket the gateways touch. Kept structural so tests
 * drive handlers with a plain EventEmitter double instead of a real socket.
 */
export interface WsClient {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
  ping(): void;
  /**
   * Drop the connection without a close handshake.
   *
   * Here because a peer that has stopped answering pings is by definition unable
   * to complete one, so `close()` would wait for a reply that is never coming
   * and leave the socket `OPEN` — which is the whole defect the keep-alive
   * exists to end. `ws` exposes it; nothing in this module could reach it until
   * this slice named it.
   */
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
  /** The answer to a keep-alive ping — the only signal that the peer is still
   *  there when no close frame ever arrives. */
  on(event: 'pong', listener: () => void): void;
}
