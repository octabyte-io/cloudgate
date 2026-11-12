import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

import { dockerApi } from "./docker";

/**
 * `GET /docker/containers` answers 200 with **no body** when docker would not
 * say, which `api.get` reads as `undefined`. TanStack Query refuses `undefined`
 * as query data, and three queries share the one cache key, so a caller that
 * forgot to map it put "an error it does not recognise" on `/monitoring`.
 * The mapping now lives in the endpoint; this holds it there.
 */
describe("dockerApi.containers", () => {
  beforeEach(() => get.mockReset());

  it("resolves null, never undefined, when the route answers with no body", async () => {
    get.mockResolvedValue(undefined);
    await expect(dockerApi.containers(null)).resolves.toBeNull();
  });

  it("keeps an empty listing as an empty array, which means docker answered", async () => {
    get.mockResolvedValue([]);
    await expect(dockerApi.containers("srv")).resolves.toEqual([]);
  });

  it("sends no serverId for the machine Cloudgate runs on", async () => {
    get.mockResolvedValue([]);
    await dockerApi.containers(null);
    expect(get).toHaveBeenCalledWith("/docker/containers", {
      query: { serverId: undefined },
    });
  });
});
