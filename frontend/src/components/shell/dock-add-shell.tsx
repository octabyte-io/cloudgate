import { useSyncExternalStore } from "react";

import { Menu } from "@/components/console/menu";
import { terminalTitle } from "@/components/console/terminal-target";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";

import type { DockApi } from "./dock-context";
import { DOCK_SHELLS_FULL_SENTENCE } from "./dock-store";

/**
 * `+`: the shells the current page can open (`useTerminalOffers`). Disabled at
 * the cap; empty, with a sentence, on a page that offers none.
 */
export function DockAddShell({ dock }: { dock: DockApi }) {
  const offers = useSyncExternalStore(
    dock.offers.subscribe,
    dock.offers.getSnapshot,
    dock.offers.getSnapshot,
  );

  if (dock.shellsFull) {
    return (
      <Button
        size="icon-xs"
        variant="qt"
        aria-label="Open another shell"
        title={DOCK_SHELLS_FULL_SENTENCE}
        disabled
      >
        <Icon name="plus" size={14} />
      </Button>
    );
  }

  return (
    <Menu
      align="start"
      className="max-w-96"
      trigger={
        <Button
          size="icon-xs"
          variant="qt"
          aria-label="Open another shell"
          title="Open another shell"
        >
          <Icon name="plus" size={14} />
        </Button>
      }
    >
      {offers.length > 0 ? (
        <Menu.Group label="Open a shell on">
          {offers.map((offer) => {
            const name = terminalTitle(offer.target);
            return (
              <Menu.Item
                key={name}
                icon="term"
                onClick={() => dock.open(offer.target)}
              >
                {name}
              </Menu.Item>
            );
          })}
        </Menu.Group>
      ) : (
        <p className="max-w-72 px-2.25 py-1.75 text-meta text-tx-2">
          This page offers no shells to open. A Server, a Service or the Servers
          screen does.
        </p>
      )}
    </Menu>
  );
}
