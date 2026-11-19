import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServedCertificate } from "@/lib/api/endpoints/domains";

const servedCertificate = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<ServedCertificate>>(),
);

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/api/endpoints/domains", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/domains")>();
  return {
    ...actual,
    domainsApi: { ...actual.domainsApi, servedCertificate },
  };
});

const {
  CERTIFICATE_PATIENCE_MS,
  CERTIFICATE_POLL_MS,
  servedCertificateState,
  useServedCertificate,
} = await import("./use-served-certificate");

const DEFAULT_CERT: ServedCertificate = {
  valid: false,
  issuer: "TRAEFIK DEFAULT CERT",
  notAfter: "2027-11-19T00:00:00.000Z",
};
const ISSUED: ServedCertificate = {
  valid: true,
  issuer: "Let's Encrypt",
  notAfter: "2027-02-17T12:00:00.000Z",
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

/** Lets the timers and the promises they start both run. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  servedCertificate.mockReset();
  focusManager.setFocused(undefined);
});

describe("servedCertificateState", () => {
  it("is issuing while what is served is not trusted, and not issued past the wait", () => {
    expect(servedCertificateState(undefined, false)).toEqual({
      state: "reading",
    });
    expect(servedCertificateState(DEFAULT_CERT, false)).toEqual({
      state: "issuing",
    });
    expect(servedCertificateState(DEFAULT_CERT, true)).toEqual({
      state: "not-issued",
    });
    expect(servedCertificateState(ISSUED, true)).toEqual({
      state: "issued",
      issuer: "Let's Encrypt",
      notAfter: "2027-02-17T12:00:00.000Z",
    });
  });
});

describe("useServedCertificate", () => {
  it("reads again while issuing, and stops once the certificate is issued", async () => {
    servedCertificate
      .mockResolvedValueOnce(DEFAULT_CERT)
      .mockResolvedValueOnce(DEFAULT_CERT)
      .mockResolvedValue(ISSUED);
    const { result } = renderHook(() => useServedCertificate("dom-1"), {
      wrapper,
    });

    await wait(0);
    expect(result.current).toEqual({ state: "issuing" });
    await wait(CERTIFICATE_POLL_MS * 3);
    expect(result.current.state).toBe("issued");
    const calls = servedCertificate.mock.calls.length;

    await wait(CERTIFICATE_POLL_MS * 5);
    expect(servedCertificate).toHaveBeenCalledTimes(calls);
  });

  it("stops reading while the tab is hidden", async () => {
    servedCertificate.mockResolvedValue(DEFAULT_CERT);
    renderHook(() => useServedCertificate("dom-1"), { wrapper });
    await wait(0);
    expect(servedCertificate).toHaveBeenCalledTimes(1);

    act(() => focusManager.setFocused(false));
    await wait(CERTIFICATE_POLL_MS * 5);

    expect(servedCertificate).toHaveBeenCalledTimes(1);
  });

  it("calls it not issued, and stops, after the wait", async () => {
    servedCertificate.mockResolvedValue(DEFAULT_CERT);
    const { result } = renderHook(() => useServedCertificate("dom-1"), {
      wrapper,
    });

    await wait(CERTIFICATE_PATIENCE_MS + CERTIFICATE_POLL_MS * 2);
    expect(result.current).toEqual({ state: "not-issued" });
    const calls = servedCertificate.mock.calls.length;

    await wait(CERTIFICATE_POLL_MS * 5);
    expect(servedCertificate).toHaveBeenCalledTimes(calls);
  });

  it("reads an old Domain's certificate once, never as issuing", async () => {
    servedCertificate.mockResolvedValue(DEFAULT_CERT);
    const { result } = renderHook(
      () =>
        useServedCertificate("dom-1", {
          since: Date.now() - CERTIFICATE_PATIENCE_MS * 10,
        }),
      { wrapper },
    );

    await wait(CERTIFICATE_POLL_MS * 5);
    expect(result.current).toEqual({ state: "not-issued" });
    expect(servedCertificate).toHaveBeenCalledTimes(1);
  });
});
