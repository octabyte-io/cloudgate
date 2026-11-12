/**
 * A bidirectional byte stream backing one WebSocket connection: an SSH exec
 * channel or shell, a local pty, or a local child process. Gateways only see
 * this interface; the concrete transports live in the channel services so
 * tests can drive handlers with doubles.
 */
export interface StreamChannel {
  write(data: string): void;
  /**
   * Tell the remote its window changed, where the transport has one. A pty knows
   * its size and the programs inside it are told through SIGWINCH; a plain child
   * process has no terminal to resize, so it does not implement this. See
   * `terminal-protocol.ts` for how a resize gets here from a browser.
   */
  resize?(cols: number, rows: number): void;
  /** Tear the transport down (kill the pty/process, end the SSH connection). */
  close(): void;
  onData(listener: (chunk: string) => void): void;
  /** Distinct stderr where the transport has one (SSH, child process). */
  onStderr(listener: (chunk: string) => void): void;
  onClose(listener: (code?: number) => void): void;
  /** Transport-level failures after the channel opened (e.g. SSH drop). */
  onError(listener: (err: Error) => void): void;
}
