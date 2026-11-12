import * as React from "react";

import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * The grid a set of PickCards lives in (e-console.html:824-826). Cards reflow
 * to whatever fits at 210px or wider, so the same set is three across on a
 * laptop and one across on a phone without a breakpoint.
 */
export function PickGrid({
  label,
  className,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(var(--spacing-pick),1fr))] gap-3",
        className,
      )}
      {...props}
    />
  );
}

export type PickCardProps = Omit<React.ComponentProps<"button">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A literal that identifies the choice — an image name, a size, a region. */
  meta?: React.ReactNode;
  icon?: IconName;
  selected?: boolean;
  /** Marks the card inert without taking it out of the tab order. */
  inert?: boolean;
  /**
   * Clamp the description to this many lines (F17). For a set whose descriptions
   * are not written to a length — a catalogue of 500 templates has some of one
   * clause and some of 677 characters, and unclamped they make one card six times
   * the height of its neighbour.
   */
  descriptionLines?: 2 | 3;
  /**
   * A last row under the meta (F17) — a tag row on a template. Its own slot
   * rather than being folded into `meta`, which is one mono literal and would set
   * a row of chips in monospace.
   */
  footer?: React.ReactNode;
  /**
   * Render the card as something other than a `<button>` — pass `<Link href=…>`
   * and it becomes one (F17).
   *
   * **A card that goes somewhere has to be a link.** F07's `LinkButton` states the
   * rule and this is the same one: a `<button onClick={push}>` cannot be opened in
   * a new tab, which for a catalogue — where comparing two entries is the ordinary
   * thing — is the gesture people reach for first. `aria-pressed` is dropped with
   * the button, because a link is not a toggle and announcing 24 catalogue rows as
   * "not pressed" says the opposite of what they do.
   */
  render?: React.ReactElement<{
    className?: string;
    children?: React.ReactNode;
  }>;
};

/**
 * A choice with room to explain itself (e-console.html:827-841) — a runtime, a
 * Server size, a template. Use it where a radio's label would need a
 * paragraph.
 *
 * `aria-pressed`, as the reference has it: each card is a button that changes
 * the screen when you press it, and the set is named by the PickGrid around
 * it. With `render` it is a link instead, and the radio dot goes with the
 * pressed state — see that prop.
 */
export function PickCard({
  title,
  description,
  meta,
  icon,
  selected = false,
  inert = false,
  descriptionLines,
  footer,
  render,
  className,
  ...props
}: PickCardProps) {
  const link = render !== undefined;

  const body = (
    <>
      <span className="flex w-full items-center gap-2.25">
        {icon ? <Icon name={icon} className="text-tx-2" /> : null}
        <span
          data-slot="pick-title"
          className="min-w-0 flex-1 text-body font-semibold wrap-anywhere text-tx"
        >
          {title}
        </span>
        {/* The radio dot is what makes a pick read as one of a set, so it goes
            when the card is a link: a link is not a choice among the cards beside
            it, and an unfilled dot on all 24 of them would say the opposite. No
            glyph replaces it — the whole card is the target, which is the
            convention, and every candidate in our icon set (a route, an external
            mark) says something that is not true here. */}
        {link ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "size-4 flex-none rounded-pill bg-panel",
              selected ? "border-4 border-brand" : "border border-line-2",
            )}
          />
        )}
      </span>
      {description ? (
        <span
          className={cn(
            "text-meta wrap-anywhere text-tx-2",
            descriptionLines === 2 && "line-clamp-2",
            descriptionLines === 3 && "line-clamp-3",
          )}
        >
          {description}
        </span>
      ) : null}
      {meta ? (
        <span className="font-mono text-meta text-tx-3">{meta}</span>
      ) : null}
      {footer ? <span className="mt-0.25 w-full">{footer}</span> : null}
    </>
  );

  const shell = cn(
    "flex w-full min-w-0 flex-col items-start gap-1.75 rounded-xl border p-3.5 text-left shadow-panel transition-[color,background-color,border-color,transform] duration-100 ease-out-strong",
    // The same 1px press as `Button`, and never on an inert card.
    "active:not-aria-disabled:translate-y-px",
    selected
      ? "inset-ring inset-ring-brand border-brand bg-panel"
      : "border-line bg-panel hover:border-line-2",
    className,
  );

  if (render) {
    return React.cloneElement(
      render,
      { className: cn(shell, render.props.className) },
      body,
    );
  }

  return (
    <button
      type="button"
      data-slot="pick"
      aria-pressed={selected}
      aria-disabled={inert || undefined}
      {...props}
      // After the spread, or `props.onClick` lands on top and an inert card
      // still fires its handler.
      onClick={inert ? undefined : props.onClick}
      className={shell}
    >
      {body}
    </button>
  );
}
