import { isMap, isScalar, isSeq } from 'yaml';
import type { Node } from 'yaml';

import { serviceEntries } from '../../project-config';

/**
 * A Template's `cloudgate.yaml` entries under their setup's Config names
 * (ADR-0065 "Names"): each entry renamed, and every link renamed with it, so
 * `ghost-app`'s `DATABASE_URL: db.url` reads `ghost-db.url`. Links are the
 * only place one entry names another (`linksFromWire`: an `env` item that is
 * a one-key map, `NAME: <service>.<output>`).
 */
export function renamedEntries(
  templateConfig: string,
  names: ReadonlyMap<string, string>,
): Map<string, Node> {
  const renamed = new Map<string, Node>();
  for (const [part, node] of serviceEntries(templateConfig)) {
    const copy = node.clone() as Node;
    renameLinks(copy, names);
    renamed.set(names.get(part) ?? part, copy);
  }
  return renamed;
}

function renameLinks(entry: Node, names: ReadonlyMap<string, string>): void {
  if (!isMap(entry)) return;
  const env = entry.get('env', true);
  if (!isSeq(env)) return;
  for (const item of env.items) {
    if (!isMap(item)) continue;
    for (const pair of item.items) {
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string') {
        continue;
      }
      const target = pair.value.value;
      const dot = target.lastIndexOf('.');
      const source = names.get(target.slice(0, dot));
      if (dot > 0 && source) {
        pair.value.value = `${source}${target.slice(dot)}`;
      }
    }
  }
}
