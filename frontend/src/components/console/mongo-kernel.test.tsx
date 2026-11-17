import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MongoKernelNote, isMongo8Image } from "./mongo-kernel";

afterEach(cleanup);

describe("isMongo8Image", () => {
  it("reads the official mongo image at 8, untagged or latest as MongoDB 8", () => {
    for (const image of [
      "mongo:8",
      "mongo:8.0",
      "mongo:8.0.38",
      "mongo:8.2-noble",
      "mongo:8-noble",
      "mongo",
      "mongo:latest",
      "docker.io/library/mongo:8.0.38",
      "registry.example.com:5000/mongo:8@sha256:abc",
    ]) {
      expect(isMongo8Image(image), image).toBe(true);
    }
  });

  it("reads another major, or another image, as not MongoDB 8", () => {
    for (const image of [
      "mongo:7",
      "mongo:7.0.48",
      "mongo:6",
      "mongo:80",
      "mongo-express:1.0",
      "bitnami/mongodb:8.0",
      "ghost:5.96-alpine",
      "",
    ]) {
      expect(isMongo8Image(image), image).toBe(false);
    }
  });
});

describe("MongoKernelNote", () => {
  it("names the kernel, the range and the Ubuntu command, set as code", () => {
    render(<MongoKernelNote kernel="7.0.12" host="this Server" />);
    const note = document.querySelector('[role="note"]');

    expect(note?.textContent).toContain(
      "MongoDB 8 will not start on this Server's kernel, Linux 7.0.12",
    );
    expect(note?.textContent).toContain("6.19 to 7.0.13");
    expect(
      [...(note?.querySelectorAll("code") ?? [])].map(
        (code) => code.textContent,
      ),
    ).toEqual(["sudo apt update && sudo apt full-upgrade", "sudo reboot"]);
    // Nothing fenced in backticks nothing renders.
    expect(note?.textContent).not.toContain("`");
  });
});
