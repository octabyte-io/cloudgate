import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
  /** Hide the word and let the icon name the control. Needs `icon`. */
  iconOnly?: boolean;
  /** This one segment off, the same way `disabled` turns them all off. */
  disabled?: boolean;
  /** Why it is off, or what it does — the segment's `title`. */
  title?: string;
};

export type SegmentedProps<T extends string> = {
  /** Names the set for a screen reader. Required — a bare group of buttons says nothing. */
  label: string;
  options: SegmentedOption<T>[];
  /** `null` while the choice is not known yet, which is honest on a server render. */
  value: T | null;
  onChange: (value: T) => void;
  /**
   * Every segment off: `aria-disabled`, so it keeps its place in the
   * tab order and looks off by the one rule in `globals.css`, and a click is
   * refused here, since a hand-written `aria-disabled` swallows none.
   */
  disabled?: boolean;
  className?: string;
};

/**
 * A small set of mutually exclusive choices, shown all at once
 * (e-console.html:472-480). Use it when there are two to four options and the
 * options themselves are worth reading; past that it is a Select.
 *
 * `aria-pressed` rather than radio semantics, because each segment is a button
 * that does something immediately — nothing here is submitted later.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex h-nav items-center gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const on = value === option.value;
        const off = disabled || option.disabled === true;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            aria-disabled={off || undefined}
            title={option.title}
            onClick={() => {
              if (!off) onChange(option.value);
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-ui font-medium whitespace-nowrap transition-colors duration-100",
              on ? "bg-panel text-tx shadow-float" : "text-tx-2 hover:text-tx",
            )}
          >
            {option.icon ? (
              <Icon
                name={option.icon}
                size={14}
                label={option.iconOnly ? option.label : undefined}
              />
            ) : null}
            {option.iconOnly ? null : option.label}
          </button>
        );
      })}
    </div>
  );
}
