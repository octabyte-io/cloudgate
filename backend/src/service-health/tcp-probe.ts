import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { classifyProbeError } from './http-probe';
import type { ProbeOutcome } from './http-probe';

/**
 * One TCP Probe: a connect to `host:port`, up when the handshake
 * completes and down otherwise — refused, unreachable, or no answer within
 * the timeout. Nothing is written and nothing read: an open socket is the
 * whole claim, which is what a TCP check promises and all it promises.
 *
 * The error classes are the HTTP Probe's ({@link classifyProbeError}), so a
 * refused database port reads `refused` exactly as a refused Domain does.
 */
export function probeTcp(
  host: string,
  port: number,
  options: { timeoutMs: number },
): Promise<ProbeOutcome> {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const socket = net.connect({ host, port });
    const timer = setTimeout(
      () => finish({ verdict: 'down', latencyMs: null, errorClass: 'timeout' }),
      options.timeoutMs,
    );
    socket.once('connect', () =>
      finish({
        verdict: 'up',
        latencyMs: Math.round(performance.now() - started),
        errorClass: null,
      }),
    );
    socket.once('error', (error) =>
      finish({
        verdict: 'down',
        latencyMs: null,
        errorClass: classifyProbeError(error),
      }),
    );
  });
}
