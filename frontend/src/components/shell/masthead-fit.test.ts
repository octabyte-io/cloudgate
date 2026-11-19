import { describe, expect, it } from "vitest";

import { wordmarkFits } from "./masthead-fit";

describe("wordmarkFits", () => {
  it("keeps the wordmark beside a name that fits whole", () => {
    // "Acme": the name's full width is within the room it has.
    expect(
      wordmarkFits({
        shown: true,
        nameWidth: 34,
        nameRoom: 120,
        wordWidth: 88,
      }),
    ).toBe(true);
  });

  it("drops the wordmark when the name beside it overflows", () => {
    // "My Organization" beside the full wordmark: about 40px short.
    expect(
      wordmarkFits({
        shown: true,
        nameWidth: 112,
        nameRoom: 72,
        wordWidth: 88,
      }),
    ).toBe(false);
  });

  it("keeps it dropped while bringing it back would overflow the name again", () => {
    // The room the dropped wordmark gave back is the name's now; it returns
    // only if the name fits with that much less.
    expect(
      wordmarkFits({
        shown: false,
        nameWidth: 112,
        nameRoom: 160,
        wordWidth: 88,
      }),
    ).toBe(false);
  });

  it("brings it back once the name fits beside it", () => {
    // Switched to "Acme".
    expect(
      wordmarkFits({
        shown: false,
        nameWidth: 34,
        nameRoom: 160,
        wordWidth: 88,
      }),
    ).toBe(true);
  });

  it("brings it back to be measured when its width was never read", () => {
    expect(
      wordmarkFits({
        shown: false,
        nameWidth: 400,
        nameRoom: 160,
        wordWidth: null,
      }),
    ).toBe(true);
  });
});
