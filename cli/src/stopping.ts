import type { Interrupts } from './command.js';

/**
 * How often a command that waits on an Instance asks it again: a
 * Deployment's status, a build in the way of an upload, a Cloud account's
 * Runtime log.
 */
export const POLL_MILLISECONDS = 2000;

/** Settles once `signal` aborts (at once if it already has), for a `Promise.race`. */
export function abortOf(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Runs `work` with a signal Ctrl-C aborts, for as long as it runs; after
 * that, Ctrl-C is the run's own again.
 */
export async function withInterrupts<T>(
  interrupts: Interrupts,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  const unlisten = interrupts.listen(() => stop.abort());
  try {
    return await work(stop.signal);
  } finally {
    unlisten();
  }
}
