/**
 * **Everything a licence unlocks, once.**
 *
 * The License screen used to list four features — custom roles, single sign-on,
 * SCIM and forward auth — in a hand-written array, and the same four were typed
 * again into the release and check-key warnings. Meanwhile Branding and the two
 * Instance limits were gated by the same `LicenseGate` / `LicenseLocked`, so an
 * operator deciding whether to activate a licence was shown four of seven.
 *
 * So the list is this registry, and **every gate names its entry**: `LicenseGate`
 * and `LicenseLocked` both take a `feature` id typed against it, so a new gate
 * cannot be written without one. `licensed-features.test.ts` is the other half
 * — a census that every entry here is read by at least one gate, and every gate
 * in the tree names one — so the list and the gates cannot drift apart.
 *
 * The audit log is **not** here, deliberately: `audit-log.controller.ts` records
 * that the trail carries no licence gate, so it is readable either way. Listing
 * it would be selling something the reader already has.
 */
export type LicensedFeature = {
  /** How the License screen's list names it, sentence case. */
  label: string;
  /** The same thing mid-sentence: "…custom roles, single sign-on and …". */
  inline: string;
  /** What it gives you, finishing "<label> — …". */
  what: string;
  /**
   * Whether it reaches the whole instance rather than one Organization. On the
   * Hosted instance these are Octabyte's, never sold, and simply on (ADR-0048);
   * the rest — the paid features — come with Enterprise there.
   */
  instanceWide: boolean;
};

export const LICENSED_FEATURES = {
  customRoles: {
    label: "Custom roles",
    inline: "custom roles",
    what: "roles you define, with grants drawn from the same permission table the guards check.",
    instanceWide: false,
  },
  sso: {
    label: "Single sign-on",
    inline: "single sign-on",
    what: "OIDC providers your members sign in through, and the option to require it.",
    instanceWide: false,
  },
  scim: {
    label: "SCIM",
    inline: "SCIM",
    what: "letting your identity provider create and deactivate members for you.",
    instanceWide: false,
  },
  forwardAuth: {
    label: "Forward auth",
    inline: "forward auth",
    what: "an authentication proxy in front of a deployed Application's own domain.",
    instanceWide: false,
  },
  manyOrganizations: {
    label: "More than one Organization",
    inline: "more than one Organization",
    what: "a second Organization and more on this instance, each with its own members, roles and audit log.",
    instanceWide: true,
  },
  branding: {
    label: "Branding",
    inline: "branding",
    what: "your own name, logo, favicon and colors on this instance, and your own words on its error pages.",
    instanceWide: true,
  },
  concurrentBuilds: {
    label: "Concurrent builds",
    inline: "concurrent builds",
    what: "building more than one Deployment at a time on this host.",
    instanceWide: true,
  },
  concurrentCloudRuns: {
    label: "Concurrent Cloud runs",
    inline: "concurrent Cloud runs",
    what: "running more than one Cloud run at a time on this host.",
    instanceWide: true,
  },
} as const satisfies Record<string, LicensedFeature>;

export type LicensedFeatureId = keyof typeof LICENSED_FEATURES;

/** The registry in its declared order, for the License screen's list. */
export const LICENSED_FEATURE_LIST: readonly (LicensedFeature & {
  id: LicensedFeatureId;
})[] = (Object.keys(LICENSED_FEATURES) as LicensedFeatureId[]).map((id) => ({
  id,
  ...LICENSED_FEATURES[id],
}));

/**
 * Every licensed feature in one phrase, for a sentence that names them all:
 * "custom roles, single sign-on, … and concurrent Cloud runs". Built from the
 * registry so the release and check-key warnings name what the list names.
 */
export function licensedFeaturesInline(): string {
  return inlineList(LICENSED_FEATURE_LIST.map((feature) => feature.inline));
}

/** "a", "a and b", "a, b and c": feature names joined as a sentence lists them. */
export function inlineList(words: readonly string[]): string {
  return words.length < 2
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
