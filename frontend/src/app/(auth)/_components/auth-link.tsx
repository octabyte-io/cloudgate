import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * A link in an auth screen's running text or its footer.
 *
 * It exists because `globals.css` deliberately sets no colour on a bare `<a>` — a
 * link's colour is a component decision — and these screens have a dozen links in
 * body copy, which is the one place in the app where a link has to look like one
 * without being a button.
 *
 * Underlined on hover and focus rather than always: at the bottom of a card, four
 * permanently underlined items read as a list of rules.
 */
export function AuthLink({
  className,
  ...props
}: React.ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "rounded-sm text-brand-tx underline-offset-2 hover:underline focus-visible:underline",
        className,
      )}
      {...props}
    />
  );
}
