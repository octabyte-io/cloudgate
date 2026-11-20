import { Icon } from "@/lib/design/icons";

import type { HelpLink } from "./help-links";

/**
 * A card's list of documentation pages: name, one line on what it answers,
 * and the external-link mark. Each row is one `<a>`, so the whole row is the
 * target and opens in a new tab, leaving the console where it was.
 */
export function HelpLinkList({ links }: { links: readonly HelpLink[] }) {
  return (
    <ul>
      {links.map((link) => (
        <li key={link.href} className="border-b border-line last:border-b-0">
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer noopener"
            className="group flex items-start gap-3 px-4 py-3 transition-colors duration-100 hover:bg-panel-2 focus-visible:bg-panel-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-tx group-hover:underline group-hover:underline-offset-2">
                {link.label}
              </span>
              <span className="mt-0.5 block text-meta text-tx-2">
                {link.description}
              </span>
            </span>
            <Icon name="ext" size={14} className="mt-1 flex-none text-tx-3" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
