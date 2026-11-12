import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreviewDeployment } from "@/lib/api/endpoints/preview-deployments";

import type {
  usePreviewDeployments,
  usePreviewMutations,
} from "../advanced/use-advanced";
import { PreviewListCard } from "./previews-list-card";

// Every statement held: the gates are `requested-previews-card.test.tsx`'s.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));

afterEach(cleanup);

/** One open preview per pull request number, which is all the strip counts. */
const openPreviews = (count: number) =>
  Array.from({ length: count }, (_value, index) => ({
    previewDeploymentId: `prev-${index + 1}`,
    trigger: "pullRequest",
    pullRequestNumber: `${index + 1}`,
    pullRequestTitle: "A thing",
    pullRequestURL: `https://github.com/acme/storefront/pull/${index + 1}`,
    branch: `feature/${index + 1}`,
    appName: `preview-web-app-${index + 1}`,
    domain: `preview-web-app-${index + 1}.preview.example.com`,
    previewStatus: "done",
    createdAt: new Date().toISOString(),
  })) as unknown as PreviewDeployment[];

const listed = (rows: PreviewDeployment[]) =>
  ({
    data: rows,
    isPending: false,
    error: null,
  }) as unknown as ReturnType<typeof usePreviewDeployments>;

const mutations = {
  redeploy: { isPending: false, mutateAsync: async () => undefined },
  remove: { isPending: false, mutateAsync: async () => undefined },
} as unknown as ReturnType<typeof usePreviewMutations>;

const said = (rows: number, limit: number, active = true) => {
  render(
    <PreviewListCard
      previews={listed(openPreviews(rows))}
      mutations={mutations}
      active={active}
      limit={limit}
    />,
  );
  return document.body.textContent ?? "";
};

