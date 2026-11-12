import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuditLogEntry,
  AuditLogFilters,
  AuditLogPage,
} from "@/lib/api/endpoints/audit-logs";

const state = vi.hoisted(() => ({
  page: { logs: [], total: 0, deletedOrganizationEntries: 0 } as AuditLogPage,
  asked: [] as AuditLogFilters[],
}));

vi.mock("./use-audit-logs", () => ({
  useAuditLogs: (filters: AuditLogFilters) => {
    state.asked.push(filters);
    return {
      data: state.page,
      error: null,
      isPending: false,
      isFetching: false,
    };
  },
}));

/**
 * The router moves the real jsdom location and `useSearchParams` reads back
 * from it (the `templates-screen.test.tsx` pattern), so what is asserted is
 * where the screen ended up, not what it asked for.
 */
const LOCATION_CHANGED = "test:locationchange";

function navigate(href: string) {
  window.history.replaceState(null, "", href);
  window.dispatchEvent(new Event(LOCATION_CHANGED));
}

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (onChange: () => void) => {
    window.addEventListener(LOCATION_CHANGED, onChange);
    return () => window.removeEventListener(LOCATION_CHANGED, onChange);
  };
  const search = () => window.location.search;
  return {
    useRouter: () => ({ replace: navigate, push: navigate }),
    usePathname: () => window.location.pathname,
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, search, search)),
  };
});

const { AuditSection } = await import("./audit-section");

const AGENT_ADDRESS = "agt_x7q2@agents.cloudgate.invalid";

function entry(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    auditLogId: "row",
    organizationId: "org-1",
    userId: "user-1",
    userEmail: "grace@example.com",
    userName: "Grace Hopper",
    userRole: "owner",
    action: "deploy",
    outcome: "succeeded",
    resourceType: "application",
    resourceId: "app-1",
    resourceName: "checkout-api",
    metadata: null,
    ip: "203.0.113.7",
    createdAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

const agentRow = entry({
  auditLogId: "agent-row",
  userId: "agt_x7q2",
  userEmail: AGENT_ADDRESS,
  userName: "deploy-bot",
  userRole: "agentOperator",
  action: "read",
  outcome: "refused",
  metadata: JSON.stringify({ reason: "grant" }),
});
const personRow = entry({ auditLogId: "person-row" });
/** A row the platform wrote with no caller: no user, no address. */
const platformRow = entry({
  auditLogId: "platform-row",
  userId: null,
  userEmail: null,
  userName: "Cloudgate",
  userRole: "system",
  action: "delete",
  resourceType: "previewDeployment",
  resourceName: "preview-web-app-x1",
  ip: null,
});

beforeEach(() => {
  navigate("/settings/audit-log");
});

afterEach(() => {
  cleanup();
  state.asked = [];
  state.page = { logs: [], total: 0, deletedOrganizationEntries: 0 };
});

function showing(deletedOrganizationEntries: number | null) {
  state.page = { logs: [], total: 3, deletedOrganizationEntries };
  render(<AuditSection />);
  return document.body.textContent ?? "";
}

function rowOf(text: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => candidate.textContent?.includes(text));
  if (!row) throw new Error(`no row shows ${text}`);
  return row;
}

/** Base UI's trigger opens on `mousedown`, so a bare click is what opens it. */
async function choose(picker: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: picker }));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  const choice = screen.getByRole("option", { name: option });
  fireEvent.pointerDown(choice, { pointerType: "mouse" });
  fireEvent.click(choice, { detail: 1 });
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

/**
 * What the card claims to hold and where the entries of deleted
 * Organizations went.
 */
