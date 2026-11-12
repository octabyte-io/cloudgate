import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomRole, RoleVocabulary } from "@/lib/api/endpoints/roles";

/** What `useRoleVocabulary` answers this render. Set per case. */
let vocabulary: { data: RoleVocabulary | undefined };

vi.mock("@/lib/api/use-role-vocabulary", () => ({
  useRoleVocabulary: () => vocabulary,
}));

/** The Organization's custom roles and licence this render. Set per case. */
let customRoles: CustomRole[];
let license: { data: { licensed: boolean } | undefined };
const mutateAsync = vi.fn();

vi.mock("./use-members", () => ({
  useInviteMember: () => ({ isPending: false, mutateAsync }),
  useTeams: () => ({ data: [], isPending: false, error: null }),
  useCustomRoles: () => ({ data: customRoles, isPending: false, error: null }),
}));

vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus: () => license,
}));

const { InviteMemberModal } = await import("./invite-member-modal");

/**
 * That the hint under Role describes **the role that is selected**.
 *
 * The third case is the half the fix is actually about: the sentence is a gloss
 * on grants served by the backend, so a vocabulary that no longer supports it
 * has to stop it being said. Without that assertion this file would pass just as
 * well against two literals in a lookup table, which is the arrangement that
 * was deliberately removed.
 */

const OWNER = {
  organization: ["update", "delete"],
  project: ["create", "update", "delete"],
  service: ["read", "update"],
  environment: ["read", "update"],
};

const VOCABULARY: RoleVocabulary = {
  statements: {
    organization: ["update", "delete"],
    project: ["create", "update", "delete"],
    service: ["read", "update"],
    environment: ["read", "update"],
  },
  staticRoles: {
    owner: OWNER,
    admin: { ...OWNER, organization: ["update"] },
    member: {
      project: [],
      service: ["read", "update"],
      environment: ["read", "update"],
    },
  },
  enterpriseOnlyResources: [],
  internalResources: [],
};

const MEMBER_HINT =
  /Member can read and update the Services and Environments they are granted/i;
const ADMIN_HINT = /Admin can do everything except delete this Organization/i;
const POINTER = /lists every permission member holds/i;

/** Base UI's trigger opens on `mousedown`, so a bare click is what opens it. */
async function chooseRole(name: RegExp) {
  fireEvent.click(screen.getByRole("combobox"));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

beforeEach(() => {
  vocabulary = { data: VOCABULARY };
  customRoles = [];
  license = { data: { licensed: true } };
  mutateAsync.mockReset();
});

afterEach(cleanup);

describe("InviteMemberModal", () => {
  it("describes Member, which is the role the dialog opens on", () => {
    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText(MEMBER_HINT)).toBeDefined();
    expect(screen.queryByText(ADMIN_HINT)).toBeNull();
  });

  it("describes Admin once Admin is the role selected", async () => {
    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    await chooseRole(/Admin/);

    expect(screen.getByText(ADMIN_HINT)).toBeDefined();
    expect(screen.queryByText(MEMBER_HINT)).toBeNull();
  });

  it("stops making the claim when the served grants no longer support it", () => {
    vocabulary = {
      data: {
        ...VOCABULARY,
        staticRoles: {
          ...VOCABULARY.staticRoles,
          member: { project: [], service: ["read"], environment: ["read"] },
        },
      },
    };

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(screen.queryByText(MEMBER_HINT)).toBeNull();
    expect(screen.getByText(POINTER)).toBeDefined();
  });

  it("points at the card rather than guessing while the vocabulary is unread", () => {
    vocabulary = { data: undefined };

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText(POINTER)).toBeDefined();
  });
});

/**
 * That a custom role can be given at invitation
 * — the picker
 * used to offer Member and Admin whatever the Organization had defined, so the
 * only way onto a custom role was through Member's grant.
 */
describe("InviteMemberModal custom roles", () => {
  const READ_ONLY: CustomRole = {
    role: "read-only",
    permissions: { certificate: ["read"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    ids: ["role_1"],
    memberCount: 1,
  };
  const LICENCE_SENTENCE = /Custom roles need a license before they can be assigned/;

  async function openPicker() {
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() =>
      expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
    );
    return screen.getAllByRole("option").map((option) => option.textContent);
  }

  it("offers this Organization's custom roles after the built-ins when licensed", async () => {
    customRoles = [READ_ONLY];

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(await openPicker()).toEqual(["Member", "Admin", "read-only1 member"]);
    expect(screen.queryByText(LICENCE_SENTENCE)).toBeNull();
  });

  it("invites on the custom role chosen", async () => {
    customRoles = [READ_ONLY];
    mutateAsync.mockResolvedValue({ id: "inv_1", email: "ida@example.com" });

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ida@example.com" },
    });
    await chooseRole(/read-only/);
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        email: "ida@example.com",
        role: "read-only",
        teamId: undefined,
      }),
    );
  });

  it("withholds them unlicensed, and says why rather than silently", async () => {
    customRoles = [READ_ONLY];
    license = { data: { licensed: false } };

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText(LICENCE_SENTENCE)).toBeDefined();
    expect(await openPicker()).toEqual(["Member", "Admin"]);
  });

  it("says nothing about licenses when there are no custom roles to withhold", () => {
    license = { data: { licensed: false } };

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(screen.queryByText(LICENCE_SENTENCE)).toBeNull();
  });

  it("keeps offering them while the license is unconfirmed", async () => {
    customRoles = [READ_ONLY];
    license = { data: undefined };

    render(<InviteMemberModal open onOpenChange={vi.fn()} />);

    expect(await openPicker()).toEqual(["Member", "Admin", "read-only1 member"]);
  });

  it("leaves Create invitation on and refuses an empty address inline", async () => {
    render(<InviteMemberModal open onOpenChange={() => undefined} />);
    const submit = screen.getByRole("button", { name: "Create invitation" });
    expect(submit.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(submit);
    expect(
      await screen.findByText("Enter the address they will sign in with."),
    ).toBeDefined();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("says a malformed address is one under Email, not in the browser's bubble", async () => {
    render(<InviteMemberModal open onOpenChange={() => undefined} />);
    const box = screen.getByRole("textbox", { name: /^Email/ });
    fireEvent.change(box, { target: { value: "ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(
      await screen.findByText(
        "That is not an email address. It needs an @ and a domain.",
      ),
    ).toBeDefined();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
