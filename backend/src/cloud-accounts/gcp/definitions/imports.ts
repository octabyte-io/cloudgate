import type { AdoptLine } from '../../aws/plan-reader/read-plan';
import type { TofuDefinition } from '../../definitions/tofu-json';

/**
 * The definition with an `import` block for each thing a Google plan adopts
 * by name, as AWS's `withImports` does for what a tag search
 * found: the Apply takes it into the state rather than making it twice. Each
 * imports by the id the port's search by name answered, Google's own full
 * name for it, which the Google provider takes as its import id.
 */
export function withGoogleImports(
  definition: TofuDefinition,
  adopt: readonly Omit<AdoptLine, 'line'>[],
): TofuDefinition {
  if (adopt.length === 0) return definition;
  return {
    ...definition,
    import: adopt.map((line) => ({ to: line.address, id: line.arn })),
  };
}
