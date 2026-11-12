import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Domain } from "@/lib/api/endpoints/domains";

import { StackVmDomainFormModal } from "./stack-vm-domain-modal";

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  options: {
    domain?: Domain | null;
    names?: string[] | undefined;
    google?: boolean;
  } = {},
) {
  const create = vi.fn(async () => ({}) as Domain);
  const update = vi.fn(async () => ({}) as Domain);
  render(
    <StackVmDomainFormModal
      domain={options.domain ?? null}
      google={options.google ?? false}
      services={{
        names: "names" in options ? options.names : ["web"],
        pending: false,
      }}
      open
      onOpenChange={() => {}}
      create={create}
      update={update}
    />,
  );
  return { create, update };
}

const field = (label: string) =>
  screen.getByLabelText(label, { exact: false }) as HTMLInputElement;

describe("StackVmDomainFormModal", () => {
  it("asks for a host of your own, and says a Stack VM has no generated host", () => {
    mount();
    const said = document.body.textContent ?? "";
    expect(said).toContain("A Stack VM has no generated host");
    expect(said).toContain("DNS records");
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
    expect(field("Host").value).toBe("");
  });

  it("asks which service the host reaches, and on which of its ports", () => {
    mount();
    expect(screen.getByText("Service")).toBeTruthy();
    expect(field("Port").value).toBe("3000");
    expect(document.body.textContent).toContain(
      "publishes it on the Stack VM at the same number",
    );
  });

  it("offers none of the fields only Traefik honours", () => {
    mount();
    const said = document.body.textContent ?? "";
    for (const traefikOnly of [
      "Strip path",
      "Internal path",
      "Middlewares",
      "Forward auth",
      "Let's Encrypt",
      "Entrypoint",
    ]) {
      expect(said).not.toContain(traefikOnly);
    }
  });

  it("adds the Domain with its host, path, service and port", async () => {
    const { create } = mount();
    fireEvent.change(field("Host"), {
      target: { value: " shop.example.com " },
    });
    fireEvent.change(field("Port"), { target: { value: "2368" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        host: "shop.example.com",
        path: "/",
        serviceName: "web",
        port: 2368,
      }),
    );
  });

  it("takes a typed service when the compose file could not be read", async () => {
    const { create } = mount({ names: undefined });
    fireEvent.change(field("Host"), { target: { value: "shop.example.com" } });
    fireEvent.change(field("Service"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: "api", port: 3000 }),
      ),
    );
  });

  it("says what is missing rather than sending a Domain with no host or service", async () => {
    const { create } = mount({ names: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect(
      await screen.findByText("Enter the host to serve this stack on."),
    ).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("names the record the host needs on each cloud", () => {
    mount({ google: true });
    expect(document.body.textContent).toContain(
      "An A record to the network's fixed IP",
    );
    cleanup();
    mount({ google: false });
    expect(document.body.textContent).toContain("never an A record");
  });

  it("posts its form, so a submit before hydration never puts the host in the address bar", () => {
    mount();
    const form = screen
      .getByRole("button", { name: "Add domain" })
      .closest("form");
    expect(form?.getAttribute("method")).toBe("post");
  });

  it("keeps its save button focusable while the save is in flight, saying it is busy", async () => {
    let finish: (domain: Domain) => void = () => {};
    const create = vi.fn(
      () => new Promise<Domain>((resolve) => (finish = resolve)),
    );
    render(
      <StackVmDomainFormModal
        domain={null}
        google={false}
        services={{ names: ["web"], pending: false }}
        open
        onOpenChange={() => {}}
        create={create}
        update={vi.fn()}
      />,
    );
    fireEvent.change(field("Host"), { target: { value: "shop.example.com" } });
    const button = screen.getByRole("button", { name: "Add domain" });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    finish({} as Domain);
  });

  it("edits a Domain, keeping its service and port", async () => {
    const { update } = mount({
      domain: {
        domainId: "d1",
        host: "shop.example.com",
        path: "/",
        serviceName: "web",
        port: 2368,
      } as unknown as Domain,
    });
    fireEvent.change(field("Host"), { target: { value: "www.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("d1", {
        host: "www.example.com",
        path: "/",
        serviceName: "web",
        port: 2368,
      }),
    );
    expect(document.body.textContent).toContain(
      "A new host needs a new certificate and new DNS records.",
    );
  });
});
