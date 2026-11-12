import { useMemo } from "react";
import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import type { FieldSpec } from "@/components/console/form-spec";
import type { SavedProfile, UserProfile } from "@/lib/api/endpoints/users";
import { useInstanceMode } from "@/lib/api/use-instance-mode";

import { useUpdateProfile } from "./use-account";

/**
 * The toast after a save. On the Hosted instance a change of email is only
 * asked for until the link sent to the new address is opened, so it
 * says where that link went rather than that the address changed.
 */
function savedMessage(saved: unknown): string {
  const pending = (saved as SavedProfile | undefined)?.pendingEmail;
  return pending
    ? `Your profile is saved. Open the link we sent to ${pending} to start signing in with it.`
    : "Your profile is saved.";
}

/**
 * Whether `typed` is a different sign-in address from `stored`, the way the
 * backend decides it: after trimming and lower-casing, which is the form
 * better-auth looks an address up by and the form `PATCH /users/me` stores.
 * A change of case alone is not a new address.
 *
 * The raw comparison comes first for a row saved in mixed case by an older
 * version: left untouched, it is not a change, and a name edit must not ask for
 * a password.
 */
function changesEmail(typed: string, stored: string): boolean {
  const trimmed = typed.trim();
  return trimmed !== stored && trimmed.toLowerCase() !== stored;
}

function schemaFor(stored: string) {
  return z
    .object({
      firstName: z.string().min(1, "Your name cannot be empty.").max(255),
      lastName: z.string().max(255),
      email: z.email("That is not an email address.").max(255),
      currentPassword: z.string(),
      image: z.union([z.url("An avatar is a URL to an image."), z.literal("")]),
    })
    .superRefine((values, ctx) => {
      if (changesEmail(values.email, stored) && values.currentPassword === "") {
        ctx.addIssue({
          code: "custom",
          path: ["currentPassword"],
          message: "Enter your current password to change your email.",
        });
      }
    });
}

type Values = z.infer<ReturnType<typeof schemaFor>>;

function fieldsFor(stored: string): FieldSpec<Values>[] {
  return [
    { kind: "text", name: "firstName", label: "Name" },
    {
      kind: "text",
      name: "lastName",
      label: "Last name",
      optional: true,
      // True since every surface that names a person started going
      // through `personName` — the account menu, Members, the member dialogs,
      // team rosters and a role's holders — and `person-name.test.ts` began
      // failing on one that does not.
      hint: "Shown after your name wherever Cloudgate names you.",
    },
    {
      kind: "text",
      name: "email",
      label: "Email",
      hint: "This is what you sign in with. It is saved in lower case, the way sign-in reads it.",
    },
    {
      kind: "password",
      name: "currentPassword",
      label: "Current password",
      autoComplete: "current-password",
      hint: "Changing the address you sign in with needs your password.",
      when: (values) => changesEmail(values.email, stored),
    },
    {
      kind: "text",
      name: "image",
      label: "Avatar",
      optional: true,
      mono: true,
      placeholder: "https://…",
      hint: "The address of an image. Cloudgate has nowhere to upload one to, so the picture has to already live somewhere.",
    },
  ];
}

/**
 * Who you are, as the columns `PATCH /users/me` will take.
 *
 * **The email is the sign-in address and is treated as account security**.
 * Changing it asks for the current password — the field appears only
 * once the address has actually changed — and the backend refuses the change
 * from an API key outright, as it does disabling 2FA. A save that leaves the
 * address alone does not send it, so a name edit never needs the password.
 *
 * **Self-hosted, it is a plain column write, not better-auth's `changeEmail`
 * flow**: the address changes the moment you press Save, with nothing sent to
 * either address, and the password is the re-authentication. **On the Hosted
 * instance** the backend mails a link to the new address and changes it only
 * once that is opened; the save says so, and the footer too.
 * The backend stores it lower-cased — the only form sign-in can find —
 * and the card is keyed on the stored address in `account-section.tsx`, so what
 * it shows after a save is what was stored.
 *
 * **Avatar is a URL, not an upload.** There is no multipart route anywhere in
 * this backend that stores a user image (source archives once had the same
 * absence), so a file picker here would be a control with nowhere to put the
 * file. The hint says where the image has to live instead of pretending.
 */
export function ProfileCard({ profile }: { profile: UserProfile }) {
  const update = useUpdateProfile();
  // The Hosted instance confirms a new address before it applies.
  const hosted = useInstanceMode().data === "hosted";
  const stored = profile.email;
  const schema = useMemo(() => schemaFor(stored), [stored]);
  const fields = useMemo(() => fieldsFor(stored), [stored]);

  return (
    <SettingsCard<Values>
      title="Profile"
      lede="Your name and the address you sign in with."
      schema={schema}
      fields={fields}
      defaultValues={{
        firstName: profile.firstName ?? "",
        lastName: profile.lastName ?? "",
        email: profile.email,
        currentPassword: "",
        image: profile.image ?? "",
      }}
      submit={(values) =>
        update.mutateAsync({
          firstName: values.firstName,
          lastName: values.lastName,
          // Only a changed address is sent, and only it carries the password:
          // the backend asks for one whenever `email` changes the stored row.
          ...(changesEmail(values.email, stored)
            ? { email: values.email, currentPassword: values.currentPassword }
            : {}),
          // An empty box means "no avatar", which is `null` on an update and
          // not `""` — F10's rule, and `updateProfileSchema` types this column
          // `.nullable()` precisely so it can be cleared.
          image: values.image === "" ? null : values.image,
        })
      }
      savedMessage={savedMessage}
      footer={
        hosted ? (
          <p className="text-meta text-tx-2">
            Changing your email needs your current password. We send a link to
            the new address, and you keep signing in with this one until you
            open it.
          </p>
        ) : (
          <p className="text-meta text-tx-2">
            Changing your email needs your current password, and changes what
            you sign in with immediately. Nothing is sent to either address to
            confirm it.
          </p>
        )
      }
    />
  );
}
