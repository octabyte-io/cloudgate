/**
 * The part of `tofu show -json <planfile>` the plan reader reads (OpenTofu's
 * JSON output format, `format_version` 1.2 in the moto trial). Everything else
 * the command prints is ignored rather than typed, so a newer OpenTofu adding
 * keys changes nothing here.
 *
 * Values are `unknown` on purpose: they are whatever the AWS provider's schema
 * says, and the reader only compares and renders them. `before_sensitive`,
 * `after_sensitive` and `after_unknown` are *masks*: `true` where the value at
 * that place is sensitive (or not known until apply), or an object/array of
 * the same shape as the value with `true` at the places that are. OpenTofu
 * prints sensitive values in clear in this output — the masks are the only
 * thing between an SSM value and the plan view.
 */
export interface TofuShowJson {
  readonly format_version?: string;
  readonly terraform_version?: string;
  /** What the plan will do: each resource compared with the refreshed state. */
  readonly resource_changes?: readonly TofuResourceChange[];
  /**
   * What the refresh found changed since the last apply. Noisy: the
   * moto trial marked every untouched resource (`tags: null → {}`, computed
   * values that moved), so it is only ever read through `resource_changes`.
   */
  readonly resource_drift?: readonly TofuResourceChange[];
  /** The state as refreshed before planning. */
  readonly prior_state?: TofuState;
  readonly planned_values?: { readonly root_module?: TofuModule };
}

export type TofuAction =
  'no-op' | 'create' | 'read' | 'update' | 'delete' | 'forget';

export interface TofuResourceChange {
  readonly address: string;
  readonly mode?: 'managed' | 'data';
  readonly type: string;
  readonly name: string;
  /** Set when this entry is a deposed object rather than the current one. */
  readonly deposed?: string;
  /** e.g. `replace_because_cannot_update`, `delete_because_no_resource_config`. */
  readonly action_reason?: string;
  readonly change: TofuChange;
}

export interface TofuChange {
  readonly actions: readonly TofuAction[];
  readonly before?: unknown;
  readonly after?: unknown;
  readonly after_unknown?: unknown;
  readonly before_sensitive?: unknown;
  readonly after_sensitive?: unknown;
  /** Paths (attribute names and list indexes) whose change forces the replace. */
  readonly replace_paths?: readonly (readonly (string | number)[])[];
  /** Present when the plan imports this resource (an `import` block). */
  readonly importing?: { readonly id?: string };
}

export interface TofuState {
  readonly values?: { readonly root_module?: TofuModule };
}

export interface TofuModule {
  readonly resources?: readonly TofuStateResource[];
  readonly child_modules?: readonly TofuModule[];
}

export interface TofuStateResource {
  readonly address: string;
  readonly mode?: 'managed' | 'data';
  readonly type: string;
  readonly name: string;
  readonly values?: Readonly<Record<string, unknown>>;
}
