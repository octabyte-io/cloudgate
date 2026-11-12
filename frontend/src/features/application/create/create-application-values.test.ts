import { describe, expect, it } from "vitest";

import {
  createApplicationSchema,
  toCreateApplicationInput,
} from "./create-application-values";

/**
 * The fold from the create form into `POST /applications`.
 *
 * Every assertion here is about a **blank** field, because that is the only
 * thing this fold decides: the backend's `createApplicationSchema` marks
 * `description` and `serverId` optional, and an optional key sent as `""` is not
 * the same request as one left out — the first stores an empty description and
 * an unresolvable Server id, the second stores neither.
 */
describe("createApplicationSchema", () => {
  it("refuses a name that is only whitespace", () => {
    const result = createApplicationSchema.safeParse({
      name: "   ",
      description: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("An Application needs a name.");
  });

  it("trims the name it accepts", () => {
    const result = createApplicationSchema.safeParse({
      name: "  Storefront web  ",
      description: "",
    });
    expect(result.success).toBe(true);
    expect(result.data?.name).toBe("Storefront web");
  });
});

describe("toCreateApplicationInput", () => {
  it("omits a blank description, and sends this Cloudgate host as null", () => {
    const input = toCreateApplicationInput(
      { name: "Storefront web", description: "   " },
      "env_1",
      null,
    );

    // Left out, `serverId` would be the Deploy target's Server, not the host
    // the picker showed.
    expect(input).toEqual({
      name: "Storefront web",
      environmentId: "env_1",
      serverId: null,
    });
    expect("description" in input).toBe(false);
  });

  it("sends the description and the Server when they were given", () => {
    const input = toCreateApplicationInput(
      { name: "  Storefront web  ", description: "  The storefront  " },
      "env_1",
      "srv_9",
    );

    expect(input).toEqual({
      name: "Storefront web",
      description: "The storefront",
      environmentId: "env_1",
      serverId: "srv_9",
    });
  });

  it("leaves serverId out when nothing was chosen in a cloud Environment", () => {
    const input = toCreateApplicationInput(
      { name: "Storefront web", description: "" },
      "env_1",
      undefined,
    );

    expect("serverId" in input).toBe(false);
  });

  it("never sends an appName — the backend generates the immutable one", () => {
    const input = toCreateApplicationInput(
      { name: "Storefront web", description: "" },
      "env_1",
      null,
    );

    expect("appName" in input).toBe(false);
  });
});