describe("AuditSection", () => {
  it("says what the trail records, refused and failed Agent calls included", () => {
    const text = showing(0);

    expect(text).not.toContain("Every security-relevant action");
    expect(text).not.toContain("Every successful");
    expect(text).toContain("through the console or the API");
    expect(text).toContain(
      "every call an Agent makes, whether it succeeded, was refused or failed",
    );
    expect(text).toContain(
      "A person's reads, connection tests and refused requests are not recorded.",
    );
  });

  it("counts the entries of deleted Organizations and opens them", () => {
    const text = showing(13);

    expect(text).toContain(
      "13 more entries were recorded in Organizations that have since been deleted",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));

    expect(state.asked.at(-1)).toMatchObject({
      scope: "deleted-organizations",
      offset: 0,
    });
    expect(document.body.textContent).toContain(
      "Entries recorded in Organizations that have since been deleted",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Back to this Organization" }),
    );
    expect(state.asked.at(-1)).toMatchObject({ scope: "organization" });
  });

  it("tells a reader without instance authority who can read them, and no count", () => {
    const text = showing(null);

    expect(text).toContain(
      "only an owner or admin of the instance organization can read them",
    );
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });

  it("says nothing about deleted Organizations when there are none", () => {
    const text = showing(0);

    expect(text).not.toContain("deleted");
  });
});

describe("AuditSection — the Outcome filter", () => {
  it("narrows the trail to each of the three outcomes, and back to any", async () => {
    render(<AuditSection />);
    expect(state.asked.at(-1)?.outcome).toBeUndefined();

    for (const [label, outcome] of [
      ["Refused", "refused"],
      ["Failed", "failed"],
      ["Succeeded", "succeeded"],
    ] as const) {
      await choose("Outcome", label);
      expect(state.asked.at(-1)).toMatchObject({ outcome, offset: 0 });
      expect(new URLSearchParams(window.location.search).get("outcome")).toBe(
        outcome,
      );
    }

    await choose("Outcome", "Any outcome");
    expect(state.asked.at(-1)?.outcome).toBeUndefined();
    expect(window.location.search).toBe("");
  });

  it("clears the outcome with the other filters", async () => {
    navigate("/settings/audit-log?outcome=failed");
    render(<AuditSection />);

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(state.asked.at(-1)?.outcome).toBeUndefined();
    expect(window.location.search).toBe("");
  });
});

describe("AuditSection — the Actor filter", () => {
  it("narrows the trail to the platform's entries with the Actor filter, and back to anyone", async () => {
    render(<AuditSection />);
    expect(state.asked.at(-1)?.actor).toBeUndefined();

    await choose("Actor", "The platform");
    expect(state.asked.at(-1)).toMatchObject({ actor: "platform", offset: 0 });

    await choose("Actor", "Anyone");
    expect(state.asked.at(-1)?.actor).toBeUndefined();
  });
});

describe("AuditSection — filters read from the address", () => {
  it("opens on one actor and one outcome named in the URL, and says so", () => {
    navigate("/settings/audit-log?userId=agt_x7q2&outcome=refused");
    state.page = { logs: [agentRow], total: 1, deletedOrganizationEntries: 0 };
    render(<AuditSection />);

    expect(state.asked.at(-1)).toMatchObject({
      userId: "agt_x7q2",
      outcome: "refused",
    });
    expect(
      screen.getByRole("combobox", { name: "Outcome" }).textContent,
    ).toContain("Refused");
    expect(document.body.textContent).toContain(
      "Showing only the entries of deploy-bot",
    );
  });

  it("drops the actor with Show everyone, keeping the outcome", () => {
    navigate("/settings/audit-log?userId=agt_x7q2&outcome=refused");
    render(<AuditSection />);

    fireEvent.click(screen.getByRole("button", { name: "Show everyone" }));

    expect(state.asked.at(-1)?.userId).toBeUndefined();
    expect(state.asked.at(-1)?.outcome).toBe("refused");
    expect(window.location.search).toBe("?outcome=refused");
  });

  it("ignores an outcome the trail does not write, rather than asking for a 400", () => {
    navigate("/settings/audit-log?outcome=denied");
    render(<AuditSection />);

    expect(state.asked.at(-1)?.outcome).toBeUndefined();
  });

  it("starts a newly addressed question on its first page", () => {
    state.page = { logs: [personRow], total: 60, deletedOrganizationEntries: 0 };
    render(<AuditSection />);
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(state.asked.at(-1)?.offset).toBe(25);

    act(() => navigate("/settings/audit-log?userId=agt_x7q2"));

    expect(state.asked.at(-1)).toMatchObject({ userId: "agt_x7q2", offset: 0 });
  });
});

