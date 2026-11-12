import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LEASE_CLOSE_CODE } from "@/lib/realtime/gateways";

import { LogRefusal } from "./log-refusal";

afterEach(cleanup);

/**
 * The defect was a hint that could not be true of the close it was printed under
 * and the only
 * thing that tells the two closes apart is the code. So both branches are pinned
 * here: a mid-stream refusal is the one case where the screen's own guess is
 * suppressed rather than reworded.
 */
const HINT = "A database that has never been deployed has no Swarm service.";

/**
 * A fact about the thing being logged rather than a guess at the refusal, so it
 * survives the gate — the distinction once exempted by name and later restored
 * after the conversion put it through `hint` and lost it on a `4010`.
 */
const NOTE =
  "The build may still be running — its output is written on the build Server and read from there.";

describe("LogRefusal", () => {
  it("keeps the screen's hint for a refusal decided at connect", () => {
    render(<LogRefusal reason="Not found or not permitted" code={4003} hint={HINT} />);

    expect(screen.getByText("Not found or not permitted")).toBeTruthy();
    expect(document.body.textContent).toContain(HINT);
  });

  it("drops a hint a mid-stream refusal cannot have caused, and says what did", () => {
    render(
      <LogRefusal
        reason="No longer authorized"
        code={LEASE_CLOSE_CODE}
        hint={HINT}
      />,
    );

    expect(screen.getByText("No longer authorized")).toBeTruthy();
    expect(document.body.textContent).not.toContain(HINT);
    expect(document.body.textContent).toContain(
      "authorized when it opened and is not any more",
    );
  });

  /** The reason is the gateway's and is never withheld — ADR-0012 §18. */
  it("renders the reason on its own for a screen with nothing to guess", () => {
    render(<LogRefusal reason="Not found or not permitted" code={4003} />);

    expect(screen.getByText("Not found or not permitted")).toBeTruthy();
  });

  it("renders a note that is true of any close beside a connect-time hint", () => {
    render(
      <LogRefusal
        reason="Not found or not permitted"
        code={4003}
        hint={HINT}
        note={NOTE}
      />,
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain(HINT);
    expect(said).toContain(NOTE);
  });

  it("keeps the note on a mid-stream refusal while still dropping the hint", () => {
    // The assertion that stops the two props being merged back together: the
    // gate is about what a *guess* can be true of, and a note is not a guess.
    render(
      <LogRefusal
        reason="No longer authorized"
        code={LEASE_CLOSE_CODE}
        hint={HINT}
        note={NOTE}
      />,
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain(NOTE);
    expect(said).toContain("authorized when it opened and is not any more");
    expect(said).not.toContain(HINT);
  });
});