describe("PreviewListCard", () => {
  /**
   * A pull request refused by the limit was told nothing anywhere — no
   * comment, no row, no log line — and this screen showed the running previews
   * with no sign that a third pull request had been turned away. It cannot show
   * the refused pull request itself, because nothing is written down when one is
   * refused; what it holds is the count and the limit, which is what says
   * whether the next pull request gets a preview at all.
   */
  it("says every slot is taken when the open previews reach the limit", () => {
    expect(said(2, 2)).toContain("Every slot is taken.");
    // The word the settings hint above it uses, rather than a second account of
    // what happens past the limit: refused, not queued.
    expect(said(2, 2)).toContain("refused rather than queued");
  });

  it("says nothing about slots while one is free", () => {
    const strip = said(1, 2);

    expect(strip).toContain("separate service");
    expect(strip).not.toContain("Every slot is taken.");
  });

  /**
   * Lowering the limit under the open count is reachable from the card above —
   * nothing tears a preview down to satisfy it — and that state refuses the next
   * pull request exactly as a full one does, so it must read as full rather than
   * as having room.
   */
  it("says every slot is taken when more are open than the limit allows", () => {
    expect(said(3, 2)).toContain("Every slot is taken.");
  });

  /**
   * The strip is where this screen says what a teardown removes, and it
   * left the image out while the teardown left the image on the host — 242 MB
   * per pull request. Both halves are true now, and this is the copy the fix
   * quoted as evidence.
   */
  it("names the image among what a teardown removes", () => {
    expect(said(1, 2)).toContain(
      "removes the service, the code cloned for it and the image built for it.",
    );
  });
  /**
   * The refused pull request at the one limit the strip above cannot reach.
   * With previews on and "Most previews at once" set to 0 every pull request is
   * refused and no preview is ever written, so there are no rows, so there is
   * no strip — the screen said nothing at all in exactly the state the refusal
   * is loudest, and the empty state invited the reader to open a pull request
   * the product would turn away. The backend has its own sentence for this
   * limit (`previewLimitRefusal(0)`); this is its counterpart on the screen.
   */
  it("says every pull request is refused when previews are on and the limit is 0", () => {
    const screen = said(0, 0);

    expect(screen).toContain("Every pull request is refused");
    // The setting by its own name, in the console's quotes (the backend's zero
    // arm names it too, in the plain ones a GitHub comment gets).
    expect(screen).toContain("\u201cMost previews at once\u201d is 0");
    // Not the invitation for a limit that has room: opening a pull request
    // against this Application builds nothing at all.
    expect(screen).not.toContain("a preview is built for it");
  });

  /**
   * Previews switched off is the older, plainer reason for the same empty
   * table, and it outranks the limit: turning them on is what the reader has to
   * do first, and the limit is the card above's business once they have.
   */
  it("says previews are off rather than refused when they are switched off", () => {
    const screen = said(0, 0, false);

    expect(screen).toContain("Previews are off for this Application");
    expect(screen).not.toContain("Every pull request is refused");
  });

  /**
   * Lowering the limit to 0 with previews still open leaves the table full and
   * the strip showing. "Once one of these has been torn down" is false there —
   * tearing every one down frees nothing at a limit of 0 — so the strip says
   * what the pull request is told instead: raise the limit.
   */
  it("does not offer a freed slot at a limit of 0", () => {
    const strip = said(2, 0);

    expect(strip).toContain("Every pull request is refused");
    expect(strip).not.toContain("once one of these has been torn down");
  });

  /**
   * The host link used to hard-code `https://` while the pull-request
   * comment hard-coded `http://`. Both now print the backend's `url`, which is
   * `https://` only where a stored certificate covers the host; the reason an
   * `http://` link is one rides along as `urlNote`.
   */
  it("links each host at the url the backend printed for it", () => {
    const [covered, uncovered] = openPreviews(2);
    render(
      <PreviewListCard
        previews={listed([
          { ...covered, url: `https://${covered.domain}` },
          {
            ...uncovered,
            url: `http://${uncovered.domain}`,
            urlNote: "No certificate covers *.preview.example.com.",
          },
        ])}
        mutations={mutations}
        active
        limit={3}
      />,
    );
    const hostLink = (domain: string) =>
      [...document.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === domain,
      );

    expect(hostLink(covered.domain)?.getAttribute("href")).toBe(
      `https://${covered.domain}`,
    );
    expect(hostLink(covered.domain)?.hasAttribute("title")).toBe(false);
    expect(hostLink(uncovered.domain)?.getAttribute("href")).toBe(
      `http://${uncovered.domain}`,
    );
    expect(hostLink(uncovered.domain)?.getAttribute("title")).toBe(
      "No certificate covers *.preview.example.com.",
    );
  });

  /**
   * The list route answers both triggers, and a Requested preview has no
   * pull request to link and no slot under "Most previews at once". This card
   * is about pull requests, so it lists and counts theirs alone.
   */
  it("shows no requested preview, and does not count one against the limit", () => {
    const [pullRequest] = openPreviews(1);
    const requested = {
      ...pullRequest,
      previewDeploymentId: "requested-1",
      trigger: "requested",
      pullRequestId: null,
      pullRequestNumber: null,
      pullRequestTitle: null,
      pullRequestURL: null,
      requesterId: "agent-1",
      expiresAt: new Date().toISOString(),
      branch: "agent/requested-branch",
      domain: "preview-requested.preview.example.com",
    } as unknown as PreviewDeployment;
    render(
      <PreviewListCard
        previews={listed([pullRequest, requested])}
        mutations={mutations}
        active
        limit={2}
      />,
    );
    const screen = document.body.textContent ?? "";

    expect(screen).toContain(pullRequest.branch);
    expect(screen).not.toContain("agent/requested-branch");
    expect(screen).not.toContain("preview-requested.preview.example.com");
    // One pull-request preview against a limit of two leaves a slot free.
    expect(screen).not.toContain("Every slot is taken.");
  });
});
