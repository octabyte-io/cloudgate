import { isMap, isScalar, Pair, parseDocument, Scalar, YAMLMap } from 'yaml';
import type { Node } from 'yaml';

/**
 * Whole `services:` entries moved between config texts as YAML, comments and
 * quoting kept, rather than re-emitted from a parsed config: the text is the
 * operator's (ADR-0029), and an entry added to it should read as written.
 *
 * Two callers: a Template's setup, which adds its renamed entries to a
 * Cloudgate-kept text, and a plan of the stored text, which carries the open
 * plan's template entries forward (ADR-0065, amended).
 */

/** A text's `services:` entries, by Config name, as YAML nodes. */
export function serviceEntries(text: string): Map<string, Node> {
  const doc = parseDocument(text);
  const services = doc.get('services', true);
  const entries = new Map<string, Node>();
  if (!isMap(services)) return entries;
  for (const pair of services.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : null;
    if (key !== null && pair.value) entries.set(key, pair.value as Node);
  }
  return entries;
}

/**
 * `text` with `entries` added at the end of its `services:`, in their order.
 * An entry whose name `text` already lists is left as `text` has it. An empty
 * flow map (`services: {}`, as a new Project's text starts) becomes a block
 * map, so the added entries read as the rest of the file does.
 */
export function withServiceEntries(
  text: string,
  entries: ReadonlyMap<string, Node>,
): string {
  if (entries.size === 0) return text;
  const doc = parseDocument(text);
  let services = doc.get('services', true);
  if (!isMap(services)) {
    services = new YAMLMap();
    doc.set('services', services);
  }
  const map = services as YAMLMap;
  if (map.items.length === 0) map.flow = false;
  const listed = new Set(
    map.items.flatMap((pair) =>
      isScalar(pair.key) ? [String(pair.key.value)] : [],
    ),
  );
  for (const [name, node] of entries) {
    if (listed.has(name)) continue;
    map.items.push(new Pair(new Scalar(name), node.clone()));
  }
  return doc.toString();
}
