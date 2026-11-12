import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api-error";
import { api } from "./client";
import { errorMessage } from "./error-message";

/**
 * The client stamps the request's method on the refusal, which is what
 * lets `errorMessage()` tell a failed read from a failed mutation.
 */
describe("api, on a 5xx", () => {
  afterEach(() => vi.unstubAllGlobals());

  function answer500() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  it("carries GET on a failed read, which reads as nothing having happened", async () => {
    answer500();
    const error = await api.get("/anything").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).method).toBe("GET");
    expect(errorMessage(error)).not.toMatch(/may have happened/);
  });

  it("carries POST on a failed mutation, which keeps the partial-change sentence", async () => {
    answer500();
    const error = await api.post("/anything").catch((e: unknown) => e);
    expect((error as ApiError).method).toBe("POST");
    expect(errorMessage(error)).toMatch(/part of it may have happened first/);
  });
});
