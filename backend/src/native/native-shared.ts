/**
 * **What every target's native block shares**: the
 * refusal, the check, a plan's native line, a definition's resources, the
 * meta-arguments every cloud refuses and the console's refusal sentence.
 * Each was written first beside the target that needed it (`docker-native.ts`,
 * `aws-native.ts`, `aws-lay.ts`, `aws-locks.ts`, `aws-console-owned.ts`) and
 * is read by all of them, so it lives here, named for no target.
 */

/** One refusal of a native block: the full path in file spelling, and why. */
export interface NativeRefusal {
  readonly at: string;
  readonly message: string;
}

/** What a check of one entry's native block says: refusals stop the plan, warnings do not. */
export interface NativeCheck {
  readonly refusals: NativeRefusal[];
  readonly warnings: NativeRefusal[];
}

/**
 * One native change, as the Service's `change` step lists it: the path in
 * the file's spelling, old → new, marked native. `fromDefault` / `toDefault`
 * say a side is the kind's default rather than a written value, which the
 * plan shows as `default (none)` or `default (<value>)`.
 */
export interface NativeFieldDiff {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly native: true;
  readonly fromDefault?: true;
  readonly toDefault?: true;
  /**
   * A side that is the console's value of a setting it owned before native
   * shown as `console (<value>)`: where no native value is, the
   * console's stands, and a key taken out hands it back there.
   */
  readonly fromConsole?: true;
  readonly toConsole?: true;
  /**
   * A side that is the entry's `size`'s value of a size-bearing argument
   * native sets none of, shown as `size (<value>)`.
   */
  readonly fromSize?: true;
  readonly toSize?: true;
}

/** A definition's `resource` object: bodies by type, then by local name. */
export type ResourceBlocks = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** Every OpenTofu meta-argument, refused on every address (ADR-0044 rule 4). */
export const NATIVE_META_ARGUMENTS: Readonly<Record<string, string>> = {
  lifecycle:
    "lifecycle is an instruction to OpenTofu, not a setting of the resource; ignore_changes would let a hand change live with no file showing it, and Cloudgate's own lifecycle stays",
  depends_on:
    'depends_on is an instruction to OpenTofu, not a setting of the resource',
  count:
    'count would make a resource of its own; native adds settings, never resources',
  for_each:
    'for_each would make resources of its own; native adds settings, never resources',
  provider:
    "provider is an instruction to OpenTofu; the provider is Cloudgate's",
  provisioner:
    'provisioner is an instruction to OpenTofu, not a setting of the resource',
  connection:
    'connection is an instruction to OpenTofu, not a setting of the resource',
};

/**
 * The cloud Database page's refusal on every cloud: one
 * clause per console setting a native path sets, or `null` when none does.
 */
export function consoleRefusalSentence(
  name: string,
  set: readonly (readonly [setting: string, path: string | null])[],
): string | null {
  const clauses = set.flatMap(([setting, path]) =>
    path ? [`${setting} is set by ${name}.${path}`] : [],
  );
  if (clauses.length === 0) return null;
  return `${clauses.join('; ')} in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page`;
}
