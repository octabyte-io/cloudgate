import type { RuntimeLogLine } from './runtime-log';

/**
 * The Runtime log of a Service on a Server, the platform host or a Stack VM
 * (ADR-0070), read once: what `docker … logs --timestamps` printed for each of
 * its copies, merged by time, each line naming its copy.
 */

/**
 * One line `--timestamps` stamped: RFC 3339 with up to nanoseconds, a space,
 * then the rest. A line with no stamp is Docker's own, not the app's.
 */
const STAMPED =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) (.*)$/;

/**
 * What follows the stamp when `docker service logs --no-task-ids` keeps its
 * task prefix: `web.1@node-1    | <line>` (the console's `service-output-lines.ts`
 * reads the same shape).
 */
const TASK_PREFIXED = /^([^\s|@]+)@[^\s|]*\s+\| ?(.*)$/;

/**
 * The stamped lines of one copy's output, oldest first. `copy` names the copy
 * for a container's output; a Swarm service's lines name their own task in
 * their prefix (`taskPrefixed`), which wins.
 */
export function copyLinesOf(
  output: string,
  copy: string,
  taskPrefixed: boolean,
): RuntimeLogLine[] {
  const lines: RuntimeLogLine[] = [];
  for (const raw of output.split('\n')) {
    const stamped = STAMPED.exec(raw.replace(/\r$/, ''));
    if (!stamped) continue;
    const [, seconds, fraction = '', zone, rest] = stamped;
    const at = Date.parse(`${seconds}${fraction.slice(0, 4)}${zone}`);
    if (Number.isNaN(at)) continue;
    const prefixed = taskPrefixed ? TASK_PREFIXED.exec(rest) : null;
    const task = prefixed ? prefixed[1] : copy;
    lines.push({
      // The stamp to the nanosecond and the copy: the same line read twice
      // has the same id.
      id: `${task}@${seconds}${fraction}${zone}`,
      at,
      task,
      message: prefixed ? prefixed[2] : rest,
    });
  }
  return lines;
}

/**
 * Every copy's lines merged by time (stable, so lines a copy wrote in one
 * millisecond keep their order), only those after `since`, the last `count`.
 */
export function mergedWindow(
  copies: readonly RuntimeLogLine[][],
  count: number,
  since?: number,
): RuntimeLogLine[] {
  return copies
    .flat()
    .filter((line) => since === undefined || line.at >= since)
    .sort((a, b) => a.at - b.at)
    .slice(-count);
}

/** A window as one text: `<ISO time> [<copy>] <line>`, a line each. */
export function windowText(lines: readonly RuntimeLogLine[]): string {
  return lines
    .map(
      (line) =>
        `${new Date(line.at).toISOString()} [${line.task}] ${line.message.replace(/\r?\n$/, '')}\n`,
    )
    .join('');
}
