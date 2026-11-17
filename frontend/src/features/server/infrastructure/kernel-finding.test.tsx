import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeInfo } from "@/lib/api/endpoints/settings";

import { kernelFindings } from "./kernel-finding";

afterEach(cleanup);

/** The two readings the finding is made of; the rest of the payload is not read. */
function info(
  observed: string | null,
  mongoRefusesKernel: boolean | null,
): RuntimeInfo {
  return {
    kernel: { declared: null, observed, scope: "host", drift: false },
    mongoRefusesKernel,
  } as unknown as RuntimeInfo;
}

describe("kernelFindings", () => {
  it("warns that MongoDB 8 will not start on a kernel it refuses, and how to update it", () => {
    const [finding] = kernelFindings(info("7.0.12", true));

    expect(finding.title).toBe("Kernel");
    expect(finding.reading).toBe("Linux 7.0.12");
    expect(finding.tone).toBe("warn");
    render(<p>{finding.fix}</p>);
    expect(document.body.textContent).toContain(
      "MongoDB 8 will not start on this kernel, Linux 7.0.12",
    );
    expect(document.body.textContent).toContain(
      "sudo apt update && sudo apt full-upgrade",
    );
  });

  it("reads a kernel MongoDB 8 starts on as fine, with nothing to do", () => {
    expect(kernelFindings(info("7.0.14", false))).toEqual([
      { title: "Kernel", reading: "Linux 7.0.14", tone: "ok", fix: undefined },
    ]);
  });

  it("adds no row for a kernel that was not read", () => {
    expect(kernelFindings(undefined)).toEqual([]);
    expect(kernelFindings(info(null, null))).toEqual([]);
  });
});
