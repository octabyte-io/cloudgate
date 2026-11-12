/**
 * The gallery's subject matter: every row it audits or draws. Data only — the
 * components that render it stay short enough to read.
 */

/** What a measured pair has to clear. */
export type Tier = "text" | "ui" | "decoration";

export const TIER_MINIMUM: Record<Tier, number | null> = {
  /** WCAG 1.4.3 — body text and labels. */
  text: 4.5,
  /** WCAG 1.4.11 — a boundary or indicator you have to be able to find. */
  ui: 3,
  /** Carries no meaning, so it owes nothing. */
  decoration: null,
};

export type Pair = {
  fg: string;
  bg: string;
  fgClass: string;
  bgClass: string;
  tier: Tier;
  /** Why this pair is on the list at all. */
  note?: string;
};

/**
 * The contract from 00-INDEX.md is the first block: --tx, --tx-2 and --tx-3 all
 * clear 4.5:1 on --panel, and white clears 4.5:1 on --brand. The rest are the
 * pairs those tokens are actually used in, because a token that passes on
 * --panel and fails on --panel-2 has still failed on screen.
 */
export const PAIRS: Pair[] = [
  { fg: "--tx", bg: "--panel", fgClass: "text-tx", bgClass: "bg-panel", tier: "text" },
  { fg: "--tx-2", bg: "--panel", fgClass: "text-tx-2", bgClass: "bg-panel", tier: "text" },
  { fg: "--tx-3", bg: "--panel", fgClass: "text-tx-3", bgClass: "bg-panel", tier: "text" },
  { fg: "--primary-foreground", bg: "--brand", fgClass: "text-primary-foreground", bgClass: "bg-brand", tier: "text", note: "the primary control" },
  { fg: "--primary-foreground", bg: "--brand-hi", fgClass: "text-primary-foreground", bgClass: "bg-brand-hi", tier: "text", note: "the primary control, hovered" },

  { fg: "--tx", bg: "--ground", fgClass: "text-tx", bgClass: "bg-ground", tier: "text" },
  { fg: "--tx-2", bg: "--ground", fgClass: "text-tx-2", bgClass: "bg-ground", tier: "text" },
  { fg: "--tx-3", bg: "--ground", fgClass: "text-tx-3", bgClass: "bg-ground", tier: "text" },
  { fg: "--tx", bg: "--panel-2", fgClass: "text-tx", bgClass: "bg-panel-2", tier: "text", note: "table head, meta strip" },
  { fg: "--tx-2", bg: "--panel-2", fgClass: "text-tx-2", bgClass: "bg-panel-2", tier: "text" },
  { fg: "--tx-3", bg: "--panel-2", fgClass: "text-tx-3", bgClass: "bg-panel-2", tier: "text" },
  { fg: "--tx", bg: "--raise", fgClass: "text-tx", bgClass: "bg-raise", tier: "text", note: "hovered row" },
  { fg: "--tx-2", bg: "--raise", fgClass: "text-tx-2", bgClass: "bg-raise", tier: "text" },
  { fg: "--tx", bg: "--raise-2", fgClass: "text-tx", bgClass: "bg-raise-2", tier: "text", note: "selected row" },

  { fg: "--brand-tx", bg: "--panel", fgClass: "text-brand-tx", bgClass: "bg-panel", tier: "text", note: "a link" },
  { fg: "--brand-tx", bg: "--brand-tint", fgClass: "text-brand-tx", bgClass: "bg-brand-tint", tier: "text", note: "an accented chip" },

  { fg: "--ok", bg: "--ok-tint", fgClass: "text-ok", bgClass: "bg-ok-tint", tier: "text", note: "status pill" },
  { fg: "--warn", bg: "--warn-tint", fgClass: "text-warn", bgClass: "bg-warn-tint", tier: "text", note: "status pill" },
  { fg: "--bad", bg: "--bad-tint", fgClass: "text-bad", bgClass: "bg-bad-tint", tier: "text", note: "status pill" },
  { fg: "--info", bg: "--info-tint", fgClass: "text-info", bgClass: "bg-info-tint", tier: "text", note: "status pill" },
  { fg: "--ok", bg: "--panel", fgClass: "text-ok", bgClass: "bg-panel", tier: "text" },
  { fg: "--warn", bg: "--panel", fgClass: "text-warn", bgClass: "bg-panel", tier: "text" },
  { fg: "--bad", bg: "--panel", fgClass: "text-bad", bgClass: "bg-panel", tier: "text" },

  { fg: "--well-tx", bg: "--well", fgClass: "text-well-tx", bgClass: "bg-well", tier: "text", note: "log output, both themes" },

  { fg: "--brand-ring", bg: "--panel", fgClass: "text-brand-ring", bgClass: "bg-panel", tier: "ui", note: "the focus ring" },
  { fg: "--brand-ring", bg: "--ground", fgClass: "text-brand-ring", bgClass: "bg-ground", tier: "ui" },
  { fg: "--brand", bg: "--panel", fgClass: "text-brand", bgClass: "bg-panel", tier: "ui", note: "the active tab rule" },

  { fg: "--tx-4", bg: "--panel", fgClass: "text-tx-4", bgClass: "bg-panel", tier: "decoration", note: "never carries meaning" },
  { fg: "--line", bg: "--panel", fgClass: "text-line", bgClass: "bg-panel", tier: "decoration", note: "hairline" },
  { fg: "--line-2", bg: "--panel", fgClass: "text-line-2", bgClass: "bg-panel", tier: "decoration", note: "emphasis rule" },
];

