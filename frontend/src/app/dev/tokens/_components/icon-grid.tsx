import { ICONS, Icon, type IconName } from "@/lib/design/icons";

const NAMES = Object.keys(ICONS) as IconName[];

/**
 * The whole map, drawn. lucide renamed two of these under us — Filter became
 * Funnel, AlertTriangle became TriangleAlert — so the value of seeing the set
 * on one screen is that the next rename shows up as a hole, not as a build
 * error in whichever screen happened to use it.
 */
export function IconGrid() {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
      {NAMES.map((name) => (
        <li
          key={name}
          className="flex flex-col items-center gap-1.5 rounded-md border border-line bg-panel-2 py-2.5"
        >
          <Icon name={name} size={20} className="text-tx-2" />
          <span className="num font-mono text-chip text-tx-3">{name}</span>
        </li>
      ))}
    </ul>
  );
}
