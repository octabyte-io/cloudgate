/**
 * Plain aligned columns (CLI spec, Output conventions): each label padded to
 * the longest plus two spaces, no box, no colour, so output copies and greps
 * well. `paint` styles the label only, and only when the caller was told the
 * stream may be coloured.
 */
export function columns(
  rows: ReadonlyArray<readonly [label: string, value: string]>,
  paint: (label: string) => string = (label) => label,
): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `${paint(label.padEnd(width + 2))}${value}\n`)
    .join('');
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * When a key ends, as `whoami` says it: the UTC date, then how far off it is
 * — `2027-02-01 (in 90 days)`, or `never` for a key with no end. UTC rather
 * than local time, so the date printed is the date the server stores.
 */
export function describeKeyEnd(expiresAt: string | null, now: Date): string {
  if (!expiresAt) return 'never';
  const end = new Date(expiresAt);
  const date = end.toISOString().slice(0, 10);
  const left = end.getTime() - now.getTime();
  if (left <= 0) return `${date} (ended)`;
  // Rounded, so a key minted a moment ago for 90 days reads "in 90 days".
  const days = Math.round(left / DAY);
  if (days === 0) return `${date} (in less than a day)`;
  return `${date} (in ${days} ${days === 1 ? 'day' : 'days'})`;
}

const ANSI = {
  dim: ['\u001b[2m', '\u001b[22m'],
  bold: ['\u001b[1m', '\u001b[22m'],
};

/**
 * A size as `deploy` prints it — `3.1 MB` — in decimal units, as the spec's
 * "above 100 MB" and every package manager count them.
 */
export function describeSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** How long a Deployment took: `42s`, `1m 42s`. */
export function describeDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A styling function that is the identity when colour is off. */
export function style(
  enabled: boolean,
  which: keyof typeof ANSI,
): (text: string) => string {
  const [open, close] = ANSI[which];
  return enabled ? (text) => `${open}${text}${close}` : (text) => text;
}

/**
 * How long ago something happened, as `status` says it: `4 minutes ago`,
 * `3 hours ago`, `2 days ago`; `just now` under a minute (and for a clock a
 * little behind the server's).
 */
export function describeAgo(at: string, now: Date): string {
  const seconds = Math.floor((now.getTime() - new Date(at).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const [count, unit] =
    seconds < 3600
      ? [Math.floor(seconds / 60), 'minute']
      : seconds < DAY / 1000
        ? [Math.floor(seconds / 3600), 'hour']
        : [Math.floor(seconds / (DAY / 1000)), 'day'];
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
