import type { UseQueryResult } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { ServerAudit } from "@/lib/api/endpoints/servers";

import { FindingList } from "./finding-list";

afterEach(cleanup);

function failing(error: ApiError): string {
  const query = {
    data: undefined,
    error,
    isFetching: false,
    refetch: async () => undefined,
  } as unknown as UseQueryResult<ServerAudit>;
  render(
    <FindingList title="What is installed" query={query} findings={() => []} />,
  );
  return document.body.textContent ?? "";
}

/**
 * The audit now answers 503 `HOST_UNREACHABLE` for a Server it could not
 * reach and a 400 naming the key for one that refused it. The card's closing
 * line said the failure "is about reaching the machine" for both — false for the
 * second, where the Server was reached and turned the key away.
 */
describe("FindingList", () => {
  it("says the failure is about reaching the Server when it was not reached", () => {
    const text = failing(
      new ApiError(503, "This Server could not be reached", {
        code: "HOST_UNREACHABLE",
      }),
    );
    expect(text).toContain("Cloudgate could not reach that Server");
    expect(text).toContain("about reaching the Server");
  });

  it("does not claim a reaching problem when the Server refused the key", () => {
    const text = failing(
      new ApiError(
        400,
        'The SSH key "ui-paste" was not accepted by this Server. Add its public half to ~/.ssh/authorized_keys for root on the Server, or choose another key on the Access tab',
      ),
    );
    expect(text).toContain(
      'The SSH key "ui-paste" was not accepted by this Server',
    );
    expect(text).not.toMatch(/reaching/);
    expect(text).toContain("Nothing here has been ruled out.");
  });
});
