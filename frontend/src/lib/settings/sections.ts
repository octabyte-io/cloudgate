import type { IconName } from "@/lib/design/icons";

/**
 * **The sections of `/settings`, as one table.**
 *
 * F07 laid down `/settings` as a single placeholder page and handed its sections
 * to F15, F16 and F18. Three phases writing into one route needs the same seam
 * the tab registry gives the seven resource scopes: **one line here plus the
 * route file it names**, and the strip, the index page and the document titles
 * all follow. Nothing else in the app is edited to add a settings screen.
 *
 * It is deliberately *not* the tab registry. A scope's tabs are panels of one
 * fetched resource, lazily loaded and handed `{ id, kind }`; a settings section
 * is a plain route with its own page. Reusing `TAB_REGISTRY` here would have
 * meant giving every entry an id it does not have.
 *
 * Order is the order they appear, and F16 set it by **audience**, widening
 * outwards: you, then the Organization you are in, then what it points at, then
 * the machine all of it runs on. Integrations sit together because that is what
 * a person is doing when they are in any one of them: pointing Cloudgate at
 * something outside itself. Platform sits last because it is the only group
 * whose controls affect everybody using this instance.
 *
 * **Account is in here despite not being the Organization's**, which is why the
 * index page and the strip are titled "Settings" rather than "Organization
 * settings" now. The alternative was a second settings surface for one section,
 * and the phase brief's reasoning holds: three audiences, one navigation.
 */

export type SettingsSection = {
  /** The path segment, and the last part of the href. */
  slug: string;
  /** The strip's label and the page's `<h1>`. Sentence case. */
  label: string;
  icon: IconName;
  /** One sentence. Used on the index page and as the page's lede. */
  lede: string;
  /** A quiet heading over the run of sections that starts here. */
  groupLabel?: string;
  /**
   * Listed only for an Operator on the Hosted instance (ADR-0050): everybody
   * else, and every Self-hosted instance, has no such page.
   */
  operatorOnly?: boolean;
  /**
   * A page of the **platform host** — the box this Instance runs on — or of
   * the Instance as a whole. Listed for everybody on a Self-hosted instance;
   * on the Hosted instance, where that box is Octabyte's and the backend
   * refuses every customer, only for an Operator (ADR-0053).
   */
  instanceOnly?: boolean;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  // F16 — the person.
  {
    slug: "account",
    label: "Account",
    icon: "user",
    lede: "Your name, your password, two-factor, your sessions and your personal keys.",
    groupLabel: "You",
  },
  // F16 — the Organization.
  {
    slug: "members",
    label: "Members",
    icon: "users",
    lede: "Who is in this Organization, what their role lets them do, and who has been invited.",
    groupLabel: "Organization",
  },
  // Agents — next to Members, because an Agent is one; its own section because
  // it is not a person, and the Members card points here.
  {
    slug: "agents",
    label: "Agents",
    icon: "cpu",
    lede: "The coding agents that act on this Organization through the MCP endpoint, each with its own key, role and access.",
  },
  {
    slug: "organizations",
    label: "Organizations",
    icon: "building",
    lede: "The Organizations you belong to, and which one you land in.",
  },
  {
    slug: "certificates",
    label: "Certificates",
    icon: "shield",
    lede: "TLS material you bring yourself, for hosts Let's Encrypt cannot issue for.",
  },
  // F18 — the Organization's subscription. In this group and not its own,
  // because a subscription is a property of the tenant in exactly the way its
  // members and its certificates are.
  {
    slug: "billing",
    label: "Billing",
    icon: "cash",
    lede: "The plan this Organization is on, what it allows, and the invoices for it.",
  },
  // F15 — the outward connections.
  {
    slug: "git-providers",
    label: "Git providers",
    icon: "branch",
    lede: "The accounts Cloudgate clones from, and what each one can reach.",
    groupLabel: "Integrations",
  },
  {
    slug: "registries",
    label: "Registries",
    icon: "box",
    lede: "Where a build pushes its image, and which credentials pull it back.",
  },
  // Cloud accounts — an AWS account Cloudgate deploys into, beside the other
  // things an Organization points Cloudgate at.
  {
    slug: "cloud-accounts",
    label: "Cloud accounts",
    icon: "cloud",
    lede: "The AWS and Google Cloud accounts Cloudgate deploys into, and whether each one's access still passes its check.",
  },
  {
    slug: "destinations",
    label: "Destinations",
    icon: "hdd",
    lede: "The S3-compatible buckets backups are written to.",
  },
  {
    slug: "notifications",
    label: "Notifications",
    icon: "mail",
    lede: "Where Cloudgate tells you a deploy failed, or a backup did.",
  },
  {
    slug: "ai",
    label: "AI",
    icon: "spark",
    lede: "The model that drafts a stack for you and reads your build logs.",
  },
  // F16 — the instance itself. Three sections rather than one page, because the
  // settings controller's 48 routes are three unrelated jobs: editing Traefik's
  // files, changing what this deployment *is*, and reclaiming disk. Somebody
  // pruning images should not have to scroll past the control that restarts the
  // console.
  {
    slug: "traefik",
    label: "Traefik",
    icon: "route",
    lede: "The ingress every request arrives through: its files, its environment and its ports.",
    groupLabel: "Platform",
    instanceOnly: true,
  },
  {
    slug: "instance",
    label: "Instance",
    icon: "server",
    lede: "This deployment of Cloudgate — its version, its address and its health.",
    instanceOnly: true,
  },
  {
    slug: "maintenance",
    label: "Maintenance",
    icon: "broom",
    lede: "What Docker is holding on this host, and the ways to reclaim it.",
    instanceOnly: true,
  },
  // The Hosted instance's Operator page (ADR-0050). Platform, because
  // it is the instance's staff acting across every Organization; listed only
  // for an Operator there.
  {
    slug: "operator",
    label: "Operator",
    icon: "building",
    lede: "Every Organization on this instance — its owner, members, plan and what it uses against its counts. Nothing from inside its Projects.",
    operatorOnly: true,
  },
  // F18 — the licensed surfaces.
  //
  // **One group, at the end, and the grouping is the point.** These six are the
  // only sections in the console whose contents may be entirely unavailable to
  // the Organization looking at them, and F16 ordered this list by *audience*.
  // Scattering them through the Organization and Platform groups by audience
  // would leave somebody with no licence finding six locked pages one at a
  // time, in six different places, each a small surprise. Collected under a
  // heading they read as one clearly-labelled region that a licence opens.
  //
  // License comes first because it is the screen every `LicenseGate` links to,
  // and Audit log second because it is the one here that is **not** gated —
  // `audit-log.controller.ts` deliberately carries no licence check.
  {
    slug: "license",
    label: "License",
    icon: "key",
    lede: "The license key this Organization is activated with, and what it opens.",
    groupLabel: "Enterprise",
  },
  {
    slug: "audit-log",
    label: "Audit log",
    icon: "list",
    lede: "Who did what in this Organization, and when.",
  },
  {
    slug: "roles",
    label: "Roles",
    icon: "sliders",
    lede: "The roles this Organization hands out, and exactly what each one allows.",
  },
  {
    slug: "sso",
    label: "Single sign-on",
    icon: "key",
    lede: "The identity providers members sign in through, and the directory that provisions them.",
  },
  {
    slug: "forward-auth",
    label: "Forward auth",
    icon: "globe",
    lede: "An authentication proxy in front of a deployed Application's own domain.",
  },
  // White-labeling. Here and not under Platform, although the branding
  // is one instance-wide row: the backend gates its write on an enterprise
  // licence, so it is one of the things a licence opens and belongs in the
  // region that says so. Last, because it is the only one of the six that
  // changes what *every* Organization on the instance sees.
  {
    slug: "branding",
    label: "Branding",
    icon: "palette",
    lede: "The name, logo, favicon, colors and error-page copy this instance shows — white-labeling.",
    // On the Hosted instance the branding is Octabyte's and never sold.
    instanceOnly: true,
  },
];

