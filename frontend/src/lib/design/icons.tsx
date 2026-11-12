import {
  Activity,
  ArrowLeft,
  Box,
  BookOpen,
  Brush,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Clock,
  Cloud,
  Copy,
  Cpu,
  Database,
  DollarSign,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  Funnel,
  Gauge,
  GitBranch,
  Globe,
  HardDrive,
  Hash,
  House,
  Info,
  KeyRound,
  Layers,
  LifeBuoy,
  List,
  Lock,
  Logs,
  Mail,
  MapPin,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Network,
  Palette,
  PanelBottom,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Route,
  Search,
  Server,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  Star,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one place the app imports lucide.
 *
 * Keys are the prototype's icon names (e-console.html:1859-1914), so a rail
 * table or a nav entry reads the same here as it does there, and swapping an
 * icon is a one-line change in this file. lucide has already renamed two of
 * these under us — Filter became Funnel, AlertTriangle became TriangleAlert —
 * which is the argument for the indirection.
 */
export const ICONS = {
  activity: Activity,
  alert: TriangleAlert,
  back: ArrowLeft,
  book: BookOpen,
  box: Box,
  branch: GitBranch,
  // F16: reclaiming disk. Lucide has no broom; a brush is the nearest thing
  // that reads as *sweeping up* rather than as deleting one named thing.
  broom: Brush,
  // F16: the Organization as a tenant, distinct from `users` (its members).
  building: Building2,
  buoy: LifeBuoy,
  cash: DollarSign,
  check: Check,
  chevD: ChevronDown,
  chevR: ChevronRight,
  chevU: ChevronUp,
  chevUD: ChevronsUpDown,
  clock: Clock,
  cloud: Cloud,
  cog: Settings,
  copy: Copy,
  cpu: Cpu,
  db: Database,
  // The docked terminal panel along the bottom of the console.
  dock: PanelBottom,
  dl: Download,
  ext: ExternalLink,
  eye: Eye,
  // F06: the two halves of one toggle, so a password field can be read back.
  eyeOff: EyeOff,
  filter: Funnel,
  folder: Folder,
  gauge: Gauge,
  globe: Globe,
  hash: Hash,
  hdd: HardDrive,
  home: House,
  info: Info,
  key: KeyRound,
  layers: Layers,
  list: List,
  lock: Lock,
  // A Docked log's tab, where a Docked shell's has `term`: lines of output.
  lines: Logs,
  // F06: a reset link, an invitation — the things that arrive by email.
  mail: Mail,
  // The Dock fills the viewport below the masthead, and goes back.
  maximise: Maximize2,
  monitor: Monitor,
  moon: Moon,
  net: Network,
  // Branding — how the instance looks, not a setting of any one thing.
  palette: Palette,
  panel: PanelLeft,
  pencil: Pencil,
  pin: MapPin,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  restore: Minimize2,
  rocket: Rocket,
  // F16: Traefik — what every request is routed *through*, not a network.
  route: Route,
  search: Search,
  server: Server,
  shield: Shield,
  sliders: SlidersHorizontal,
  spark: Sparkles,
  star: Star,
  // The missing half of `play`. Adding a glyph rather than stripping the
  // four beside it, because the console had already decided and only this key
  // was missing — `play` marks a start at six controls, `refresh` a restart,
  // `rocket` a deploy, and the *five* Stops in the tree were bare at every one
  // of them. One absent key, not five authors each choosing nothing.
  //
  // `Square` and not `CircleStop`: `play` here is lucide's bare `Play`, and a
  // circled stop next to an uncircled play reads as two icon sets rather than
  // one pair. `Octagon` was rejected for the same reason plus a second — it is
  // a road sign, which says *forbidden* rather than *this stops the process*.
  stop: Square,
  sun: Sun,
  tag: Tag,
  term: SquareTerminal,
  trash: Trash2,
  ul: Upload,
  user: User,
  // F16: people in the plural — a member list, not one person's account.
  users: Users,
  x: X,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export type IconProps = {
  name: IconName;
  /** Pixel size. 16 in a row of text, 13 in a table head, 20 in an empty state. */
  size?: number;
  /**
   * The accessible name. Give it only when the icon is the *only* thing saying
   * what this is — a bare icon button. Beside a word, leave it off: the icon is
   * decoration and a duplicate name just makes the control read twice.
   */
  label?: string;
  className?: string;
};

/**
 * 1.6 stroke, not lucide's 2 — the weight the reference uses, and the weight
 * the prototype's hand-drawn set was cut at.
 */
export function Icon({ name, size = 16, label, className }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={1.6}
      className={cn("shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}