export type RoleGroup = {
  title: string;
  blurb: string;
  roles: { token: string; fillClass: string; onClass: string; note?: string }[];
};

/**
 * Surfaces only mean anything in relation to each other, so they are shown as
 * one ladder rather than as isolated chips.
 */
export const ROLE_GROUPS: RoleGroup[] = [
  {
    title: "Surfaces",
    blurb:
      "The page, then what is raised off it, then what is inset back into that.",
    roles: [
      { token: "--ground", fillClass: "bg-ground", onClass: "text-tx", note: "the page behind everything" },
      { token: "--panel", fillClass: "bg-panel", onClass: "text-tx", note: "card, rail, masthead" },
      { token: "--panel-2", fillClass: "bg-panel-2", onClass: "text-tx", note: "an inset strip inside one" },
      { token: "--raise", fillClass: "bg-raise", onClass: "text-tx", note: "hover fill" },
      { token: "--raise-2", fillClass: "bg-raise-2", onClass: "text-tx", note: "selected fill" },
      { token: "--line", fillClass: "bg-line", onClass: "text-tx", note: "hairline" },
      { token: "--line-2", fillClass: "bg-line-2", onClass: "text-tx", note: "a deliberate emphasis rule" },
    ],
  },
  {
    title: "Text",
    blurb:
      "Three weights of meaning, all of which clear 4.5:1 on a panel — and one that carries none.",
    roles: [
      { token: "--tx", fillClass: "bg-tx", onClass: "text-panel", note: "primary" },
      { token: "--tx-2", fillClass: "bg-tx-2", onClass: "text-panel", note: "secondary" },
      { token: "--tx-3", fillClass: "bg-tx-3", onClass: "text-panel", note: "labels, axis ticks" },
      { token: "--tx-4", fillClass: "bg-tx-4", onClass: "text-panel", note: "decoration only" },
    ],
  },
  {
    title: "Brand",
    blurb:
      "Hue 285, held about 25° off the reference's blue so the two do not read as the same product. The one invented value in the system.",
    roles: [
      { token: "--brand", fillClass: "bg-brand", onClass: "text-primary-foreground", note: "as a fill" },
      { token: "--brand-hi", fillClass: "bg-brand-hi", onClass: "text-primary-foreground", note: "hovered" },
      { token: "--brand-ring", fillClass: "bg-brand-ring", onClass: "text-primary-foreground", note: "the focus ring" },
      { token: "--brand-tx", fillClass: "bg-brand-tx", onClass: "text-panel", note: "as text or a 1px rule" },
      { token: "--brand-line", fillClass: "bg-brand-line", onClass: "text-tx", note: "accented hairline" },
      { token: "--brand-tint", fillClass: "bg-brand-tint", onClass: "text-brand-tx", note: "accented fill" },
    ],
  },
  {
    title: "Status tones",
    blurb:
      "Four tones, each as text and as a tint. Never used as hue alone — see the vocabulary below, where every mark carries its word.",
    roles: [
      { token: "--ok", fillClass: "bg-ok", onClass: "text-panel", note: "running, done, active" },
      { token: "--warn", fillClass: "bg-warn", onClass: "text-panel", note: "pending, restarting" },
      { token: "--bad", fillClass: "bg-bad", onClass: "text-panel", note: "error, dead" },
      { token: "--info", fillClass: "bg-info", onClass: "text-panel", note: "neutral notice" },
      { token: "--ok-tint", fillClass: "bg-ok-tint", onClass: "text-ok" },
      { token: "--warn-tint", fillClass: "bg-warn-tint", onClass: "text-warn" },
      { token: "--bad-tint", fillClass: "bg-bad-tint", onClass: "text-bad" },
      { token: "--info-tint", fillClass: "bg-info-tint", onClass: "text-info" },
    ],
  },
  {
    title: "The two exceptions",
    blurb:
      "A rack in a lit room still has black displays, so log wells stay near-black in both themes. The hatch means “does not exist yet”, never “disabled for you”.",
    roles: [
      { token: "--well", fillClass: "bg-well", onClass: "text-well-tx", note: "log and console output" },
      { token: "--well-tx", fillClass: "bg-well-tx", onClass: "text-well", note: "text in a well" },
      { token: "--hatch", fillClass: "bg-hatch", onClass: "text-tx", note: "not built yet" },
    ],
  },
];

