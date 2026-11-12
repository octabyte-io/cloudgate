/** One resource of a module in `tofu show -json`'s reading of a state. */
export interface ShownResource {
  mode?: string;
  type?: string;
  values?: Record<string, unknown> | null;
}

interface ShownModule {
  resources?: ShownResource[];
  child_modules?: ShownModule[];
}

/** `tofu show -json` of a state (not of a plan): only what a projection reads. */
export interface TofuStateShow {
  values?: { root_module?: ShownModule } | null;
}

/**
 * How one cloud turns what a state holds into what an operator may see of
 * it (ADR-0036 item 3): AWS's `aws/state-resources.ts`, Google's
 * `gcp/state-resources.ts`. The runner reads the state and hands it to the
 * projection its adapter names; only the projection leaves the runner.
 */
export type StateProjection<Resource> = (show: TofuStateShow) => Resource[];

/** Every managed resource of a state, its modules' included, with its type and values. */
export function managedResources(
  show: TofuStateShow,
): { type: string; values: Record<string, unknown> }[] {
  const found: { type: string; values: Record<string, unknown> }[] = [];
  const visit = (module: ShownModule | undefined) => {
    for (const resource of module?.resources ?? []) {
      if (resource.mode !== 'managed' || !resource.type) continue;
      found.push({ type: resource.type, values: resource.values ?? {} });
    }
    for (const child of module?.child_modules ?? []) visit(child);
  };
  visit(show.values?.root_module);
  return found;
}

/** A non-empty string value, else `null`. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A map's string entries, or `null` when it is not a map. */
export function stringsOf(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