export function settingsSection(slug: string): SettingsSection | null {
  return SETTINGS_SECTIONS.find((section) => section.slug === slug) ?? null;
}

export function settingsHref(slug: string): string {
  return `/settings/${slug}`;
}

export type SettingsGroup = { label: string; sections: SettingsSection[] };

/**
 * The registry's flat list, cut at each entry that starts a group.
 *
 * A `groupLabel` marks the *first* section of a run, which is what makes adding
 * a section to an existing group a one-line change with no second edit — the
 * same shape the tab registry uses, and the reason this is derived rather than
 * stored as a nested structure. The index page and the settings navigation
 * both read it, through `useSettingsGroups`, which asks whether the reader is
 * an Operator so the Operator section is listed only for one, and whether
 * they are shown the platform host's pages.
 */
export function settingsGroups({
  operator,
  platformHost,
}: {
  /** Whether the reader is an Operator on the Hosted instance. */
  operator: boolean;
  /** Whether the reader is shown the `instanceOnly` sections. */
  platformHost: boolean;
}): SettingsGroup[] {
  const groups: SettingsGroup[] = [];
  let label: string | undefined;
  for (const section of SETTINGS_SECTIONS) {
    // A hidden section still names the group it starts, so the next visible
    // one lands under the right heading.
    if (section.groupLabel) label = section.groupLabel;
    if (section.operatorOnly && !operator) continue;
    if (section.instanceOnly && !platformHost) continue;
    const current = groups[groups.length - 1];
    const groupLabel = label ?? "Settings";
    if (!current || current.label !== groupLabel) {
      groups.push({ label: groupLabel, sections: [] });
    }
    groups[groups.length - 1].sections.push(section);
  }
  return groups;
}