export const TYPE_STEPS = [
  { name: "disp", recipe: "30px / 1.16 / -0.16px / 600", use: "page title", cls: "text-disp" },
  { name: "sect", recipe: "20px / 1.25 / -0.2px / 600", use: "section heading", cls: "text-sect" },
  { name: "lead", recipe: "16px / 1.5 / 400", use: "lede", cls: "text-lead" },
  { name: "body", recipe: "14px / 1.5 / 400", use: "body copy and every control", cls: "text-body" },
  { name: "ui", recipe: "13px / 1.4 / 400", use: "rail items and table cells", cls: "text-ui" },
  { name: "meta", recipe: "12px / 1.45 / 400", use: "meta and captions", cls: "text-meta" },
  { name: "chip", recipe: "11px / 1 / 500", use: "mono chips, pills and badges", cls: "text-chip" },
];

export const GEOMETRY = [
  { name: "top", px: 56, use: "masthead height", barClass: "w-top" },
  { name: "rail", px: 259, use: "scope rail, expanded", barClass: "w-rail" },
  { name: "rail-c", px: 60, use: "scope rail, collapsed", barClass: "w-rail-c" },
  { name: "aside", px: 336, use: "right rail", barClass: "w-aside" },
  { name: "col", px: 1360, use: "page measure", barClass: "w-col" },
  { name: "ctl", px: 36, use: "control height", barClass: "w-ctl" },
  { name: "nav", px: 34, use: "rail item height", barClass: "w-nav" },
  { name: "row", px: 40, use: "table row height", barClass: "w-row" },
  { name: "pad", px: 32, use: "page gutter", barClass: "w-pad" },
];

export const RADII = [
  { name: "md", px: 6, use: "chips, rail items, inner controls", cls: "rounded-md" },
  { name: "lg", px: 8, use: "buttons, inputs, segmented controls", cls: "rounded-lg" },
  { name: "xl", px: 12, use: "cards, dialogs, menus", cls: "rounded-xl" },
  { name: "pill", px: 999, use: "status pills, switches", cls: "rounded-pill" },
];

export const SHADOWS = [
  { name: "panel", use: "a control resting on the page", cls: "shadow-panel" },
  { name: "float", use: "a selected segment, a switch knob", cls: "shadow-float" },
  { name: "pop", use: "a menu, a dialog, the command palette", cls: "shadow-pop" },
];