describe("AuditSection — who acted", () => {
  it("names an Agent with an Agent marker, and a person without one", () => {
    state.page = {
      logs: [agentRow, personRow],
      total: 2,
      deletedOrganizationEntries: 0,
    };
    render(<AuditSection />);

    const agent = rowOf("deploy-bot");
    expect(within(agent).getByText("Agent")).toBeTruthy();
    expect(agent.textContent).toContain("Operator");

    const person = rowOf("grace@example.com");
    expect(within(person).queryByText("Agent")).toBeNull();
    expect(person.textContent).toContain("owner");
  });

  it("never renders an Agent's synthetic address, in the table or its details", () => {
    state.page = {
      logs: [agentRow, entry({ ...agentRow, auditLogId: "nameless", userName: null })],
      total: 2,
      deletedOrganizationEntries: 0,
    };
    render(<AuditSection />);
    expect(document.body.innerHTML).not.toContain("agents.cloudgate.invalid");
    expect(rowOf("Unnamed Agent")).toBeTruthy();

    fireEvent.click(
      within(rowOf("deploy-bot")).getByRole("button", { name: "Details" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("deploy-bot");
    expect(dialog.textContent).toContain("Refused");
    expect(document.body.innerHTML).not.toContain("agents.cloudgate.invalid");
  });

  it("names the platform as Cloudgate with a Platform marker, in the table and its details", () => {
    state.page = { logs: [platformRow], total: 1, deletedOrganizationEntries: 0 };
    render(<AuditSection />);

    const row = rowOf("Cloudgate");
    expect(within(row).getByText("Platform")).toBeTruthy();
    expect(within(row).queryByText("Agent")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Cloudgate");
  });

  it("names a person on a custom role called system by their address, not as the platform", () => {
    // Written before migration 0080 renamed the role: it has a person behind it.
    const legacyRow = entry({
      auditLogId: "legacy-row",
      userEmail: "ada@example.com",
      userName: "Ada",
      userRole: "system",
    });
    state.page = { logs: [legacyRow], total: 1, deletedOrganizationEntries: 0 };
    render(<AuditSection />);

    const row = rowOf("ada@example.com");
    expect(within(row).queryByText("Platform")).toBeNull();
    expect(within(row).queryByText("Cloudgate")).toBeNull();
  });

  it("shows how a person's call ended in its details", () => {
    state.page = { logs: [personRow], total: 1, deletedOrganizationEntries: 0 };
    render(<AuditSection />);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("grace@example.com");
    expect(dialog.textContent).toContain("Succeeded");
    expect(within(dialog).queryByText("Agent")).toBeNull();
  });
});

describe("AuditSection — the filters at phone width", () => {
  it("folds the exact filters behind a Filters button below hd, which says how many are set", async () => {
    navigate("/settings/audit-log?outcome=failed");
    render(<AuditSection />);

    const button = screen.getByRole("button", { name: "Filters (1)" });
    expect(button.className).toMatch(/\bhd:hidden\b/);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    const folded = document.getElementById(button.getAttribute("aria-controls")!)!;
    // `display: contents` at hd and up, so the wide row is exactly as it was.
    expect(folded.className).toMatch(/(^|\s)contents\b/);
    expect(folded.className).toMatch(/\bmax-hd:hidden\b/);
    expect(folded.hasAttribute("data-open")).toBe(false);
    for (const label of ["Actor", "Action", "Kind", "Outcome", "From", "To"]) {
      expect(folded.contains(screen.getByLabelText(label))).toBe(true);
    }
    // The "contains" boxes stay out: they are what someone reaches for first.
    expect(folded.contains(screen.getByLabelText("Filter by who did it"))).toBe(false);

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(folded.hasAttribute("data-open")).toBe(true);
  });
});
