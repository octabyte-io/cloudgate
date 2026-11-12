import * as React from "react";

import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type SearchInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type"
> & {
  /**
   * The accessible name. A magnifier and a placeholder are not a label:
   * the placeholder disappears the moment someone types.
   */
  label: string;
  /** Hide the visible label and let the placeholder carry the hint. Default. */
  hideLabel?: boolean;
  /** Wrapper class. Put layout here; `className` styles the input itself. */
  wrapperClassName?: string;
};

/**
 * The console's search field (e-console.html:471). Grows to fill the toolbar
 * row it sits in and shrinks to 220px before the row wraps, so a filter bar
 * reflows instead of pushing the page sideways.
 */
export function SearchInput({
  label,
  hideLabel = true,
  className,
  wrapperClassName,
  id,
  placeholder = "Search",
  ...props
}: SearchInputProps) {
  const generated = React.useId();
  const inputId = id ?? generated;

  return (
    <div
      className={cn("min-w-0 flex-[1_1_220px] basis-55", wrapperClassName)}
    >
      <label
        htmlFor={inputId}
        className={cn(
          hideLabel ? "sr-only" : "mb-1.5 block text-meta font-medium text-tx-3",
        )}
      >
        {label}
      </label>
      <div className="relative">
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-2.75 -mt-2 text-tx-3"
        />
        <Input
          id={inputId}
          type="search"
          placeholder={placeholder}
          className={cn("pl-8.5", className)}
          {...props}
        />
      </div>
    </div>
  );
}
