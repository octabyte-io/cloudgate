/**
 * "2 services" / "1 service".
 *
 * Spelled out rather than `${n} services`, which is F09's "repositorys" defect
 * in its other form — and it rendered **"1 services"** on a real screen here
 * before this existed, on the single-container suggestion.
 */
export function serviceCount(file: string): string {
  const count = countServices(file);
  return count === 1 ? "1 service" : `${count} services`;
}

/**
 * How many services the file declares.
 *
 * Deliberately a count of top-level keys under `services:` by indentation rather
 * than a YAML parse: this is a line on a pick card, and pulling CodeMirror's
 * parser in to produce it would download an editor to render a number.
 */
function countServices(file: string): number {
  const lines = file.split("\n");
  const start = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (start === -1) return 0;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^\s{2}\S[^:]*:\s*$/.test(line)) count += 1;
  }
  return count;
}
