import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { toneOf } from "./log-tones";
import { PhasesCard } from "./phases-card";

afterEach(cleanup);

const cardText = () => {
  render(<PhasesCard />);
  return document.body.textContent ?? "";
};

/**
 * *The screen half of the convergence poll.*
 *
 * The Deployment's status pill stays green when the convergence budget runs out
 * with nothing converged and nothing failed — that is the whole point of
 * choosing `done` over inventing a failure from a clock. Which means this card
 * is where "the tasks are running" and "we never confirmed they were" have to be
 * told apart, and it is the criterion the maintainer's decision moved here.
 */
describe("PhasesCard — phase 4's three endings", () => {
  it("says phase 4 waits, which it did not before", () => {
    const text = cardText();

    expect(text).toContain(
      "waits for its tasks to be running before it reports",
    );
    // The sentence left behind, which stopped being true with the poll.
    expect(text).not.toContain("its tasks converge afterwards");
  });

  it("distinguishes an unconfirmed Deployment from a converged one", () => {
    const text = cardText();

    expect(text).toContain("the tasks are running, and the Deployment is done");
    expect(text).toContain("Swarm rolled it back to its previous spec");
    expect(text).toContain("the wait ran out with neither");
    // And the unconfirmed one is not dressed up as a failure.
    expect(text).toContain("The Deployment is still done");
  });

  it("keeps the sentence that makes a failed Deployment legible", () => {
    // Untouched by the poll, which makes it more true rather than less: the
    // rolled-back ending is exactly a failed Deployment still serving.
    expect(cardText()).toContain(
      "a phase of a Deployment, not another word for one",
    );
  });

  it("uses the markers the log well already tones, so the two agree", () => {
    const text = cardText();

    for (const marker of ["✅", "❌", "⚠️"]) {
      expect(text).toContain(marker);
    }
    expect(toneOf("✅ Swarm service 'web' updated; 2 of 2 tasks running.")).toBe(
      "ok",
    );
    expect(toneOf("❌ Swarm service 'web' did not take: Swarm rolled it")).toBe(
      "bad",
    );
    // The ⚠️ line carries no form of the word "warning" for the generic
    // pattern to catch, so the marker is what has to be matched.
    expect(
      toneOf(
        "⚠️ Swarm service 'web' created; 0 of 1 tasks running after 90s. Convergence was not confirmed.",
      ),
    ).toBe("warn");
  });
});

/**
 * A Docker-image
 * source pushes nothing, Registry or not — its image is released by the
 * operator's own reference, so a push there was a tag no service ever ran.
 * "The image goes to the registry, if one is set" was true of it until then.
 */
describe("PhasesCard — phase 3", () => {
  it("says a Docker-image source skips the push, as it skips the build", () => {
    const text = cardText();

    expect(text).toContain("The built image goes to the registry, if one is set.");
    expect(text).toContain("A Docker-image source pushes nothing");
  });
});
