import { describe, expect, it } from "vitest";

import {
  cloudOf,
  deployTargetOptions,
  fromPickerValue,
  regionOptions,
  toPickerValue,
} from "./deploy-target";

/** A cloud Deploy target through the Picker and back. */
describe("deploy target picker values", () => {
  it("round-trips a Cloud account and its region", () => {
    const target = {
      kind: "cloud" as const,
      cloudAccountId: "ca_1",
      region: "eu-west-1",
    };

    expect(fromPickerValue(toPickerValue(target), "eu-west-1")).toEqual(target);
  });

  it("has no target for a Cloud account with no region yet", () => {
    expect(fromPickerValue("cloud:ca_1", "")).toBeNull();
  });

  it("still reads a Server and the platform host", () => {
    expect(fromPickerValue("srv_1")).toEqual({
      kind: "server",
      serverId: "srv_1",
    });
    expect(fromPickerValue("platform-host")).toEqual({ kind: "platform-host" });
  });

  it("lists Cloud accounts after the Servers", () => {
    const options = deployTargetOptions(
      [
        {
          serverId: "srv_1",
          name: "worker-1",
          ipAddress: "10.0.0.5",
          serverType: "deploy",
        },
      ] as never,
      [
        { cloudAccountId: "ca_1", name: "Production AWS", cloudId: "1234" },
      ] as never,
    );

    expect(options.map((option) => option.value)).toEqual([
      "platform-host",
      "srv_1",
      "cloud:ca_1",
    ]);
    expect(options[2]).toMatchObject({
      label: "Production AWS",
      detail: "AWS 1234",
    });
  });

  it("greys out a Bought Server that is not Ready, saying why, and keeps a Ready one choosable", () => {
    const options = deployTargetOptions(
      [
        {
          serverId: "srv_1",
          name: "bought-1",
          ipAddress: "203.0.113.20",
          serverType: "deploy",
          boughtServer: {
            stage: "setting_up",
            deletesOn: null,
            deletedAt: null,
          },
        },
        {
          serverId: "srv_2",
          name: "bought-2",
          ipAddress: "203.0.113.21",
          serverType: "deploy",
          boughtServer: { stage: "ready", deletesOn: null, deletedAt: null },
        },
        {
          serverId: "srv_3",
          name: "own-1",
          ipAddress: "10.0.0.5",
          serverType: "deploy",
          boughtServer: null,
        },
      ] as never,
      [],
      { platformHost: false },
    );

    expect(options).toEqual([
      {
        value: "srv_1",
        label: "bought-1",
        detail: "Setting up",
        disabled: true,
      },
      {
        value: "srv_2",
        label: "bought-2",
        detail: "203.0.113.21",
        disabled: false,
      },
      { value: "srv_3", label: "own-1", detail: "10.0.0.5", disabled: false },
    ]);
  });

  it("leaves the platform host out on the Hosted instance", () => {
    const options = deployTargetOptions(
      [{ serverId: "srv_1", name: "worker-1", serverType: "deploy" }] as never,
      [
        { cloudAccountId: "ca_1", name: "Production AWS", cloudId: "1234" },
      ] as never,
      { platformHost: false },
    );

    expect(options.map((option) => option.value)).toEqual([
      "srv_1",
      "cloud:ca_1",
    ]);
  });

  it("names a Google Cloud account's cloud and project", () => {
    const options = deployTargetOptions([], [
      {
        cloudAccountId: "ca_2",
        name: "Production Google",
        cloud: "gcp",
        cloudId: "shop-prod",
      },
    ] as never);

    expect(options[1]).toMatchObject({
      value: "cloud:ca_2",
      label: "Production Google",
      detail: "Google Cloud shop-prod",
    });
  });

  it("offers each cloud its own regions", () => {
    const aws = regionOptions("aws").map((option) => option.value);
    const google = regionOptions("gcp").map((option) => option.value);

    expect(aws).toContain("eu-west-1");
    expect(aws).not.toContain("europe-west1");
    expect(google).toContain("europe-west1");
    expect(google).toContain("us-central1");
    expect(google).not.toContain("eu-west-1");
  });

  it("reads a Cloud account's cloud from the list, or from its saved region when it cannot be listed", () => {
    const google = [{ cloudAccountId: "ca_2", cloud: "gcp" }] as never;

    expect(cloudOf("cloud:ca_2", google, "")).toBe("gcp");
    expect(cloudOf("cloud:ca_9", [], "europe-west1")).toBe("gcp");
    expect(cloudOf("cloud:ca_9", [], "eu-west-1")).toBe("aws");
  });
});
