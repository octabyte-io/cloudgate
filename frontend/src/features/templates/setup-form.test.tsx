import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { SetupForm } from "@/lib/api/endpoints/templates";

import { newProjectTargets } from "./new-project-targets";
import { EMPTY_PROJECT_NOTE, SetupFormView } from "./setup-form";

afterEach(cleanup);

const FORM: SetupForm = {
  templateId: "ghost",
  templateName: "Ghost",
  revision: "abc1234",
  setupName: "ghost",
  asked: [
    {
      name: "ADMIN_EMAIL",
      label: "Admin email",
      description: "Where Ghost sends the admin invite.",
      default: null,
      required: true,
      secret: false,
      format: "email",
      pattern: null,
    },
    {
      name: "SITE_CODE",
      label: "Site code",
      description: null,
      default: null,
      required: false,
      secret: false,
      format: null,
      pattern: "[A-Z]{4}",
    },
  ],
  environments: [
    {
      environmentId: "env-gcp",
      name: "cloud",
      canTake: false,
      reason:
        "It ships a config file for app, and a Service in a Cloud account has no container to mount it in",
      hosts: null,
      cloudDomains: null,
    },
    {
      environmentId: "env-prod",
      name: "production",
      canTake: true,
      reason: null,
      hosts: null,
      cloudDomains: null,
    },
  ],
  domains: [],
  deployTargets: { server: null, platformHost: null, aws: null, gcp: null },
};

/** The same template with a compose Domain, on two Environments. */
const STACKED: SetupForm = {
  ...FORM,
  asked: [],
  domains: [{ name: "ghost", service: "ghost", port: 2368, path: "/" }],
  environments: [
    {
      environmentId: "env-prod",
      name: "production",
      canTake: true,
      reason: null,
      hosts: { ghost: "ghost-ghost-1a2b3c-198-51-100-7.sslip.io" },
      cloudDomains: null,
    },
    {
      environmentId: "env-bare",
      name: "bare",
      canTake: true,
      reason: null,
      hosts: null,
      cloudDomains: null,
    },
  ],
};

function renderForm(onSubmit = vi.fn(), form = FORM) {
  render(<SetupFormView form={form} onSubmit={onSubmit} />);
  return onSubmit;
}

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: /Set up and review/ }));

