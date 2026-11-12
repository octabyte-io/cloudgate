import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Component } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { formatDay } from "@/lib/api/endpoints/billing";
import type { OperatorOrganization } from "@/lib/api/endpoints/operator";

const mode = vi.hoisted(() => ({
  current: { data: "hosted" as "hosted" | "self-hosted", isPending: false },
}));
const api = vi.hoisted(() => ({
  access: vi.fn(),
  organizations: vi.fn(),
  suspend: vi.fn(),
  lift: vi.fn(),
  setEnterprise: vi.fn(),
  // The Bought Servers section under the list; its own tests are
  // `bought-servers-section.test.tsx`.
  boughtServers: vi.fn(() =>
    Promise.resolve({
      exchangeRate: null,
      costsRead: true,
      marginFloorPercent: 10,
      servers: [],
    }),
  ),
  // Machines nothing owns, under it: `orphan-machines-section.test.tsx`.
  orphanMachines: vi.fn(() => Promise.resolve([])),
  boughtServerSettings: vi.fn(() =>
    Promise.resolve({
      markupPercent: 20,
      marginFloorPercent: 10,
      reverseDnsDomain: "servers.octabyte.test",
    }),
  ),
}));
// The abuse actions (#1401): the open reports between the two sections, and
// Forward abuse report on each row. The reports' own tests are
// `abuse-reports.test.tsx`.
const abuseApi = vi.hoisted(() => ({
  reports: vi.fn(() => Promise.resolve([])),
  forward: vi.fn(),
  close: vi.fn(),
  powerOff: vi.fn(),
  powerOn: vi.fn(),
}));
const invalidated = vi.hoisted(() => vi.fn());
const NOT_FOUND = "NEXT_NOT_FOUND";

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => mode.current,
}));
vi.mock("@/lib/api/endpoints/operator", () => ({ operatorApi: api }));
vi.mock("@/lib/api/endpoints/operator-abuse", () => ({
  operatorAbuseApi: abuseApi,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({
    operatorOrganizations: invalidated,
    operatorAbuseReports: invalidated,
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

const { OperatorSection } = await import("./operator-section");
const { useIsOperator } = await import("./use-operator");

afterEach(() => {
  cleanup();
  api.access.mockReset();
  api.organizations.mockReset();
  api.suspend.mockReset();
  api.lift.mockReset();
  api.setEnterprise.mockReset();
  abuseApi.forward.mockReset();
  invalidated.mockReset();
  mode.current = { data: "hosted", isPending: false };
});

const HOPPER: OperatorOrganization = {
  id: "org-hopper",
  name: "Hopper Labs",
  createdAt: "2026-10-01T09:00:00.000Z",
  ownerEmail: "grace@example.com",
  memberCount: 2,
  plan: "business",
  state: { kind: "payment-failing" },
  trialUsed: true,
  servers: { used: 2, allowed: 4 },
  cloudEnvironments: { used: 1, allowed: 4 },
  enterprise: false,
  suspension: null,
  paidBy: null,
  attached: [],
};

const WU: OperatorOrganization = {
  id: "org-wu",
  name: "Wu Contracting",
  createdAt: "2026-10-02T09:00:00.000Z",
  ownerEmail: "lin@example.com",
  memberCount: 1,
  plan: "enterprise",
  state: { kind: "suspended" },
  trialUsed: true,
  servers: { used: 0, allowed: 10 },
  cloudEnvironments: { used: 0, allowed: 5 },
  enterprise: true,
  suspension: {
    reason: "Crypto mining against the terms",
    suspendedAt: "2026-11-01T09:00:00.000Z",
  },
  paidBy: null,
  attached: [],
};

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Renders the section, catching the not-found the page throws for a non-Operator. */
function renderSection(): { notFound: () => boolean } {
  let thrown = false;
  class Boundary extends Component<
    { children: React.ReactNode },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error: Error) {
      if (error.message === NOT_FOUND) thrown = true;
    }
    render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <Boundary>
      <OperatorSection />
    </Boundary>,
    { wrapper },
  );
  return { notFound: () => thrown };
}

/**
 * The Operator page in the console (ADR-0050): only on the Hosted
 * instance and only for an Operator. Anybody else gets the not-found screen,
 * and a Self-hosted console never even asks.
 */
describe("OperatorSection", () => {
  it("lists every Organization's account facts for an Operator", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER, WU]);

    renderSection();

    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    const hopper = within(table).getByText("Hopper Labs").closest("tr");
    expect(hopper).not.toBeNull();
    const cells = within(hopper as HTMLElement);
    expect(cells.getByText("grace@example.com")).toBeDefined();
    expect(cells.getByText("Business")).toBeDefined();
    expect(cells.getByText("Payment failing")).toBeDefined();
    expect(cells.getByText("2 of 4")).toBeDefined();
    expect(cells.getByText("1 of 4")).toBeDefined();
    expect(cells.getByText("No")).toBeDefined();

    const wu = within(
      within(table).getByText("Wu Contracting").closest("tr") as HTMLElement,
    );
    expect(wu.getAllByText("Enterprise").length).toBeGreaterThan(0);
    expect(wu.getByText("0 of 10")).toBeDefined();
    // Trial used, and Enterprise.
    expect(wu.getAllByText("Yes")).toHaveLength(2);
  });

  it("is not found for a person who is not an Operator, and lists nothing", async () => {
    api.access.mockResolvedValue({ operator: false });

    const section = renderSection();

    await waitFor(() => expect(section.notFound()).toBe(true));
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it("is not found on a Self-hosted instance, without asking the backend anything", async () => {
    mode.current = { data: "self-hosted", isPending: false };

    const section = renderSection();

    await waitFor(() => expect(section.notFound()).toBe(true));
    expect(api.access).not.toHaveBeenCalled();
    expect(api.organizations).not.toHaveBeenCalled();
  });
});

describe("OperatorSection: Plan, State and Trial used", () => {
  const ENDS = "2026-12-05T09:00:00.000Z";
  const day = formatDay(ENDS);

  function org(
    name: string,
    fields: Partial<OperatorOrganization>,
  ): OperatorOrganization {
    return { ...HOPPER, id: `org-${name}`, name, ...fields };
  }

  it.each<[string, Partial<OperatorOrganization>, string, string, string]>([
    [
      "Fresh",
      { plan: null, state: { kind: "none" }, trialUsed: false },
      "None",
      "None",
      "No",
    ],
    [
      "Trialing",
      { state: { kind: "trial", endsAt: ENDS } },
      "Business",
      `Trial, ends ${day}`,
      "Yes",
    ],
    [
      "Paying",
      { plan: "starter", state: { kind: "paid" } },
      "Starter",
      "Paid",
      "Yes",
    ],
    [
      "Failing",
      { state: { kind: "payment-failing" } },
      "Business",
      "Payment failing",
      "Yes",
    ],
    [
      "Ending",
      { state: { kind: "ends", endsAt: ENDS } },
      "Business",
      `Ends on ${day}`,
      "Yes",
    ],
    [
      "Moving",
      { state: { kind: "moves-to-starter", on: ENDS } },
      "Business",
      `Moves to Starter on ${day}`,
      "Yes",
    ],
    [
      "Gone",
      { plan: null, state: { kind: "lapsed" } },
      "None",
      "Lapsed",
      "Yes",
    ],
  ])(
    "shows %s in plain words",
    async (name, fields, plan, state, trialUsed) => {
      api.access.mockResolvedValue({ operator: true });
      api.organizations.mockResolvedValue([org(name, fields)]);
      renderSection();

      const table = await screen.findByRole("table", {
        name: "Organizations on this instance",
      });
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent);
      const row = within(table).getByText(name).closest("tr") as HTMLElement;
      const cells = within(row).getAllByRole("cell");
      const cellUnder = (head: string) =>
        cells[headers.findIndex((text) => text?.startsWith(head))]?.textContent;
      expect(cellUnder("Plan")).toBe(plan);
      expect(cellUnder("State")).toBe(state);
      expect(cellUnder("Trial used")).toBe(trialUsed);
      expect(row.textContent).not.toMatch(/past_due|trialing|canceled/);
    },
  );
});

describe("OperatorSection: suspend and lift", () => {
  async function rowOf(name: string) {
    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    return within(within(table).getByText(name).closest("tr") as HTMLElement);
  }

  it("shows a suspension and its reason on the row", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER, WU]);
    renderSection();

    const wu = await rowOf("Wu Contracting");
    // The State, and the chip beside the reason.
    expect(wu.getAllByText("Suspended")).toHaveLength(2);
    expect(wu.getByText("Crypto mining against the terms")).toBeDefined();
    expect(wu.getByRole("button", { name: "Lift suspension" })).toBeDefined();
    const hopper = await rowOf("Hopper Labs");
    expect(hopper.getByText("None")).toBeDefined();
    expect(
      hopper.queryByRole("button", { name: "Lift suspension" }),
    ).toBeNull();
  });

  it("suspends with the reason typed, and asks for one first", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER, WU]);
    api.suspend.mockResolvedValue({
      reason: "Phishing pages",
      suspendedAt: "2026-11-04T09:00:00.000Z",
    });
    renderSection();

    fireEvent.click(
      (await rowOf("Hopper Labs")).getByRole("button", { name: "Suspend" }),
    );
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Suspend Organization",
    });
    fireEvent.click(confirm);
    expect(
      await within(dialog).findByText("Give the reason the customer will see"),
    ).toBeDefined();
    expect(api.suspend).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "  Phishing pages " },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(api.suspend).toHaveBeenCalledWith("org-hopper", "Phishing pages"),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it("shows the backend's refusal in the dialog", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER]);
    api.suspend.mockRejectedValue(
      new ApiError(409, "The Instance organization cannot be suspended"),
    );
    renderSection();

    fireEvent.click(
      (await rowOf("Hopper Labs")).getByRole("button", { name: "Suspend" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Abuse" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Suspend Organization" }),
    );

    expect(
      await within(dialog).findByText(
        /The Instance organization cannot be suspended/,
      ),
    ).toBeDefined();
  });

  it("lifts a suspension", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([WU]);
    api.lift.mockResolvedValue(undefined);
    renderSection();

    fireEvent.click(
      (await rowOf("Wu Contracting")).getByRole("button", {
        name: "Lift suspension",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Lift suspension" }),
    );

    await waitFor(() => expect(api.lift).toHaveBeenCalledWith("org-wu"));
  });
});

