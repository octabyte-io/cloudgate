/**
 * The public documentation the Help & support screen points at.
 *
 * Every address here was opened and found live on 2026-11-20. They are kept
 * as one table rather than written into the screen, so a page that moves on
 * the website is one line to change and `help-links.test.ts` can hold them
 * all to the docs host.
 *
 * Deliberately absent: the repository's issue tracker. Console copy does not
 * cite the tracker (`features/no-tracker-links.test.ts`); a bug report goes to
 * the support address instead.
 */
export const DOCS_HOST = "https://cloudgate.octabyte.io";

export type HelpLink = {
  label: string;
  /** One sentence: what the page answers. */
  description: string;
  href: string;
};

export const GUIDES: readonly HelpLink[] = [
  {
    label: "Quickstart",
    description: "Put your first app online in a few minutes.",
    href: `${DOCS_HOST}/docs/quickstart`,
  },
  {
    label: "User guide",
    description:
      "Every screen of the console, starting with the get-started wizard.",
    href: `${DOCS_HOST}/docs/guide/get-started`,
  },
  {
    label: "How Cloudgate fits together",
    description:
      "Projects, Environments, Services and Servers, and how they relate.",
    href: `${DOCS_HOST}/docs/concepts`,
  },
  {
    label: "CLI guide",
    description:
      "Install the CLI, link a folder and deploy from your terminal or CI.",
    href: `${DOCS_HOST}/docs/cli`,
  },
  {
    label: "MCP and agents",
    description: "Let an AI coding agent work in your Organization over MCP.",
    href: `${DOCS_HOST}/docs/mcp`,
  },
  {
    label: "API reference",
    description: "The REST API and its OpenAPI document.",
    href: `${DOCS_HOST}/docs/api`,
  },
];

export const ANSWERS: readonly HelpLink[] = [
  {
    label: "Troubleshooting",
    description: "Fixes for failed builds, unreachable Servers and domains.",
    href: `${DOCS_HOST}/docs/help/troubleshooting`,
  },
  {
    label: "FAQ",
    description: "Plans, data, agents and hosting.",
    href: `${DOCS_HOST}/docs/help/faq`,
  },
  {
    label: "Limits",
    description: "What Cloudgate can and cannot do.",
    href: `${DOCS_HOST}/docs/help/limits`,
  },
  {
    label: "Changelog",
    description: "What changed in each release.",
    href: `${DOCS_HOST}/changelog`,
  },
];

export const ALL_DOCS = `${DOCS_HOST}/docs`;
