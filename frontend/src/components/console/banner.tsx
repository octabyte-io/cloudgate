import * as React from "react";

import { Icon, type IconName } from "@/lib/design/icons";
import { TONE_FILL, type Tone } from "@/lib/design/status";
import { cn } from "@/lib/utils";

export type BannerProps = Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  icon?: IconName;
  /** How many rows are inside. Shown as a badge on the header. */
  count?: number;
  defaultOpen?: boolean;
};

/**
 * A collapsible group of things that want attention
 * (e-console.html:555-571) — drift, failed Deployments, a Server that stopped
 * answering. It opens by default: a summary nobody expands is a summary
 * nobody reads.
 */
export function Banner({
  title,
  icon,
  count,
  defaultOpen = true,
  className,
  children,
  ...props
}: BannerProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useId();

  return (
    <div
      data-slot="banner"
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-panel",
        className,
      )}
      {...props}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-2.25 px-4 py-2.75 text-left text-body font-medium text-tx transition-colors duration-100 hover:bg-panel-2"
      >
        {icon ? <Icon name={icon} className="text-tx-2" /> : null}
        <span className="min-w-0 flex-1 wrap-anywhere">{title}</span>
        {count === undefined ? null : (
          <span className="inline-grid h-5 min-w-5 flex-none place-items-center rounded-pill bg-brand px-1.5 text-chip font-semibold text-primary-foreground">
            {count}
          </span>
        )}
        {/* One chevron that turns, rather than two glyphs swapped: the turn is
            what says the body below belongs to this row. */}
        <Icon
          name="chevR"
          className={cn(
            "flex-none text-tx-3 transition-transform duration-150 ease-out-strong",
            open && "rotate-90",
          )}
        />
      </button>
      {/* `hidden` lifts to `display: block`, which restarts the fade on each open. */}
      <div id={bodyId} hidden={!open} className="animate-fade border-t border-line py-1">
        {children}
      </div>
    </div>
  );
}

export type BannerRowProps = Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The bullet's colour. `info` is the default and means "worth knowing". */
  tone?: Tone;
  /** One control, at the end of the row. Drops under the text at 620px. */
  action?: React.ReactNode;
};

/** The tone word, so the bullet is never the only thing saying how bad this is. */
const TONE_WORD: Record<Tone, string> = {
  ok: "Resolved",
  warn: "Needs attention",
  bad: "Failing",
  info: "For information",
  mute: "Noted",
};

export function BannerRow({
  title,
  description,
  tone = "info",
  action,
  className,
  ...props
}: BannerRowProps) {
  return (
    <div
      className={cn("flex flex-wrap gap-2.75 px-4 py-2.75", className)}
      {...props}
    >
      <span
        className={cn(
          "mt-1.25 size-2 flex-none rounded-pill",
          TONE_FILL[tone],
        )}
      >
        <span className="sr-only">{TONE_WORD[tone]}: </span>
      </span>
      {/*
        wrap-anywhere because this copy is real infrastructure prose and holds
        unbreakable tokens — image digests, resource addresses, a Docker Swarm
        service name. Without it one long token walks straight out from under
        the action button on a phone.
      */}
      <div className="min-w-0 flex-1 basis-50">
        <p className="text-body font-semibold wrap-anywhere text-tx">{title}</p>
        {description ? (
          <p className="mt-0.5 text-body wrap-anywhere text-tx-2">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex-none self-center max-hd:w-full max-hd:pl-4.75 max-hd:*:w-full">
          {action}
        </div>
      ) : null}
    </div>
  );
}
