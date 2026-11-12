import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const sonner = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock("sonner", () => ({ toast: sonner }));

const { toast } = await import("./toast");

afterEach(() => {
  sonner.error.mockReset();
  vi.restoreAllMocks();
});

const refused = (fileUrl: string | null) =>
  new ApiError(409, "web-shop's command is set by the Project config", {
    code: "PROJECT_CONFIG_REPOSITORY_KEPT",
    pointer: {
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "main",
      fileUrl,
    },
  });

/** US56: a refusal a repository-kept config made links to the file. */
describe("toast.error", () => {
  it("offers the file a repository-kept config's refusal points at", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    toast.error(
      refused("https://github.com/acme/shop/blob/c0ffee1/cloudgate.yaml"),
    );

    const [, options] = sonner.error.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(options.action.label).toBe("Open the file");
    options.action.onClick();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/shop/blob/c0ffee1/cloudgate.yaml",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("offers nothing when the file could not be read, or the caller gave its own control", () => {
    toast.error(refused(null));
    expect(sonner.error.mock.calls[0][1]).toBeUndefined();

    const own = { label: "Retry", onClick: () => undefined };
    toast.error(refused("https://example.test/file"), { action: own });
    expect(sonner.error.mock.calls[1][1]).toEqual({ action: own });
  });
});
