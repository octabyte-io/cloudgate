import Link from "next/link";

import { Avatar } from "@/components/console/avatar";
import { Menu } from "@/components/console/menu";
import { ThemeToggle } from "@/components/console/theme-toggle";
import { useSession } from "@/lib/auth/client";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { Icon } from "@/lib/design/icons";
import { personName } from "@/lib/format/person";
import { settingsHref } from "@/lib/settings/sections";

import { useHydrated } from "./use-hydrated";

/**
 * The account menu (e-console.html:2261-2271).
 *
 * Appearance lives here, where the reference keeps it — and it is the
 * `ThemeToggle` F03 already built, rendered in the menu rather than behind a
 * submenu. Light / Dark / System is three visible choices; a submenu would add a
 * click to reach a control that fits on the row.
 *
 * The rows the prototype had that are not here had nothing behind them: Timezone
 * has no column, and Design notes was the prototype's own document.
 *
 * **The trigger is the person's avatar** — their picture, else their
 * initials, else the person glyph — and the group label is their whole name.
 * Both were a constant glyph and the first name alone, which made the Avatar and
 * Last name fields on Settings → Account save to no visible effect.
 */
export function AvatarMenu() {
  const { data } = useSession();
  // F06 owns what signing out means — ending the session is only the first of
  // its three steps, and the second (emptying the query cache) is what keeps one
  // account's rows off the next account's first paint.
  const { signOutNow } = useSignOut();
  const user = data?.user;
  const name = user ? personName(user) : "your account";
  // The glyph until hydration is over, for the reason the `aria-label` below is
  // a constant: the server renders with no session, and a picture the client's
  // first render swaps in is a hydration mismatch React logs and does not
  // repair. `useSyncExternalStore`'s server snapshot is what hydration reads,
  // so the avatar arrives on the render after it, with no effect and no flash
  // of a wrong one.
  const hydrated = useHydrated();

  return (
    <Menu
      align="end"
      trigger={
        <button
          type="button"
          /*
            A **constant** name, deliberately. It used to be `Account: ${name}`,
            which hydrated with a mismatch on every signed-in load: `useSession`
            has nothing during the server render, so the server shipped
            "Account: your account" and the client's first render replaced it with
            the real one — React logs that and does not patch the attribute up, so
            the name a screen reader gets was whichever one lost.

            The person's name is not this button's job anyway. It opens the account
            menu, and the menu's own group label names who is signed in — inside a
            popup that does not exist until it is opened, so it can hold live data
            without a hydration problem. Found by driving F06's sign-in.
          */
          aria-label="Your account"
          className="grid size-7.5 place-items-center rounded-pill border border-transparent bg-raise text-tx-2 transition-colors duration-100 hover:bg-raise-2 hover:text-tx aria-expanded:border-brand-ring aria-expanded:text-tx"
        >
          {hydrated && user ? (
            <Avatar person={user} className="size-full" />
          ) : (
            <Icon name="user" />
          )}
        </button>
      }
    >
      <Menu.Group label={name}>
        {/* Settings → Account, where F16 built the screen. This used to be
            `/account`, a placeholder from before that, which now only redirects. */}
        <Menu.Item icon="user" render={<Link href={settingsHref("account")} />}>
          Profile
        </Menu.Item>
      </Menu.Group>
      <Menu.Separator />
      {/* Not a Menu.Item: a segmented control inside a menu row would put three
          buttons inside one menuitem, and the row's own keyboard handling would
          fight all three. */}
      <div className="px-2.25 pt-1.75 pb-1 text-meta font-medium text-tx-3">
        Appearance
      </div>
      <div className="px-2.25 pb-1.5">
        <ThemeToggle className="w-full" />
      </div>
      <Menu.Separator />
      <Menu.Item icon="back" destructive onClick={() => void signOutNow()}>
        Sign out
      </Menu.Item>
    </Menu>
  );
}
