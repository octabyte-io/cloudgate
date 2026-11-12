import { describe, expect, it } from "vitest";

import { readWizard, stepOf, wizardHref } from "./wizard-state";

const read = (search: string) => readWizard(new URLSearchParams(search));

describe("readWizard", () => {
  it("reads every part of the wizard out of its query", () => {
    expect(
      read(
        "template=ghost&path=buy&server=srv_1&step=deploy&env=env_1&checkout=success",
      ),
    ).toEqual({
      templateId: "ghost",
      path: "buy",
      serverId: "srv_1",
      deploying: true,
      environmentId: "env_1",
      checkout: "success",
    });
  });

  it("reads an unknown path, step or checkout outcome as absent", () => {
    expect(read("template=ghost&path=cloud&step=pay&checkout=maybe")).toEqual({
      templateId: "ghost",
      path: null,
      serverId: null,
      deploying: false,
      environmentId: null,
      checkout: null,
    });
  });

  it("reads a blank template as no template", () => {
    expect(read("template=%20").templateId).toBeNull();
  });
});

describe("wizardHref", () => {
  it("writes the wizard back as its own address, in a fixed order", () => {
    expect(
      wizardHref({
        templateId: "ghost",
        path: "own",
        serverId: "srv_1",
        deploying: true,
      }),
    ).toBe("/get-started?template=ghost&path=own&server=srv_1&step=deploy");
  });

  it("is a same-origin path the returnTo rule accepts", () => {
    const href = wizardHref({ templateId: "ghost", path: "buy" });

    expect(href.startsWith("/")).toBe(true);
    expect(href[1]).not.toBe("/");
    expect(href).not.toMatch(/\s/);
  });

  it("round-trips through readWizard", () => {
    const state = {
      templateId: "uptime-kuma",
      path: "buy" as const,
      serverId: "srv_9",
      deploying: false,
      environmentId: "env_2",
    };
    const query = wizardHref(state).split("?")[1];

    expect(readWizard(new URLSearchParams(query))).toEqual({
      ...state,
      checkout: null,
    });
  });

  it("encodes an id that holds a reserved character", () => {
    expect(wizardHref({ templateId: "a&b" })).toBe(
      "/get-started?template=a%26b",
    );
  });
});

describe("stepOf", () => {
  it("is the server step until a server is chosen for the details", () => {
    expect(stepOf(read("template=ghost&path=buy"))).toBe("server");
    expect(stepOf(read("template=ghost&step=deploy"))).toBe("server");
  });

  it("is the details step once a server is chosen", () => {
    expect(stepOf(read("template=ghost&server=srv_1&step=deploy"))).toBe(
      "details",
    );
  });

  it("is the launch step once the setup names its Environment", () => {
    expect(stepOf(read("template=ghost&server=srv_1&env=env_1"))).toBe(
      "launch",
    );
  });
});
