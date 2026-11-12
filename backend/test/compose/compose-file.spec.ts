import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * The compose file preparation `cloudgate template try` bundles from source
 * (spec #5): the pure pieces of `compose.utils.ts` and `publishStackVmPorts`.
 * The CLI cannot carry Traefik, the volume lock, a Docker client or Nest, so
 * nothing these modules load at runtime may reach one. A type-only import is
 * erased before anything loads and is not followed.
 */
const SRC = resolve(__dirname, '../../src');
const ENTRIES = ['compose/compose-file.ts', 'compose/stack-vm-ports.ts'];
const FORBIDDEN = /traefik|volume-lock|docker|@nestjs/i;

/** Every specifier a module loads at runtime, `import type` left out. */
function runtimeSpecifiers(text: string): string[] {
  const found: string[] = [];
  const statement =
    /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?'([^']+)'/gm;
  for (const match of text.matchAll(statement)) found.push(match[1]);
  return found;
}

/** Every module reached from `entries`, and every package it names. */
function reached(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const loads: string[] = [];
  const queue = entries.map((entry) => resolve(SRC, entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    loads.push(relative(SRC, file));
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        loads.push(specifier);
        continue;
      }
      const base = resolve(dirname(file), specifier);
      const next = [`${base}.ts`, resolve(base, 'index.ts')].find(existsSync);
      if (next) queue.push(next);
    }
  }
  return loads;
}

describe('compose-file.ts', () => {
  it('imports nothing from Traefik, the volume lock, Docker or Nest', () => {
    expect(reached(ENTRIES).filter((load) => FORBIDDEN.test(load))).toEqual([]);
  });

  it('follows a runtime import to what it loads', () => {
    // The walk itself, held to a module known to reach Traefik, so an empty
    // list above is the modules' answer and not a walk that found nothing.
    expect(
      reached(['compose/compose.utils.ts']).filter((load) =>
        FORBIDDEN.test(load),
      ),
    ).toContain('traefik/traefik-writer.service.ts');
  });
});
