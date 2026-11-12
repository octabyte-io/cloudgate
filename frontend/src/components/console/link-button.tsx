import Link from "next/link";
import type { VariantProps } from "class-variance-authority";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type LinkButtonProps = Omit<
  React.ComponentProps<"a">,
  "href" | "role"
> &
  VariantProps<typeof buttonVariants> & {
    href: string;
    /**
     * A full document load instead of a client-side navigation. For when the
     * *session* changed underneath us — accepting an invitation moves the active
     * Organization on the backend, and the console has to be rendered against that
     * rather than against the session this tab loaded with.
     */
    reload?: boolean;
  };

/**
 * A link that looks like a button.
 *
 * It is a plain anchor wearing `buttonVariants`, and deliberately **not**
 * Base UI's `Button` rendered as an anchor. With `nativeButton={false}`
 * that component stamps `role="button"` on whatever it renders, so a screen
 * reader announced every one of these as a button and Space — which activates a
 * button — did nothing on what is really a link. The rule in the design system
 * is that a control that goes somewhere has to be a link, and a role that says
 * otherwise undoes it. `link-button.test.tsx` holds that line.
 *
 * Use this whenever the control *goes somewhere*. A `<button onClick={push}>` is
 * a link that cannot be opened in a new tab, copied, or seen by a crawler.
 */
export function LinkButton({
  href,
  reload,
  variant = "gh",
  size = "default",
  className,
  ...props
}: LinkButtonProps) {
  const cls = cn(buttonVariants({ variant, size, className }));
  return reload ? (
    <a data-slot="button" href={href} className={cls} {...props} />
  ) : (
    <Link data-slot="button" href={href} className={cls} {...props} />
  );
}
