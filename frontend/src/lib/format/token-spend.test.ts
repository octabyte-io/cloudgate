import { describe, expect, it } from "vitest";

import type { SpendFigures } from "@/lib/api/endpoints/token-spend";

import { spendFact } from "./token-spend";

const figures = (
  prompt: [number, number],
  completion: [number, number],
): SpendFigures => ({
  promptTokens: { reported: prompt[0], estimated: prompt[1] },
  completionTokens: { reported: completion[0], estimated: completion[1] },
  calls: { ok: 0, runtimeError: 0, clientAborted: 0, refused: 0 },
});

describe("spendFact", () => {
  it("reads every token, prompt and completion, reported and estimated", () => {
    expect(spendFact(figures([1200, 30], [100, 4]))).toEqual({
      value: "1,334 tokens",
      title:
        "1,300 reported by the inference runtime, 34 estimated by the Gateway",
    });
  });

  it("says nothing of an estimate when there is none", () => {
    expect(spendFact(figures([0, 0], [0, 0]))).toEqual({
      value: "0 tokens",
      title: "0 reported by the inference runtime",
    });
  });
});