describe("SetupFormView", () => {
  it("greys out an Environment that cannot take the template, with its reason, and picks the first that can", async () => {
    renderForm();

    const cloud = screen.getByRole("radio", { name: /cloud/ });
    expect((cloud as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "It ships a config file for app, and a Service in a Cloud account has no container to mount it in",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: /production/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("checks each asked value and the setup name before submitting anything", async () => {
    const onSubmit = renderForm();

    fireEvent.change(screen.getByLabelText("Admin email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByLabelText(/Site code/), {
      target: { value: "abcd" },
    });
    fireEvent.change(screen.getByLabelText("Setup name"), {
      target: { value: "My Blog" },
    });
    submit();

    expect(
      await screen.findByText("Admin email must be an email address"),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Site code must match [A-Z]{4}")).toBeTruthy();
    expect(
      screen.getByText(
        "Use lowercase letters, digits and hyphens, starting with a letter",
      ),
    ).toBeTruthy();
  });

  it("submits the Environment, the setup name and the values given, leaving an empty optional one out", async () => {
    const onSubmit = renderForm();

    fireEvent.change(screen.getByLabelText("Admin email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Setup name"), {
      target: { value: "blog" },
    });
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      environmentId: "env-prod",
      setupName: "blog",
      values: { ADMIN_EMAIL: "ada@example.com" },
    });
  });

  it("posts, so a submit before hydration never puts a value in the address bar", async () => {
    renderForm();

    expect(
      screen.getByRole("form", { name: "Set up Ghost" }).getAttribute("method"),
    ).toBe("post");
  });

  it("says why the setup was refused when no field is to blame", async () => {
    renderForm(
      vi
        .fn()
        .mockRejectedValue(
          new ApiError(
            400,
            "The Config name ghost-app is held by another Pending setup",
            { code: "TEMPLATE_SETUP_REFUSED" },
          ),
        ),
    );

    fireEvent.change(screen.getByLabelText("Admin email"), {
      target: { value: "ada@example.com" },
    });
    submit();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The Config name ghost-app is held by another Pending setup",
    );
  });

  it("puts a refusal that names the setup name beside it", async () => {
    renderForm(
      vi.fn().mockRejectedValue(
        new ApiError(400, "Validation failed", {
          issues: [{ path: "setupName", message: "setupName cannot be empty" }],
        }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Admin email"), {
      target: { value: "ada@example.com" },
    });
    submit();

    expect(await screen.findByText("Setup name cannot be empty.")).toBeTruthy();
    expect(
      screen.getByLabelText("Setup name").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  describe("for a new Project", () => {
    const COMPOSE =
      "It ships a config file for app, and a Service in a Cloud account has no container to mount it in";
    const TARGETS = newProjectTargets(
      [
        {
          serverId: "srv-1",
          name: "edge-1",
          ipAddress: "203.0.113.4",
          serverType: "deploy",
        },
      ] as never,
      [
        {
          cloudAccountId: "ca-1",
          name: "Production AWS",
          cloud: "aws",
          cloudId: "123456789012",
        },
      ] as never,
      { server: null, platformHost: null, aws: COMPOSE, gcp: COMPOSE },
      { platformHost: true },
    );

    function renderNew(onSubmit = vi.fn(), targets = TARGETS) {
      render(
        <SetupFormView
          form={{ ...FORM, environments: [] }}
          newProject={{ targets }}
          onSubmit={onSubmit}
        />,
      );
      return onSubmit;
    }

    it("asks the Project's name and a Deploy target in place of an Environment, greying out one that cannot take the template", async () => {
      renderNew();

      expect(screen.queryByRole("radio", { name: /production/ })).toBeNull();
      expect(screen.getByLabelText("Project name")).toBeTruthy();
      expect(
        (
          screen.getByRole("radio", {
            name: /This Cloudgate host/,
          }) as HTMLInputElement
        ).checked,
      ).toBe(true);
      expect(
        (screen.getByRole("radio", { name: /edge-1/ }) as HTMLInputElement)
          .disabled,
      ).toBe(false);
      expect(
        (
          screen.getByRole("radio", {
            name: /Production AWS/,
          }) as HTMLInputElement
        ).disabled,
      ).toBe(true);
      expect(screen.getByText(COMPOSE)).toBeTruthy();
    });

    it("links to the get-started wizard for this template when there is nowhere to deploy", () => {
      renderNew(vi.fn(), []);

      expect(
        screen.getByText(/has no Server or Cloud account to deploy to yet/),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Get a server for this app" })
          .getAttribute("href"),
      ).toBe("/get-started?template=ghost");
    });

    it("says that dismissing the Plan leaves an empty Project", async () => {
      renderNew();

      expect(screen.getByText(EMPTY_PROJECT_NOTE)).toBeTruthy();
      expect(EMPTY_PROJECT_NOTE).toMatch(/Dismissing the Plan leaves/);
    });

    it("submits the new Project's name and Deploy target with the values", async () => {
      const onSubmit = renderNew();

      fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: " blog " },
      });
      fireEvent.click(screen.getByRole("radio", { name: /edge-1/ }));
      fireEvent.change(screen.getByLabelText("Admin email"), {
        target: { value: "ada@example.com" },
      });
      submit();

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit).toHaveBeenCalledWith({
        newProject: {
          name: "blog",
          deployTarget: { kind: "server", serverId: "srv-1" },
        },
        setupName: "ghost",
        values: { ADMIN_EMAIL: "ada@example.com" },
      });
    });

    it("refuses a Submit with no Project name, and asks a Cloud account's region", async () => {
      const onSubmit = renderNew(
        vi.fn(),
        TARGETS.map((target) => ({ ...target, reason: null })),
      );

      fireEvent.click(screen.getByRole("radio", { name: /Production AWS/ }));
      fireEvent.change(screen.getByLabelText("Admin email"), {
        target: { value: "ada@example.com" },
      });
      submit();

      expect(await screen.findByText("A Project needs a name.")).toBeTruthy();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText("Choose the region")).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: "blog" },
      });
      fireEvent.change(screen.getByLabelText(/AWS region/), {
        target: { value: "eu-central-1" },
      });
      submit();

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          newProject: {
            name: "blog",
            deployTarget: {
              kind: "cloud",
              cloudAccountId: "ca-1",
              region: "eu-central-1",
            },
          },
        }),
      );
    });
  });

  it("puts a refusal of a new Project's name under Project name", async () => {
    render(
      <SetupFormView
        form={{ ...FORM, asked: [], environments: [] }}
        newProject={{
          targets: newProjectTargets(
            [],
            [],
            { server: null, platformHost: null, aws: null, gcp: null },
            { platformHost: true },
          ),
        }}
        onSubmit={vi.fn().mockRejectedValue(
          new ApiError(400, "Validation failed", {
            issues: [
              { path: "newProject.name", message: "name cannot be empty" },
            ],
          }),
        )}
      />,
    );

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "blog" },
    });
    submit();

    expect(
      await screen.findByText("Project name cannot be empty."),
    ).toBeTruthy();
  });

  it("starts each compose Domain on the Environment's generated host, which may be replaced", async () => {
    const onSubmit = renderForm(vi.fn(), STACKED);

    const host = screen.getByLabelText(/Host of ghost/) as HTMLInputElement;
    expect(host.value).toBe("ghost-ghost-1a2b3c-198-51-100-7.sslip.io");
    fireEvent.change(host, { target: { value: "blog.example.com" } });
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      environmentId: "env-prod",
      setupName: "ghost",
      values: {},
      hosts: { ghost: "blog.example.com" },
    });
  });

  it("asks for a host where the Environment generates none", async () => {
    const onSubmit = renderForm(vi.fn(), STACKED);

    fireEvent.click(screen.getByRole("radio", { name: /bare/ }));
    expect(
      (screen.getByLabelText(/Host of ghost/) as HTMLInputElement).value,
    ).toBe("");
    submit();

    expect(await screen.findByText("Give this Domain a host")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe("in a Cloud Environment (#1379)", () => {
    const CLOUD: SetupForm = {
      ...STACKED,
      environments: [
        {
          environmentId: "env-aws",
          name: "aws",
          canTake: true,
          reason: null,
          hosts: null,
          cloudDomains: {
            pointsAt: {
              dnsName: "cg-1234567890.eu-central-1.elb.amazonaws.com",
              kind: "load-balancer",
            },
          },
        },
        {
          environmentId: "env-gcp",
          name: "gcp",
          canTake: true,
          reason: null,
          hosts: null,
          cloudDomains: { pointsAt: null },
        },
      ],
    };

    it("asks for each host with no prefill, and shows the record pointing it at the network's load balancer", async () => {
      const onSubmit = renderForm(vi.fn(), CLOUD);

      const host = screen.getByLabelText(/Host of ghost/) as HTMLInputElement;
      expect(host.value).toBe("");
      expect(screen.getByText(/a Stack VM has no generated host/)).toBeTruthy();
      fireEvent.change(host, { target: { value: "blog.example.com" } });
      expect(
        screen.getByText(
          "blog.example.com CNAME cg-1234567890.eu-central-1.elb.amazonaws.com",
        ),
      ).toBeTruthy();
      submit();

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit).toHaveBeenCalledWith({
        environmentId: "env-aws",
        setupName: "ghost",
        values: {},
        hosts: { ghost: "blog.example.com" },
      });
    });

    it("names an ALIAS for a bare name, and the load balancer the Plan makes while there is no network", async () => {
      renderForm(vi.fn(), CLOUD);

      fireEvent.click(screen.getByRole("radio", { name: /gcp/ }));
      fireEvent.change(screen.getByLabelText(/Host of ghost/), {
        target: { value: "example.com" },
      });

      expect(
        screen.getByText(
          "example.com ALIAS the Environment network's load balancer, which this setup's Plan makes",
        ),
      ).toBeTruthy();
    });
  });
});
