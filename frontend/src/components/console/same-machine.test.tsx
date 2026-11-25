import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({
  data: "self-hosted" as "hosted" | "self-hosted" | undefined,
}));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));

const { SameMachineNote } = await import("./same-machine");

beforeEach(() => {
  mode.data = "self-hosted";
});

afterEach(cleanup);

describe("SameMachineNote", () => {
  it("says what is lost with the machine, as one note", () => {
    render(<SameMachineNote />);
    const note = document.querySelector('[role="note"]');

    expect(note?.textContent).toBe(
      "Cloudgate itself runs on this machine. If the machine is lost, this Service and all of Cloudgate's records go with it: Projects, Servers, settings and Deployment history. Add a Server or use Cloudgate Hosted to keep them apart.",
    );
  });

  it("links Add a Server to the Servers page", () => {
    render(<SameMachineNote />);

    const link = screen.getByRole("link", { name: "Add a Server" });
    expect(link.getAttribute("href")).toBe("/servers");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("opens Cloudgate Hosted in a new tab", () => {
    render(<SameMachineNote />);

    const link = screen.getByRole("link", { name: "Cloudgate Hosted" });
    expect(link.getAttribute("href")).toBe("https://cloudgate.octabyte.app");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders nothing on the Hosted instance", () => {
    mode.data = "hosted";
    const { container } = render(<SameMachineNote />);

    expect(container.textContent).toBe("");
  });

  it("renders nothing while the instance mode is still loading", () => {
    mode.data = undefined;
    const { container } = render(<SameMachineNote />);

    expect(container.textContent).toBe("");
  });
});
