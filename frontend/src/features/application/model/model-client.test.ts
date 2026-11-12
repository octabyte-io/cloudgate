import { describe, expect, it } from "vitest";

import type { Agent } from "@/lib/api/endpoints/agents";

import { callerGrant, callersOf, modelClientSnippet } from "./model-client";

const ENDPOINT = "https://cloud.example.test/ai/app-1/v1";

const agent = (overrides: Partial<Agent>): Agent => ({
  id: "u1",
  memberId: "m1",
  name: "chat-bot",
  role: "agentCaller",
  createdAt: "2026-10-01T00:00:00.000Z",
  accessedProjects: ["p1"],
  accessedEnvironments: ["e1"],
  accessedServices: ["app-1"],
  keys: [],
  suspended: false,
  createdBy: null,
  lastConnection: null,
  rateLimitedLastHour: 0,
  ...overrides,
});

describe("modelClientSnippet", () => {
  const text = modelClientSnippet(ENDPOINT, "smollm2:135m");

  it("points the OpenAI SDK at the endpoint, with the placeholder for the key", () => {
    expect(text).toContain('import OpenAI from "openai";');
    expect(text).toContain(`baseURL: "${ENDPOINT}"`);
    expect(text).toContain('apiKey: "<agent key>"');
  });

  it("names the model this AI model serves, which the gateway holds a call to", () => {
    expect(text).toContain('model: "smollm2:135m"');
  });
});

describe("callersOf", () => {
  it("lists exactly the caller Agents granted this AI model", () => {
    const agents = [
      agent({ id: "caller" }),
      agent({ id: "suspended", suspended: true }),
      agent({ id: "other-model", accessedServices: ["app-2"] }),
      agent({ id: "project-only", accessedServices: [] }),
      agent({ id: "reader", role: "agentReader" }),
      agent({ id: "operator", role: "agentOperator" }),
    ];
    expect(callersOf(agents, "app-1").map((a) => a.id)).toEqual([
      "caller",
      "suspended",
    ]);
  });
});

describe("callerGrant", () => {
  it("grants the AI model with the Environment and Project that reach it", () => {
    expect(
      callerGrant({
        applicationId: "app-1",
        environmentId: "e1",
        projectId: "p1",
      }),
    ).toEqual({ projects: ["p1"], environments: ["e1"], services: ["app-1"] });
  });
});