describe("OperatorSection: Forward abuse report", () => {
  async function rowOf(name: string) {
    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    return within(within(table).getByText(name).closest("tr") as HTMLElement);
  }

  it("forwards the report typed to the row's Organization, and asks for one first", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER]);
    abuseApi.forward.mockResolvedValue({});
    renderSection();

    fireEvent.click(
      (await rowOf("Hopper Labs")).getByRole("button", {
        name: "Forward abuse report",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("24 hours to answer");
    const confirm = within(dialog).getByRole("button", {
      name: "Forward report",
    });
    fireEvent.click(confirm);
    expect(
      await within(dialog).findByText(
        "Paste the report the customer should answer",
      ),
    ).toBeDefined();
    expect(abuseApi.forward).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Report/), {
      target: { value: " Port scan from your Server. " },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(abuseApi.forward).toHaveBeenCalledWith(
        "org-hopper",
        "Port scan from your Server.",
      ),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });
});

describe("OperatorSection: Enterprise and its counts", () => {
  async function openEnterprise(name: string) {
    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    const row = within(
      within(table).getByText(name).closest("tr") as HTMLElement,
    );
    fireEvent.click(row.getByRole("button", { name: "Enterprise" }));
    return screen.findByRole("dialog");
  }

  it("switches Enterprise on with the counts typed", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER]);
    api.setEnterprise.mockResolvedValue({
      enterprise: true,
      servers: 8,
      cloudEnvironments: 1,
    });
    renderSection();

    const dialog = await openEnterprise("Hopper Labs");
    const toggle = within(dialog).getByRole("switch", { name: /Enterprise/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(within(dialog).queryByLabelText("Servers")).toBeNull();

    fireEvent.click(toggle);
    const servers = within(dialog).getByLabelText("Servers");
    const clouds = within(dialog).getByLabelText("Cloud Environments");
    // Starts from what it already uses.
    expect((servers as HTMLInputElement).value).toBe("2");
    expect((clouds as HTMLInputElement).value).toBe("1");
    fireEvent.change(servers, { target: { value: "8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.setEnterprise).toHaveBeenCalledWith("org-hopper", {
        enterprise: true,
        servers: 8,
        cloudEnvironments: 1,
      }),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it("starts an Enterprise Organization from its agreement's counts and switches it off", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([WU]);
    api.setEnterprise.mockResolvedValue({
      enterprise: false,
      servers: 0,
      cloudEnvironments: 0,
    });
    renderSection();

    const dialog = await openEnterprise("Wu Contracting");
    expect(
      (within(dialog).getByLabelText("Servers") as HTMLInputElement).value,
    ).toBe("10");
    expect(
      (within(dialog).getByLabelText("Cloud Environments") as HTMLInputElement)
        .value,
    ).toBe("5");

    fireEvent.click(within(dialog).getByRole("switch", { name: /Enterprise/ }));
    expect(within(dialog).queryByLabelText("Servers")).toBeNull();
    // Off is a lapse, and the switch says so before it is saved.
    expect(
      within(dialog).getByText(
        "Switching it off ends the agreement: the Organization is frozen, its owners and admins are emailed, and it is deleted in 30 days unless it pays for a plan.",
      ),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.setEnterprise).toHaveBeenCalledWith("org-wu", {
        enterprise: false,
      }),
    );
  });

  it("asks for whole counts before sending anything", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([WU]);
    renderSection();

    const dialog = await openEnterprise("Wu Contracting");
    fireEvent.change(within(dialog).getByLabelText("Servers"), {
      target: { value: "" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText("A whole number, 0 or more"),
    ).toBeDefined();
    expect(api.setEnterprise).not.toHaveBeenCalled();
  });

  it("says before saving that a free trial refuses Enterprise, and shows the refusal", async () => {
    const endsAt = "2026-12-05T09:00:00.000Z";
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([
      { ...HOPPER, state: { kind: "trial", endsAt } },
    ]);
    api.setEnterprise.mockRejectedValue(
      new ApiError(
        409,
        "Hopper Labs is on a free trial, which charges its card when the trial ends. The trial must end before the Organization can be Enterprise, so it is not billed twice",
      ),
    );
    renderSection();

    const dialog = await openEnterprise("Hopper Labs");
    fireEvent.click(within(dialog).getByRole("switch", { name: /Enterprise/ }));
    expect(
      within(dialog).getByText(
        `Refused while it is on a free trial: the trial charges its card on ${formatDay(endsAt)}, so it must end first, or the Organization would be billed twice.`,
      ),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText(
        /is on a free trial, which charges its card/,
      ),
    ).toBeDefined();
  });

  it("shows the refusal over an active Stripe subscription in the dialog", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([HOPPER]);
    api.setEnterprise.mockRejectedValue(
      new ApiError(
        409,
        "Hopper Labs has an active Stripe subscription, which must end before the Organization can be Enterprise so it is not billed twice",
      ),
    );
    renderSection();

    const dialog = await openEnterprise("Hopper Labs");
    fireEvent.click(within(dialog).getByRole("switch", { name: /Enterprise/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText(/has an active Stripe subscription/),
    ).toBeDefined();
  });
});

/**
 * Paying and Attached Organizations (ADR-0059): the list stays flat; an
 * Attached row reads "Paid by" with its share of the pool, a Paying row the
 * whole pool and how many it pays for, and the Enterprise and suspension
 * boxes name or count the Attached Organizations. Nothing on the page
 * attaches, detaches or re-points one.
 */
describe("OperatorSection: Paying and Attached Organizations", () => {
  const ACME: OperatorOrganization = {
    ...HOPPER,
    id: "org-acme",
    name: "Acme",
    plan: "business",
    state: { kind: "paid" },
    servers: { used: 5, allowed: 10 },
    cloudEnvironments: { used: 3, allowed: 10 },
    attached: [
      { id: "org-turing", name: "Turing Works" },
      { id: "org-babbage", name: "Babbage & Co" },
    ],
  };
  const TURING: OperatorOrganization = {
    ...HOPPER,
    id: "org-turing",
    name: "Turing Works",
    plan: "business",
    state: { kind: "paid" },
    trialUsed: true,
    servers: { used: 2, allowed: 10 },
    cloudEnvironments: { used: 0, allowed: 10 },
    paidBy: { id: "org-acme", name: "Acme" },
  };
  const BABBAGE: OperatorOrganization = {
    ...TURING,
    id: "org-babbage",
    name: "Babbage & Co",
    state: { kind: "suspended" },
    servers: { used: 1, allowed: 10 },
    suspension: {
      reason: "Spam relay",
      suspendedAt: "2026-11-01T09:00:00.000Z",
    },
  };

  async function cellsOf(name: string) {
    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    const row = within(table).getByText(name).closest("tr") as HTMLElement;
    const cells = within(row).getAllByRole("cell");
    return (head: string) =>
      cells[headers.findIndex((text) => text?.startsWith(head))]?.textContent;
  }

  async function open(name: string, button: string) {
    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    const row = within(
      within(table).getByText(name).closest("tr") as HTMLElement,
    );
    fireEvent.click(row.getByRole("button", { name: button }));
    return screen.findByRole("dialog");
  }

  it("keeps the list flat, a Paying row with the whole pool and Attached rows with their share", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([ACME, TURING, BABBAGE]);
    renderSection();

    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    // One row each, none nested under another.
    expect(within(table).getAllByRole("row")).toHaveLength(4);

    const acme = await cellsOf("Acme");
    expect(acme("Plan")).toBe("Business, pays for 2");
    expect(acme("Servers")).toBe("5 of 10");
    expect(acme("Cloud Environments")).toBe("3 of 10");

    const turing = await cellsOf("Turing Works");
    expect(turing("Plan")).toBe("Paid by Acme");
    expect(turing("State")).toBe("Paid");
    expect(turing("Trial used")).toBe("Yes");
    expect(turing("Servers")).toBe("2 of Acme's 10");
    expect(turing("Cloud Environments")).toBe("0 of Acme's 10");

    const babbage = await cellsOf("Babbage & Co");
    expect(babbage("Plan")).toBe("Paid by Acme");
    expect(babbage("State")).toBe("Suspended");
    expect(babbage("Servers")).toBe("1 of Acme's 10");
  });

  it("offers only its own writes on every row: nothing attaches, detaches or re-points", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([ACME, TURING, BABBAGE]);
    renderSection();

    const table = await screen.findByRole("table", {
      name: "Organizations on this instance",
    });
    const names = within(table)
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter(
        (name) =>
          ![
            "Forward abuse report",
            "Enterprise",
            "Suspend",
            "Lift suspension",
          ].includes(name ?? ""),
      );
    // Only the column sort buttons remain.
    for (const name of names) {
      expect(name).not.toMatch(/attach|detach|paid by|pays for|move/i);
    }
  });

  it("names every Attached Organization that freezes when Enterprise is turned off, with the same button", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([
      {
        ...ACME,
        plan: "enterprise",
        enterprise: true,
        servers: { used: 5, allowed: 8 },
      },
    ]);
    api.setEnterprise.mockResolvedValue({
      enterprise: false,
      servers: 0,
      cloudEnvironments: 0,
    });
    renderSection();

    const dialog = await open("Acme", "Enterprise");
    fireEvent.click(within(dialog).getByRole("switch", { name: /Enterprise/ }));
    expect(
      within(dialog).getByText(
        /Its Attached Organizations freeze with it: Turing Works and Babbage & Co\./,
      ),
    ).toBeDefined();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.setEnterprise).toHaveBeenCalledWith("org-acme", {
        enterprise: false,
      }),
    );
  });

  it("measures Enterprise counts against the whole pool", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([{ ...ACME, plan: null }]);
    renderSection();

    const dialog = await open("Acme", "Enterprise");
    fireEvent.click(within(dialog).getByRole("switch", { name: /Enterprise/ }));

    expect(
      (within(dialog).getByLabelText("Servers") as HTMLInputElement).value,
    ).toBe("5");
    expect(
      within(dialog).getByText(
        "It and the 2 Organizations it pays for have 5 together. Fewer refuses only the next one in any of them; nothing stops.",
      ),
    ).toBeDefined();
  });

  it("says suspending a Paying Organization leaves its Attached Organizations running", async () => {
    api.access.mockResolvedValue({ operator: true });
    api.organizations.mockResolvedValue([
      ACME,
      { ...ACME, id: "org-solo", name: "Solo", attached: [] },
      {
        ...ACME,
        id: "org-one",
        name: "One Client",
        attached: [{ id: "org-turing", name: "Turing Works" }],
      },
    ]);
    renderSection();

    let dialog = await open("Acme", "Suspend");
    expect(
      within(dialog).getByText(
        "Its 2 Attached Organizations are not suspended.",
      ),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await open("One Client", "Suspend");
    expect(
      within(dialog).getByText("Its 1 Attached Organization is not suspended."),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await open("Solo", "Suspend");
    expect(within(dialog).queryByText(/Attached Organization/)).toBeNull();
  });
});

describe("useIsOperator", () => {
  function Probe() {
    const { operator, pending } = useIsOperator();
    return (
      <p>{pending ? "pending" : operator ? "operator" : "not an operator"}</p>
    );
  }

  it("answers yes only on the Hosted instance, for a person the backend says is one", async () => {
    api.access.mockResolvedValue({ operator: true });
    render(<Probe />, { wrapper });
    expect(await screen.findByText("operator")).toBeDefined();
    cleanup();

    mode.current = { data: "self-hosted", isPending: false };
    render(<Probe />, { wrapper });
    expect(screen.getByText("not an operator")).toBeDefined();
    expect(api.access).toHaveBeenCalledTimes(1);
  });
});
