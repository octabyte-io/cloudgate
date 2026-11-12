import type { RuntimeLogRead } from 'api-schemas';

import type { SocketOpener } from './deployment-log-stream.js';
import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import { abortOf, POLL_MILLISECONDS } from './stopping.js';

/**
 * A Service's Runtime log (CONTEXT.md "Runtime log"), read the two
 * ways an Instance offers it (ADR-0035): over the container-logs socket for a
 * Service on a Server, and over REST for one in a Cloud account. Both end the
 * same way to `logs`: the last `lines` lines on `onText`, then, with `follow`,
 * every new line until `signal` (Ctrl-C).
 */

/** How a read ended: by itself, or with Ctrl-C. */
export type RuntimeLogEnd = 'ended' | 'interrupted';

/**
 * The close code `/docker-container-logs` ends with when the output it
 * follows ends (`CONTAINER_LOGS_CLOSE.outputEnded` in the backend): the
 * normal end of an unfollowed read, and a stopped Service's end of a followed
 * one. Any other code is a refusal or a failure.
 */
export const OUTPUT_ENDED_CLOSE_CODE = 4014;

/** The last `count` lines of `text`, each ending in a newline. */
export function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines
    .slice(-count)
    .map((line) => `${line}\n`)
    .join('');
}

/**
 * A pty's `\r\n` as `\n`, across chunks: a `\r` ending one chunk is held
 * until the next says whether a `\n` follows it.
 */
function lineEndings(): (chunk: string) => string {
  let held = '';
  return (chunk) => {
    const text = (held + chunk).replace(/\r\n/g, '\n');
    held = text.endsWith('\r') ? '\r' : '';
    return held ? text.slice(0, -1) : text;
  };
}

/**
 * A Server's Runtime log (or the platform host's, with no `serverId`): its
 * Swarm service's `docker service logs`, as `/docker-container-logs` streams
 * it. Without `follow` the Instance is asked not to follow (`follow=false`),
 * so the socket ends after the backlog; the backlog is then cut to `lines`,
 * since Swarm's `--tail` counts per task.
 */
export function readServerRuntimeLog(input: {
  open: SocketOpener;
  /** `ws(s)://` origin of the API. */
  websocket: string;
  headers: Record<string, string>;
  appName: string;
  serverId: string | null;
  lines: number;
  follow: boolean;
  onText: (text: string) => void;
  signal: AbortSignal;
}): Promise<RuntimeLogEnd> {
  const query = new URLSearchParams({
    containerId: input.appName,
    runType: 'swarm',
    tail: String(input.lines),
    since: 'all',
    ...(input.serverId ? { serverId: input.serverId } : {}),
    ...(input.follow ? {} : { follow: 'false' }),
  });
  const socket = input.open(
    `${input.websocket}/docker-container-logs?${query.toString()}`,
    input.headers,
  );
  const decoder = new TextDecoder();
  const normalize = lineEndings();
  let backlog = '';
  return new Promise<RuntimeLogEnd>((resolve, reject) => {
    const onAbort = () => {
      socket.close();
      resolve('interrupted');
    };
    if (input.signal.aborted) return onAbort();
    input.signal.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('message', ({ data }) => {
      const chunk =
        typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
            ? decoder.decode(data)
            : '';
      const text = normalize(chunk);
      if (input.follow) input.onText(text);
      else backlog += text;
    });
    socket.addEventListener('close', ({ code, reason }) => {
      input.signal.removeEventListener('abort', onAbort);
      if (input.signal.aborted) return;
      if (code !== OUTPUT_ENDED_CLOSE_CODE) {
        reject(
          new CliError(
            `the Runtime log stream closed${reason ? `: ${reason}` : ` (code ${code})`}`,
            EXIT.failed,
          ),
        );
        return;
      }
      if (!input.follow) input.onText(lastLines(backlog, input.lines));
      resolve('ended');
    });
    // An error is followed by a close, which says what happened.
    socket.addEventListener('error', () => {});
  });
}

/**
 * The `since` that asks a Cloud account's Runtime log for as far back as the
 * Instance reads one: it starts no read further back than its lookback (an
 * hour), so the epoch is taken as that hour.
 */
const FURTHEST_BACK = 0;

/**
 * A Cloud account's Runtime log, read over `GET /applications/:id/runtime-log`:
 * its first read is the last few minutes (the Instance's window), read on
 * while lines were left; holding fewer than `lines`, it is read again from as
 * far back as the Instance reads (the last hour), and cut to `lines`. With
 * `follow`, read again every `pollMilliseconds` from where the last read left
 * off. Reads overlap by a few seconds, so a line already printed (by its
 * `id`) is not printed again.
 */
export async function readCloudRuntimeLog(input: {
  read: (since?: number) => Promise<RuntimeLogRead>;
  lines: number;
  follow: boolean;
  onText: (text: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  signal: AbortSignal;
  pollMilliseconds?: number;
}): Promise<RuntimeLogEnd> {
  const pollMilliseconds = input.pollMilliseconds ?? POLL_MILLISECONDS;
  const shown = (line: RuntimeLogRead['lines'][number]) =>
    `${new Date(line.at).toISOString()} ${line.message.replace(/\r?\n$/, '')}\n`;
  let seen = new Set<string>();
  const fresh = (answer: RuntimeLogRead) => {
    const lines = answer.lines.filter((line) => !seen.has(line.id));
    seen = new Set([...seen, ...answer.lines.map((line) => line.id)]);
    return lines;
  };

  const aborted = abortOf(input.signal);
  /** Every line from `since` on, reading on while lines were left. */
  const readFrom = async (since?: number) => {
    seen = new Set();
    let last = await input.read(since);
    const lines = fresh(last);
    while (last.more && !input.signal.aborted) {
      last = await input.read(last.next);
      lines.push(...fresh(last));
    }
    return { lines, last };
  };
  let backlog = await readFrom();
  if (backlog.lines.length < input.lines && !input.signal.aborted) {
    backlog = await readFrom(FURTHEST_BACK);
  }
  if (input.signal.aborted) return 'interrupted';
  input.onText(backlog.lines.slice(-input.lines).map(shown).join(''));
  let answer = backlog.last;
  if (!input.follow) return 'ended';

  for (;;) {
    if (!answer.more) {
      await Promise.race([input.sleep(pollMilliseconds), aborted]);
    }
    if (input.signal.aborted) return 'interrupted';
    answer = await input.read(answer.next);
    if (input.signal.aborted) return 'interrupted';
    const lines = answer.lines.filter((line) => !seen.has(line.id));
    // Only the last read's lines can come again: each read starts at most a
    // few seconds before the one before it ended.
    seen = new Set(answer.lines.map((line) => line.id));
    if (lines.length > 0) input.onText(lines.map(shown).join(''));
  }
}
