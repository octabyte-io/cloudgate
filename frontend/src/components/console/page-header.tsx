import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  title: React.ReactNode;
  icon?: IconName;
  /** One sentence saying what this screen is for. */
  lede?: React.ReactNode;
  /**
   * A second, quieter sentence. It gets its own line rather than running on
   * at a smaller size mid-paragraph (e-console.html:413).
   */
  strap?: React.ReactNode;
  /** Marks and chips that sit on the title line — status, environment, region. */
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

/**
 * The top of every screen (e-console.html:405-419).
 *
 * The title block asks for 340px and the actions take what is left, so the two
 * wrap apart on their own well before any breakpoint. Below 620px the actions
 * go full-width and share the row evenly — a phone has no room for a 100px
 * button floating beside a 90px one.
 */
export function PageHeader({
  title,
  icon,
  lede,
  strap,
  badges,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn("mb-5.5 flex flex-wrap items-start gap-4.5", className)}
    >
      <div className="min-w-0 flex-[1_1_340px] basis-85">
        <div className="flex flex-wrap items-center gap-2.75">
          <h1 className="flex min-w-0 items-center gap-2.75 text-disp wrap-anywhere text-tx max-hd:text-sect">
            {icon ? (
              <Icon name={icon} size={24} className="flex-none text-tx-2" />
            ) : null}
            {title}
          </h1>
          {badges ? (
            <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
          ) : null}
        </div>
        {lede ? (
          <p className="mt-1.75 max-w-lede text-body text-tx-2">{lede}</p>
        ) : null}
        {strap ? (
          <p className="mt-1.25 max-w-lede text-meta text-tx-2">{strap}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-none flex-wrap items-center gap-2 pt-1 max-hd:w-full max-hd:*:flex-[1_1_auto]">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
