import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * The compose file preparation `cloudgate template try` bundles from source
 * (spec #5): the pure pieces of `compose.utils.ts` and `publishStackVmPorts`,
 * reached through the CLI's bundle entry, `templates/setup/cli-bundle.ts`.
 * The CLI cannot carry Traefik, the volume lock or a Docker client, so
 * nothing the bundle entry loads at runtime may reach one; and the two
 * compose modules load no Nest either. A type-only import is erased before
 * anything loads and is not followed.
 *
 * The bundle entry as a whole may reach Nest and `nestjs-zod`: the Template
 * check it shares does (ADR-0046), and `setupDomains` reads `hostSchema`
 * from `domains/dto/domain.dto.ts`. So the no-Nest rule is held only to the
 * two compose modules.
 */
const SRC = resolve(__dirname, '../../src');
const CLI = resolve(__dirname, '../../../cli');
const COMPOSE_MODULES = [
  'compose/compose-file.ts',
  'compose/stack-vm-ports.ts',
];
const NO_NEST = /traefik|volume-lock|docker|@nestjs/i;

/**
 * What the CLI cannot carry, by where it lives in `src` or the package it
 * is: Traefik, the volume lock, and a Docker client. Narrower than
 * {@link NO_NEST}: the bundle entry reaches `native/docker-native.ts`, the
 * pure `native.docker` rules the Template check reads, which is no client.
 */
const NOT_IN_THE_CLI = [
  /^traefik\//,
  /^deployment-engine\/volume-lock\.ts$/,
  /^docker\//,
  /^docker-ops\//,
  /^dockerode$/,
];
const notInTheCli = (load: string) =>
  NOT_IN_THE_CLI.some((rule) => rule.test(load));

/**
 * The module the CLI bundles as `cloudgate-template-setup`, read from
 * `cli/build.mjs` and `cli/vitest.config.ts` themselves rather than written
 * here, so the walk follows whatever the CLI really bundles.
 */
function cliBundleEntries(): string[] {
  const entries = [
    [
      'build.mjs',
      /'cloudgate-template-setup':\s*fileURLToPath\(\s*new URL\('\.\.\/backend\/src\/([^']+)'/,
    ],
    [
      'vitest.config.ts',
      /'cloudgate-template-setup':\s*backend\('src\/([^']+)'\)/,
    ],
  ] as const;
  return entries.map(([file, alias]) => {
    const found = alias.exec(readFileSync(resolve(CLI, file), 'utf8'));
    if (!found)
      throw new Error(`cli/${file} aliases no cloudgate-template-setup`);
    return found[1];
  });
}

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

describe('backend/src/compose/compose-file.ts', () => {
  it('imports nothing from Traefik, the volume lock, Docker or Nest, nor does stack-vm-ports.ts', () => {
    expect(
      reached(COMPOSE_MODULES).filter((load) => NO_NEST.test(load)),
    ).toEqual([]);
  });

  it('is bundled into the CLI through cli-bundle.ts, as are the compose module and the setup values', () => {
    const [built, tested] = cliBundleEntries();
    expect(tested).toBe(built);
    expect(reached([built])).toEqual(
      expect.arrayContaining([
        ...COMPOSE_MODULES,
        'templates/setup/setup-values.ts',
        'templates/setup/compose-env-inputs.ts',
      ]),
    );
  });

  it('reaches nothing from Traefik, the volume lock or a Docker client from the CLI bundle entry', () => {
    expect(reached(cliBundleEntries()).filter(notInTheCli)).toEqual([]);
  });

  it('follows a runtime import to what it loads', () => {
    // The walk and both rules, held to a module known to reach Traefik, the
    // volume lock and a Docker client, so an empty list above is the
    // modules' answer and not a walk that found nothing.
    const fromUtils = reached(['compose/compose.utils.ts']);
    expect(fromUtils.filter((load) => NO_NEST.test(load))).toContain(
      'traefik/traefik-writer.service.ts',
    );
    expect(fromUtils.filter(notInTheCli)).toEqual(
      expect.arrayContaining([
        'traefik/traefik-writer.service.ts',
        'deployment-engine/volume-lock.ts',
      ]),
    );
  });
});
